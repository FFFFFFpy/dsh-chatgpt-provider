/**
 * The Sign in with ChatGPT (SIWC) OAuth client for open-source, locally hosted
 * apps: dynamic client registration, PKCE over a loopback callback, token
 * exchange and refresh, ID-token verification, and session revocation.
 *
 * Everything here follows the documented open-source flow
 * (https://developers.openai.com/siwc/token-sharing-open-source): a public
 * client that registers with `client_id=dynamic_agent_client`, persists the
 * issued client id, and sends its stable `ext_agent_host_id` on every
 * authorization request.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { CALLBACK_PATH, DYNAMIC_CLIENT_ID, ISSUER, PLAN_SCOPE, RESOURCE, SCOPES } from './constants.js'
import { ChatGptError, CODES, apiError, errorShape } from './errors.js'
import { verifyIdToken } from './jwt.js'

/** Production grants and local development grants belong to separate deployments. */
export function resolveEndpoints(authBaseURL = ISSUER, apiBaseURL = RESOURCE) {
  const roots = [authBaseURL, apiBaseURL].map((value, index) => {
    const label = index === 0 ? 'authBaseURL' : 'apiBaseURL'
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new ChatGptError(CODES.configuration, label + ' must be an absolute http(s) URL.')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new ChatGptError(CODES.configuration, label + ' must be an HTTP(S) endpoint without credentials, a query or a fragment.')
    }
    return parsed
  })
  const [issuer, resource] = roots.map(url => url.href.replace(/\/+$/, ''))
  const official = issuer === ISSUER && resource === RESOURCE
  if (!official && !roots.every(url => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new ChatGptError(CODES.configuration, 'Use the official OpenAI endpoints or a pair of local loopback endpoints.')
  }
  return { authBaseURL: issuer, apiBaseURL: resource }
}

/** Fresh random base64url value for one attempt's state, nonce, or PKCE verifier. */
const randomValue = () => randomBytes(32).toString('base64url')

/** Upper bound on a token-endpoint reply, so a stuck socket cannot hold a request open. */
const TOKEN_TIMEOUT_MS = 30_000

/**
 * Fetch with a classified transport failure and a hard timeout.
 * @param {string} url - absolute URL.
 * @param {RequestInit} init - fetch options.
 * @param {number} [timeoutMs] - deadline for the whole exchange.
 * @returns {Promise<Response>} the response.
 */
async function fetchRemote(url, init, timeoutMs = TOKEN_TIMEOUT_MS) {
  const signal = init.signal === undefined || init.signal === null
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
  try {
    return await fetch(url, { ...init, redirect: 'error', signal })
  } catch (error) {
    if (init.signal?.aborted === true) throw error
    throw new ChatGptError(CODES.network_error, 'Could not reach ChatGPT. Check your connection and try again.', { retryable: true, cause: error })
  }
}

/**
 * Read a JSON body without trusting its shape.
 * @param {Response} response - reply.
 * @returns {Promise<unknown>} parsed body, or raw text when malformed.
 */
async function jsonBody(response) {
  const text = await response.text().catch(() => '')
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return text.slice(0, 400)
  }
}

/** The officially documented trailing message the callback page shows. */
const CALLBACK_SCRIPT = 'history.replaceState(null, "", "/auth/complete");'

/**
 * Open the system browser at one URL.
 * @param {string} url - authorization URL.
 * @param {string} [command] - explicit launcher command from configuration.
 * @returns {Promise<boolean>} whether a launcher process started successfully.
 */
