/**
 * A local stand-in for the Sign in with ChatGPT authorization server and the
 * Responses API, so the OAuth flow, the profile store, refresh rotation, the
 * model catalog, and the adapter's stream translation run without real
 * credentials.
 *
 * The endpoints are loopback-only, which is exactly what the bundle's
 * `resolveEndpoints` accepts for a non-official deployment.
 */
import { createServer } from 'node:http'
import { createSign, generateKeyPairSync } from 'node:crypto'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = publicKey.export({ format: 'jwk' })

const PLAN_SCOPES = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'

/**
 * Base64url encode a buffer.
 * @param {Buffer} value - bytes.
 * @returns {string} text.
 */
function b64url(value) {
  return Buffer.from(value).toString('base64url')
}

/**
 * Sign one ID token the way the issuer would.
 * @param {Record<string, unknown>} claims - token claims.
 * @returns {string} compact JWT.
 */
function signIdToken(claims) {
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
  const signature = createSign('sha256').update(signingInput).sign(privateKey)
  return `${signingInput}.${b64url(signature)}`
}

/**
 * Write one SSE event.
 * @param {import('node:http').ServerResponse} response - the stream.
 * @param {Record<string, unknown>} event - event payload.
 * @returns {void}
 */
function send(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Start the stand-in server.
 * @returns {Promise<object>} handle with base URL, scenario control, and recordings.
 */
export async function startFakeOpenAI() {
  const state = {
    mode: 'ok',
    nonce: undefined,
    clientId: 'oaiapp_test',
    subject: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    scopes: PLAN_SCOPES,
    /** Epoch seconds; defaults to just before now so a refresh window is open. */
    earliestRefreshAt: undefined,
    refreshFails: false,
    refreshIdToken: true,
  }
  const recordings = { tokenRequests: [], responses: [], revocations: [], models: 0 }

  /**
   * Build the provider usage the adapter has to normalize.
   *
   * `legacy` reports a cached read only, `writes` reports both buckets the way a
   * model that bills cache writes does, and `uncached` reports no cache detail
   * at all. In every case `input_tokens` folds the cache buckets in, as the
   * Responses API does.
   * @returns {Record<string, unknown>} response.usage
   */
  function usageFor() {
    if (state.usageMode === 'writes') {
      return {
        input_tokens: 12000,
        output_tokens: 500,
        total_tokens: 12500,
        input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
        output_tokens_details: { reasoning_tokens: 100 },
      }
    }
    if (state.usageMode === 'uncached') {
      return { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 }
    }
    return {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 3 },
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const form = new URLSearchParams(raw)
    const json = body => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (url.pathname === '/.well-known/openid-configuration') {
      json({
        issuer: base,
        authorization_endpoint: `${base}/api/accounts/authorize`,
        token_endpoint: `${base}/api/accounts/oauth/token`,
        revocation_endpoint: `${base}/revoke`,
        jwks_uri: `${base}/jwks`,
      })
      return
    }
    if (url.pathname === '/jwks') {
      json({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
      return
    }
    if (url.pathname === '/revoke') {
      recordings.revocations.push(Object.fromEntries(form))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('')
      return
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      const granted = {
        code: form.get('grant_type') === 'authorization_code',
        refresh: form.get('grant_type') === 'refresh_token',
      }
      recordings.tokenRequests.push({ ...Object.fromEntries(form), granted })
      const now = Math.floor(Date.now() / 1000)
      const claims = {
        iss: base,
        aud: state.clientId,
        sub: state.subject,
        email: state.email,
        name: state.name,
        nonce: state.nonce,
        iat: now,
        exp: now + 3600,
      }
      if (granted.code) {
        json({
          access_token: 'at-code',
          refresh_token: 'rt-code',
          id_token: signIdToken(claims),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: state.scopes,
          earliest_refresh_at: state.earliestRefreshAt ?? now - 1,
        })
        return
      }
      if (granted.refresh) {
        if (state.refreshFails) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token revoked' }))
          return
        }
        json({
          access_token: 'at-refreshed',
          refresh_token: 'rt-refreshed',
          ...state.refreshIdToken ? { id_token: signIdToken({ ...claims, exp: now + 3600 }) } : {},
          token_type: 'Bearer',
          expires_in: 3600,
          scope: state.scopes,
        })
        return
      }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unsupported_grant_type' }))
      return
    }
    if (url.pathname === '/v1/models') {
      recordings.models += 1
      const token = request.headers.authorization
      if (token !== 'Bearer at-code' && token !== 'Bearer at-refreshed') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad token' } }))
        return
      }
      json({
        models: [
          { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list', context_window: 272000, reasoning_efforts: ['low', 'high'] },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
        ],
      })
      return
    }
    if (url.pathname === '/v1/responses' && request.method === 'POST') {
      const body = JSON.parse(raw === '' ? '{}' : raw)
      recordings.responses.push({ body, headers: request.headers })
      if (state.mode === 'quota') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.', type: 'invalid_request_error' } }))
        return
      }
      if (state.mode === 'ineligible') {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'Not eligible.' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-test' })
      send(response, { type: 'response.created', response: { id: 'resp-1' } })
      if (state.mode === 'fail') {
        send(response, { type: 'response.failed', response: { error: { code: 'subscription_sharing_unsupported_capability', message: 'Unsupported input.', param: 'tools' } } })
        response.end()
        return
      }
      send(response, { type: 'response.output_item.added', output_index: 0, item: { id: 'msg-1', type: 'message', role: 'assistant' } })
      send(response, { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'Hello' })
      send(response, { type: 'response.output_text.delta', item_id: 'msg-1', delta: ' world' })
      if (state.mode === 'unclosed') {
        send(response, { type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [{ type: 'message' }] } })
        response.end()
        return
      }
      if (state.mode === 'tool') {
        send(response, {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] },
        })
        send(response, { type: 'response.output_item.added', output_index: 1, item: { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read', arguments: '' } })
        send(response, { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: '{"path"' })
        send(response, { type: 'response.function_call_arguments.delta', item_id: 'fc-1', delta: ':"a.txt"}' })
        send(response, {
          type: 'response.output_item.done',
          output_index: 1,
          item: { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
        })
        send(response, {
          type: 'response.completed',
          response: {
            id: 'resp-1',
            status: 'completed',
            output: [{ type: 'function_call', call_id: 'call-1' }],
            usage: usageFor(),
          },
        })
        response.end()
        return
      }
      if (state.mode === 'reasoning') {
        send(response, { type: 'response.output_item.added', output_index: 1, item: { id: 'rs-1', type: 'reasoning' } })
        send(response, { type: 'response.reasoning_summary_text.delta', item_id: 'rs-1', delta: 'Thinking…' })
        send(response, { type: 'response.output_item.done', output_index: 1, item: { id: 'rs-1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking…' }] } })
      }
      send(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] },
      })
      if (state.mode === 'incomplete') {
        send(response, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
        response.end()
        return
      }
      send(response, {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          status: 'completed',
          output: [{ type: 'message' }],
          usage: usageFor(),
        },
      })
      response.end()
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ detail: `no route ${url.pathname}` }))
  })

  await new Promise(resolve => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  return {
    base,
    state,
    recordings,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

