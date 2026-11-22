/**
 * ID-token verification against the issuer's published JWKS.
 *
 * The flow is a public OAuth client, so the ID token is the only proof of who
 * signed in. Verification is therefore mandatory and is pinned to the issuer
 * this deployment configured: the discovery document may not move the JWKS or
 * the issuer somewhere else.
 */
import { ChatGptError, CODES } from './errors.js'

const CLOCK_TOLERANCE_SECONDS = 5
const JWKS_TTL_MS = 10 * 60 * 1000
const keyCache = new Map()

/**
 * Decode one base64url segment.
 * @param {string} value - base64url text.
 * @returns {Buffer} decoded bytes.
 */
function decode(value) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

/**
 * Parse a JWT without trusting it.
 * @param {string} token - compact serialization.
 * @returns {{ header: Record<string, unknown>, payload: Record<string, unknown>, signingInput: string, signature: Uint8Array } | undefined} parts, or undefined when malformed.
 */
function parse(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const header = JSON.parse(decode(parts[0]).toString('utf8'))
    const payload = JSON.parse(decode(parts[1]).toString('utf8'))
    if (header === null || typeof header !== 'object' || payload === null || typeof payload !== 'object') return undefined
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: decode(parts[2]) }
  } catch {
    return undefined
  }
}

/**
 * Fetch and cache one issuer's key set.
 * @param {string} uri - JWKS location.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{ keys: Array<Record<string, unknown>> }>} the key set.
 */
async function keySet(uri, signal) {
  const cached = keyCache.get(uri)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
  let response
  try {
    response = await fetch(uri, { headers: { accept: 'application/json' }, ...signal === undefined ? {} : { signal } })
  } catch (error) {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'ChatGPT identity verification is temporarily unavailable. Try again shortly.', { retryable: true, cause: error })
  }
  if (response.status !== 200) {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'ChatGPT identity verification is temporarily unavailable. Try again shortly.', { retryable: true, status: response.status })
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'ChatGPT identity verification is temporarily unavailable. Try again shortly.', { retryable: true })
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.keys)) {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'ChatGPT identity verification is temporarily unavailable. Try again shortly.', { retryable: true })
  }
  keyCache.set(uri, { value: body, expiresAt: Date.now() + JWKS_TTL_MS })
  return body
}

/**
 * Verify one ID token and return the account identity it proves.
 *
 * @param {object} request - verification request.
 * @param {string} request.idToken - compact JWT.
 * @param {string} request.issuer - expected issuer, pinned by configuration.
 * @param {string} request.clientId - issued client id the audience must name.
 * @param {string} [request.nonce] - nonce sent with the authorization request.
 * @param {string} request.jwksUri - key set location from discovery.
 * @param {number} [request.receivedAt] - trusted receive time for a checkpointed token.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<{ subject: string, name?: string, email?: string, payload: Record<string, unknown> }>} verified identity.
 */
export async function verifyIdToken({ idToken, issuer, clientId, nonce, jwksUri, receivedAt, signal }) {
  const token = parse(idToken)
  if (token === undefined) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  if (token.header.alg !== 'RS256') {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  const keys = await keySet(jwksUri, signal)
  const kid = typeof token.header.kid === 'string' ? token.header.kid : undefined
  const candidates = keys.keys.filter(key => key !== null && typeof key === 'object'
    && (kid === undefined || key.kid === kid)
    && (key.kty === 'RSA'))
  if (candidates.length === 0) {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'ChatGPT identity verification is temporarily unavailable. Try again shortly.', { retryable: true })
  }
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    throw new ChatGptError(CODES.identity_verification_unavailable, 'This runtime cannot verify ChatGPT identities.', { retryable: false })
  }
  let verified = false
  for (const jwk of candidates) {
    try {
      const key = await subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      verified = await subtle.verify('RSASSA-PKCS1-v1_5', key, token.signature, new TextEncoder().encode(token.signingInput))
    } catch {
      verified = false
    }
    if (verified) break
  }
  if (!verified) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }

  const payload = token.payload
  const now = Math.floor((receivedAt ?? Date.now()) / 1000)
  const expires = typeof payload.exp === 'number' ? payload.exp : undefined
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : undefined
  if (payload.iss !== issuer || expires === undefined || expires + CLOCK_TOLERANCE_SECONDS < now) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  if (issuedAt === undefined || issuedAt - CLOCK_TOLERANCE_SECONDS * 4 > now) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  const audience = payload.aud
  const audienceMatches = typeof audience === 'string'
    ? audience === clientId
    : Array.isArray(audience) && audience.includes(clientId)
  if (!audienceMatches) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  if (Array.isArray(audience) && audience.length > 1 && payload.azp !== clientId) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  if (nonce !== undefined && payload.nonce !== nonce) {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new ChatGptError(CODES.invalid_id_token, 'The ChatGPT identity could not be verified. Please sign in again.')
  }
  return {
    subject: payload.sub,
    payload,
    ...typeof payload.name === 'string' && payload.name !== '' ? { name: payload.name } : {},
    ...typeof payload.email === 'string' && payload.email !== '' ? { email: payload.email } : {},
  }
}

/** Drop the cached key sets; used by tests and by a sign-out that follows a key rotation. */
export function forgetKeySets() {
  keyCache.clear()
}
