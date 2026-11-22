/**
 * The browser-facing JSON API behind the settings page.
 *
 * These routes register through `ctx.connection.fetch`, the harness's
 * authenticated browser-to-Host channel, so the page reaches them on the same
 * origin with the session's own credential and a page in another origin cannot
 * invoke them. Every reply uses one envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message, retryable } }` with HTTP 200, so the
 * panel renders a business failure instead of a transport error.
 */
import { API_PREFIX } from './constants.js'
import { ChatGptError } from './errors.js'

/**
 * One JSON reply.
 * @param {unknown} payload - body.
 * @param {number} [status] - HTTP status.
 * @returns {Response} the response.
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * @param {unknown} value - route value.
 * @returns {Response} a success envelope.
 */
function ok(value) {
  return json({ ok: true, value })
}

/**
 * @param {unknown} error - failure.
 * @returns {Response} a failure envelope carrying the stable code.
 */
function fail(error) {
  const failure = error instanceof ChatGptError
    ? error
    : new ChatGptError('unknown', error instanceof Error ? error.message : String(error))
  return json({
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable === true,
      ...failure.status === undefined ? {} : { status: failure.status },
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
    },
  })
}

/**
 * Run one route body under the failure envelope.
 * @param {() => Promise<unknown>} run - the work.
 * @returns {Promise<Response>} the envelope.
 */
async function settle(run) {
  try {
    return ok(await run())
  } catch (error) {
    return fail(error)
  }
}

/** Read the settings action's optional JSON object, including an empty POST. */
async function actionOptions(request) {
  const body = await request.text()
  if (!body) return {}
  try {
    const options = JSON.parse(body)
    if (options && typeof options === 'object' && !Array.isArray(options)) return options
  } catch {
    // Both malformed JSON and the wrong shape are invalid actions.
  }
  throw new ChatGptError('invalid_request', 'Expected a JSON object for this ChatGPT action.')
}

/**
 * Build every route the settings page calls.
 * @param {object} options - route options.
 * @param {import('./session.js').ChatGptSession} options.session - the connection.
 * @returns {Array<{ path: string, methods: string[], fetch: (request: Request) => Promise<Response> }>} route definitions.
 */
export function createRoutes({ session }) {
  return [
    {
      path: `${API_PREFIX}/state`,
      methods: ['GET'],
      fetch: request => settle(() => session.state({ models: new URL(request.url).searchParams.get('models') !== '0' })),
    },
    {
      path: `${API_PREFIX}/signin`,
      methods: ['POST'],
      fetch: request => settle(async () => {
        const { clientId, newProfile, reconsent } = await actionOptions(request)
        const started = await session.beginSignIn({ clientId, newProfile: newProfile === true, reconsent: reconsent === true })
        return { url: started.url, browserOpened: started.browserOpened }
      }),
    },
    {
      path: `${API_PREFIX}/profiles/select`,
      methods: ['POST'],
      fetch: request => settle(async () => {
        const { clientId } = await actionOptions(request)
        await session.selectProfile(clientId)
        return { activeId: clientId }
      }),
    },
    {
      path: `${API_PREFIX}/welcome`,
      methods: ['POST'],
      fetch: request => settle(async () => {
        const { clientId } = await actionOptions(request)
        await session.acknowledgePlan(clientId)
        return session.state({ models: false })
      }),
    },
    {
      path: `${API_PREFIX}/cancel`,
      methods: ['POST'],
      fetch: async () => settle(async () => ({ cancelled: session.cancelSignIn() })),
    },
    {
      path: `${API_PREFIX}/signout`,
      methods: ['POST'],
      fetch: async () => settle(async () => {
        const outcome = await session.signOut()
        return { ...outcome, state: await session.state() }
      }),
    },
    {
      path: `${API_PREFIX}/refresh`,
      methods: ['POST'],
      fetch: async () => settle(async () => {
        await session.refresh()
        return { state: await session.state() }
      }),
    },
    {
      path: `${API_PREFIX}/models/refresh`,
      methods: ['POST'],
      fetch: async () => settle(async () => {
        const models = await session.listModels({ force: true })
        return {
          models: models.map(model => ({ id: model.id, name: model.name, ...Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {} })),
        }
      }),
    },
  ]
}