export async function openSystemBrowser(url, command) {
  const custom = typeof command === 'string' && command.trim() !== '' ? command.trim() : undefined
  const platform = process.platform
  const executable = custom ?? (platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open')
  const args = custom !== undefined
    ? [url]
    : platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  return await new Promise(resolve => {
    let child
    try {
      child = spawn(executable, args, { stdio: 'ignore', shell: false, detached: true })
    } catch {
      resolve(false)
      return
    }
    const settle = value => {
      clearTimeout(timer)
      child.removeAllListeners()
      resolve(value)
    }
    const timer = setTimeout(() => {
      // A launcher that never exits (some Linux handlers) still opened the URL.
      try {
        child.unref()
      } catch {
        /* ignore */
      }
      settle(true)
    }, 3_000)
    child.once('error', () => settle(false))
    child.once('exit', code => settle(code === 0 || code === null))
  })
}

/**
 * Start the loopback listener that receives the authorization callback.
 *
 * The listener exists only for this attempt: it validates `state` before
 * anything else, answers unrelated probes with a 400 without consuming the
 * attempt, and closes as soon as the attempt settles.
 *
 * @param {object} request - listener request.
 * @param {number} request.port - fixed port, or 0 for an ephemeral one.
 * @param {string} request.state - the attempt's state value.
 * @param {string | undefined} request.savedClientId - registration being reauthorized.
 * @param {AbortSignal} request.signal - attempt cancellation.
 * @returns {Promise<{ result: Promise<{ code: string, clientId: string }>, redirectUri: string, close: () => void }>} the listener.
 */
export async function listenForCallback({ port, state, savedClientId, signal }) {
  let complete
  let fail
  let settled = false
  const result = new Promise((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  void result.catch(() => undefined)
  let selectedPort = port
  const finish = value => {
    if (settled) return
    settled = true
    if (value instanceof ChatGptError) fail(value)
    else complete(value)
  }
  const scriptHash = createHash('sha256').update(CALLBACK_SCRIPT).digest('base64')
  const handler = (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`)
    let url
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${selectedPort}`)
    } catch {
      response.writeHead(400).end('Invalid request')
      return
    }
    const authority = `127.0.0.1:${selectedPort}`
    if (request.method !== 'GET' || request.headers.host !== authority || url.pathname !== CALLBACK_PATH || settled) {
      response.writeHead(404).end('Not found')
      return
    }
    const returned = Buffer.from(url.searchParams.get('state') ?? '')
    const expected = Buffer.from(state)
    if (url.searchParams.getAll('state').length !== 1 || returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
      response.writeHead(400).end('Invalid sign-in state. Return to the browser tab that started sign-in.')
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Return to DeepSeek Harness</title><style>body{font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px;color:#202123}h1{font-size:24px}</style><h1>Return to DeepSeek Harness</h1><p>The app will finish checking your ChatGPT connection. You can close this tab.</p><script>${CALLBACK_SCRIPT}</script></html>`)
    if (url.searchParams.has('error')) {
      const description = url.searchParams.get('error_description')
      finish(new ChatGptError(
        url.searchParams.get('error') ?? 'access_denied',
        description ?? 'Sign-in was not completed in the browser.',
        { status: 400 },
      ))
      return
    }
    const code = url.searchParams.get('code')
    const returnedClientId = url.searchParams.get('client_id')
    const clientId = returnedClientId ?? savedClientId
    if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1
      || !clientId || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) || clientId === DYNAMIC_CLIENT_ID
      || (savedClientId !== undefined && returnedClientId !== null && savedClientId !== returnedClientId)) {
      finish(new ChatGptError(CODES.registration_incomplete, 'ChatGPT did not complete app registration. Please try signing in again.'))
      return
    }
    finish({ code, clientId })
  }

  const server = createServer(handler)
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  const close = () => {
    signal.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections?.()
  }
  const abort = () => {
    finish(new ChatGptError(CODES.cancelled, 'Sign-in was cancelled.'))
    close()
  }
  try {
    await new Promise((resolve, reject) => {
      const onError = error => reject(error)
      server.once('error', onError)
      server.listen({ port: selectedPort, host: '127.0.0.1' }, () => {
        server.removeListener('error', onError)
        server.on('error', () => finish(new ChatGptError(CODES.callback_failed, 'The local sign-in listener stopped. Please try again.')))
        const address = server.address()
        if (address !== null && typeof address === 'object') selectedPort = address.port
        resolve()
      })
    })
  } catch (error) {
    close()
    throw new ChatGptError(CODES.callback_port_unavailable, `The sign-in port ${port === 0 ? '(automatic)' : port} is unavailable. Close another copy of the app or set a different redirect port.`, { cause: error })
  }
  if (signal.aborted) {
    close()
    throw new ChatGptError(CODES.cancelled, 'Sign-in was cancelled.')
  }
  signal.addEventListener('abort', abort, { once: true })
  return { result, close, redirectUri: `http://127.0.0.1:${selectedPort}${CALLBACK_PATH}` }
}

/**
 * The OAuth client for one deployment.
 */
export class ChatGPTAuth {
  /**
   * @param {object} options - deployment facts.
   * @param {string} options.authBaseURL - authorization server origin.
   * @param {string} options.apiBaseURL - resource audience (API root).
   * @param {number} options.redirectPort - loopback port, or 0 for automatic.
   * @param {string} options.appName - `agent_name_hint` for a first registration.
   * @param {boolean} options.sendHostId - include `ext_agent_host_id`.
   * @param {string} [options.browserCommand] - explicit browser launcher.
   * @param {(url: string) => Promise<boolean> | boolean} [options.openBrowser] - browser opener; tests replace it.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger] - safe diagnostics.
   */
  constructor({ authBaseURL, apiBaseURL, redirectPort, appName, sendHostId, browserCommand, openBrowser, logger }) {
    Object.assign(this, resolveEndpoints(authBaseURL, apiBaseURL))
    this.redirectPort = redirectPort
    this.appName = appName
    this.sendHostId = this.authBaseURL === ISSUER || sendHostId !== false
    this.browserCommand = browserCommand
    this.openBrowser = openBrowser ?? (url => openSystemBrowser(url, browserCommand))
    this.logger = logger
    this.discoveryPromise = undefined
  }

  /**
   * Read and validate the issuer's discovery document; the issuer and every
   * endpoint must stay on the configured origin.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ issuer: string, authorization_endpoint: string, token_endpoint: string, jwks_uri: string, revocation_endpoint?: string }>} the document.
   */
  async discovery(signal) {
    this.discoveryPromise ??= (async () => {
      const response = await fetchRemote(`${this.authBaseURL}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, 15_000)
      const body = await jsonBody(response)
      const issuer = body !== null && typeof body === 'object' ? body.issuer : undefined
      if (!response.ok || issuer !== this.authBaseURL) {
        throw new ChatGptError(CODES.discovery_failed, 'ChatGPT sign-in configuration could not be verified.', { retryable: true, status: response.status })
      }
      const origin = new URL(this.authBaseURL).origin
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        const value = body[key]
        if (typeof value !== 'string' || new URL(value).origin !== origin) {
          throw new ChatGptError(CODES.discovery_failed, 'ChatGPT sign-in configuration could not be verified.', { retryable: true })
        }
      }
      if (body.revocation_endpoint !== undefined && (typeof body.revocation_endpoint !== 'string' || new URL(body.revocation_endpoint).origin !== origin)) {
        throw new ChatGptError(CODES.discovery_failed, 'ChatGPT sign-in configuration could not be verified.', { retryable: true })
      }
      return body
    })().catch(error => {
      this.discoveryPromise = undefined
      throw error
    })
    const document = await this.discoveryPromise
    signal?.throwIfAborted()
    return document
  }

  /**
   * Start one authorization attempt.
   *
   * Returns as soon as the callback listener is bound and the browser has been
   * opened (or should be opened by the caller), with a `completion` promise
   * that settles when the human finishes in the browser.
   *
   * @param {object} request - attempt request.
   * @param {Record<string, unknown> | undefined} request.previous - stored connection to reauthorize.
   * @param {string} request.hostId - stable `ext_agent_host_id`.
   * @param {AbortSignal} request.signal - attempt cancellation.
   * @param {(clientId: string) => Promise<void>} [request.onRegistration] - persist an issued registration before the code exchange.
   * @param {boolean} [request.reconsent] - force the consent screen.
   * @returns {Promise<{ url: string, redirectUri: string, browserOpened: boolean, completion: Promise<Record<string, unknown>>, close: () => void }>} the attempt.
   */
  async beginAuthorization({ previous, hostId, signal, onRegistration, reconsent = false }) {
    const provider = await this.discovery(signal)
    signal.throwIfAborted()
    const state = randomValue()
    const nonce = randomValue()
    const verifier = randomValue()
    const listener = await listenForCallback({
      port: this.redirectPort,
      state,
      savedClientId: previous?.clientId,
      signal,
    })

    const authorization = new URL(provider.authorization_endpoint)
    const params = new URLSearchParams({
      client_id: previous?.clientId ?? DYNAMIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: listener.redirectUri,
      scope: SCOPES,
      resource: this.apiBaseURL,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    })
    if (this.sendHostId) params.set('ext_agent_host_id', hostId)
    if (previous?.clientId === undefined) params.set('agent_name_hint', this.appName)
    // The same URL is exposed for manual sign-in. Bind the profile by verified subject on return.
    if (typeof previous?.email === 'string' && previous.email !== '') params.set('login_hint', previous.email)
    if (reconsent) params.set('prompt', 'consent')
    authorization.search = params.toString()

    const url = authorization.toString()
    const browserOpened = await this.openBrowser(url)
    this.logger?.debug?.('chatgpt: authorization started, browser=%s', browserOpened)

    const completion = (async () => {
      try {
        const callback = await listener.result
        await onRegistration?.(callback.clientId)
        return await this.exchangeCode({
          code: callback.code,
          clientId: callback.clientId,
          verifier,
          redirectUri: listener.redirectUri,
          nonce,
          subject: typeof previous?.subject === 'string' ? previous.subject : undefined,
          hostId,
          clientIdChanged: previous?.clientId !== undefined && previous.clientId !== callback.clientId,
          signal,
        })
      } finally {
        listener.close()
      }
    })()
    void completion.catch(() => undefined)
    return { url, redirectUri: listener.redirectUri, browserOpened, completion, close: listener.close }
  }

  /**
   * Exchange an authorization code for the grant, verify the identity, and
   * return the connection record to persist.
   * @param {object} request - exchange request.
   * @returns {Promise<Record<string, unknown>>} the stored connection shape.
   */
  async exchangeCode({ code, clientId, verifier, redirectUri, nonce, subject, hostId, clientIdChanged, signal }) {
    const provider = await this.discovery(signal)
    const response = await fetchRemote(provider.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: this.apiBaseURL,
      }),
      signal,
    })
    const data = await jsonBody(response)
    if (!response.ok) throw apiError(data, response.status, response.headers.get('x-request-id'))
    if (data === null || typeof data !== 'object') {
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT returned an invalid token response. Please sign in again.')
    }
    if (typeof data.id_token !== 'string' || data.id_token === '') {
      throw new ChatGptError(CODES.invalid_id_token, 'ChatGPT did not return a verifiable identity. Please sign in again.')
    }
    const identity = await verifyIdToken({
      idToken: data.id_token,
      issuer: this.authBaseURL,
      clientId,
      nonce,
      jwksUri: provider.jwks_uri,
      signal,
    })
    if (clientIdChanged) {
      throw new ChatGptError(CODES.account_mismatch, 'This sign-in returned a different app registration. Sign in again to repair it.')
    }
    if (subject !== undefined && identity.subject !== subject) {
      throw new ChatGptError(CODES.account_mismatch, 'This sign-in returned a different ChatGPT account. Sign in with the original account.')
    }
    const fields = this.tokenFields(data)
    return {
      extAgentHostId: hostId,
      clientId,
      subject: identity.subject,
      ...identity.name === undefined ? {} : { name: identity.name },
      ...identity.email === undefined ? {} : { email: identity.email },
      idToken: data.id_token,
      ...fields,
      status: 'connected',
      savedAt: new Date().toISOString(),
    }
  }

  /**
   * Normalize a token response.
   * @param {Record<string, unknown>} data - token endpoint body.
   * @param {{ requireRefresh?: boolean }} [options] - whether a refresh token is mandatory.
   * @returns {{ scopes: string[], accessToken?: string, refreshToken?: string, expiresAt?: number, earliestRefreshAt?: string | number }} normalized fields.
   */
  tokenFields(data, { requireRefresh = false } = {}) {
    const scope = typeof data.scope === 'string' ? data.scope : undefined
    if (scope === undefined) {
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT did not confirm the granted permissions. Please sign in again.')
    }
    const scopes = scope.split(/\s+/).filter(Boolean)
    const accessToken = data.access_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      if (!requireRefresh && !scopes.includes('offline_access') && !scopes.includes(PLAN_SCOPE)) return { scopes }
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT did not return the requested credentials. Please sign in again.')
    }
    const tokenType = typeof data.token_type === 'string' ? data.token_type.toLowerCase() : ''
    const expiresIn = data.expires_in
    if (tokenType !== 'bearer' || typeof expiresIn !== 'number' || !Number.isFinite(Date.now() + expiresIn * 1000) || expiresIn <= 0) {
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT returned incomplete credentials. Please sign in again.')
    }
    const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token !== '' ? data.refresh_token : undefined
    if ((requireRefresh || scopes.includes('offline_access')) && refreshToken === undefined) {
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT returned incomplete credentials. Please sign in again.')
    }
    const earliest = data.earliest_refresh_at
    return {
      scopes,
      accessToken,
      ...refreshToken === undefined ? {} : { refreshToken },
      expiresAt: Date.now() + expiresIn * 1000,
      ...typeof earliest === 'string' || typeof earliest === 'number' ? { earliestRefreshAt: earliest } : {},
    }
  }

  /**
   * Refresh one stored grant.
   * @param {object} request - refresh request.
   * @param {Record<string, unknown>} request.connection - stored connection; never mutated.
   * @param {AbortSignal} request.signal - caller cancellation.
   * @returns {Promise<Record<string, unknown>>} replacement fields, to checkpoint before verifying a returned ID token.
   */
  async refresh({ connection, signal }) {
    const provider = await this.discovery(signal)
    const refreshToken = connection.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new ChatGptError('invalid_grant', 'Your ChatGPT connection has expired. Sign in again.')
    }
    const response = await fetchRemote(provider.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: String(connection.clientId),
        refresh_token: refreshToken,
        resource: this.apiBaseURL,
      }),
      signal,
    })
    const data = await jsonBody(response)
    if (!response.ok) throw apiError(data, response.status, response.headers.get('x-request-id'))
    if (data === null || typeof data !== 'object') {
      throw new ChatGptError(CODES.invalid_token_response, 'ChatGPT returned an invalid token response. Please sign in again.')
    }
    const fields = this.tokenFields({
      ...data,
      scope: data.scope === undefined ? connection.scopes.join(' ') : data.scope,
    }, { requireRefresh: true })
    if (data.id_token !== undefined && (typeof data.id_token !== 'string' || !data.id_token)) {
      throw new ChatGptError(CODES.invalid_id_token, 'ChatGPT returned an invalid refreshed identity.')
    }
    return { ...fields, ...(data.id_token ? { idToken: data.id_token } : {}), receivedAt: Date.now() }
  }

  async verifyRotation(connection, rotation, signal) {
    const provider = await this.discovery(signal)
    const identity = await verifyIdToken({
      idToken: rotation.idToken,
      issuer: this.authBaseURL,
      clientId: connection.clientId,
      jwksUri: provider.jwks_uri,
      receivedAt: rotation.receivedAt,
      signal,
    })
    if (identity.subject !== connection.subject) {
      throw new ChatGptError(CODES.account_mismatch, 'The refreshed ChatGPT identity does not match this profile. Sign in again.')
    }
    return {
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.email ? { email: identity.email } : {}),
    }
  }

  /**
   * Revoke the renewable session so the grant cannot be refreshed again.
   * @param {object} request - revocation request.
   * @param {Record<string, unknown>} request.connection - stored connection.
   * @param {AbortSignal} [request.signal] - caller cancellation.
   * @returns {Promise<'revoked' | 'unconfirmed' | 'no-session'>} the revocation outcome.
   */
  async revoke({ connection, signal }) {
    const token = connection.pendingRefresh?.refreshToken ?? connection.refreshToken
    if (typeof token !== 'string' || token === '') return connection.accessToken ? 'unconfirmed' : 'no-session'
    let provider
    try {
      provider = await this.discovery(signal)
    } catch {
      return 'unconfirmed'
    }
    if (typeof provider.revocation_endpoint !== 'string') return 'unconfirmed'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let retryable = false
      try {
        const response = await fetchRemote(provider.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: String(connection.clientId) }),
        }, 10_000)
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 200) return 'revoked'
        retryable = response.status >= 500
      } catch (error) {
        retryable = error instanceof ChatGptError && error.code === CODES.network_error
      }
      if (!retryable || attempt === 1) break
      await delay(300)
    }
    return 'unconfirmed'
  }

  /**
   * Whether a token response proves ChatGPT plan usage was granted.
   * @param {readonly string[]} scopes - granted scopes.
   * @returns {boolean} true when the plan permission is present.
   */
  static planUsageGranted(scopes) {
    return Array.isArray(scopes) && scopes.includes(PLAN_SCOPE)
  }

  /**
   * The resource audience new authorizations request.
   * @returns {string} audience URL.
   */
  static get resource() {
    return RESOURCE
  }

  /**
   * One-line explanation for a body that names nothing useful.
   * @param {unknown} body - provider body.
   * @returns {string} diagnostic text.
   */
  static describe(body) {
    return errorShape(body).message
  }
}
