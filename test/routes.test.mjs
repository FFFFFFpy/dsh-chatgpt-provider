/**
 * Route and configuration checks that need no network: the browser-facing
 * envelope the settings page parses, the action payloads it sends, and the row
 * configuration normalizer.
 */
import assert from 'node:assert/strict'
import { createRoutes } from '../src/routes.js'
import { ChatGptError } from '../src/errors.js'
import { ISSUER, RESOURCE } from '../src/constants.js'
import { resolveConfig } from '../index.js'

let failures = 0
let passes = 0

/**
 * Run one named check.
 * @param {string} name - check name.
 * @param {() => Promise<void> | void} work - the check.
 * @returns {Promise<void>}
 */
async function test(name, work) {
  try {
    await work()
    passes += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}`)
    console.log(error instanceof Error ? error.stack : error)
  }
}

/**
 * Find one route by suffix.
 * @param {Array<{ path: string, fetch: Function }>} routes - route table.
 * @param {string} suffix - path suffix.
 * @returns {{ path: string, fetch: Function }} the route.
 */
function route(routes, suffix) {
  const found = routes.find(entry => entry.path.endsWith(suffix))
  assert.ok(found !== undefined, `route ${suffix} is missing`)
  return found
}

/**
 * Build one POST to a route.
 * @param {string} path - suffix used only for documentation.
 * @param {unknown} [body] - JSON body; omitted means an empty POST.
 * @returns {Request} the request.
 */
function post(path, body) {
  return new Request(`http://127.0.0.1:20086/api/chatgpt-provider${path}`, {
    method: 'POST',
    ...body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) },
  })
}

const calls = []
const state = { status: 'signed-out', signedIn: false, account: null, plan: null, profiles: [] }
const session = {
  async state(options = {}) {
    calls.push(['state', options])
    return state
  },
  async beginSignIn(options = {}) {
    calls.push(['signin', options])
    return { url: 'https://auth.example/authorize?state=1', browserOpened: true, done: Promise.resolve({ ok: true }) }
  },
  async selectProfile(clientId) {
    calls.push(['select', clientId])
  },
  async acknowledgePlan(clientId) {
    calls.push(['welcome', clientId])
  },
  cancelSignIn() {
    calls.push(['cancel'])
    return true
  },
  async signOut() {
    calls.push(['signout'])
    return { revoked: 'revoked' }
  },
  async refresh() {
    calls.push(['refresh'])
    return {}
  },
  async listModels({ force } = {}) {
    calls.push(['models', force])
    return [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 272000 }]
  },
}

const routes = createRoutes({ session })

await test('every route answers with the JSON envelope the page parses', async () => {
  const reply = await route(routes, '/state').fetch(new Request('http://127.0.0.1:20086/api/chatgpt-provider/state'))
  assert.equal(reply.status, 200)
  assert.equal(reply.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(reply.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await reply.json(), { ok: true, value: state })
})

await test('the state route honors ?models=0', async () => {
  await route(routes, '/state').fetch(new Request('http://127.0.0.1:20086/api/chatgpt-provider/state?models=0'))
  assert.deepEqual(calls.at(-1), ['state', { models: false }])
  await route(routes, '/state').fetch(new Request('http://127.0.0.1:20086/api/chatgpt-provider/state'))
  assert.deepEqual(calls.at(-1), ['state', { models: true }])
})

await test('sign-in forwards the action options and defaults them off', async () => {
  const body = await (await route(routes, '/signin').fetch(post('/signin', { clientId: 'oaiapp_x', newProfile: true, reconsent: true }))).json()
  assert.deepEqual(body, { ok: true, value: { url: 'https://auth.example/authorize?state=1', browserOpened: true } })
  assert.deepEqual(calls.at(-1), ['signin', { clientId: 'oaiapp_x', newProfile: true, reconsent: true }])
  await route(routes, '/signin').fetch(post('/signin'))
  assert.deepEqual(calls.at(-1), ['signin', { clientId: undefined, newProfile: false, reconsent: false }])
})

await test('profile selection, the plan welcome, cancel, sign-out, refresh, and models are exposed', async () => {
  await route(routes, '/profiles/select').fetch(post('/profiles/select', { clientId: 'oaiapp_y' }))
  assert.deepEqual(calls.at(-1), ['select', 'oaiapp_y'])
  const welcomed = await (await route(routes, '/welcome').fetch(post('/welcome', { clientId: 'oaiapp_y' }))).json()
  assert.deepEqual(welcomed, { ok: true, value: state })
  assert.ok(calls.some(call => call[0] === 'welcome' && call[1] === 'oaiapp_y'))
  assert.deepEqual(await (await route(routes, '/cancel').fetch(post('/cancel'))).json(), { ok: true, value: { cancelled: true } })
  const signedOut = await (await route(routes, '/signout').fetch(post('/signout'))).json()
  assert.equal(signedOut.ok, true)
  assert.equal(signedOut.value.revoked, 'revoked')
  assert.deepEqual(signedOut.value.state, state)
  assert.equal((await (await route(routes, '/refresh').fetch(post('/refresh'))).json()).ok, true)
  assert.deepEqual(await (await route(routes, '/models/refresh').fetch(post('/models/refresh'))).json(), {
    ok: true,
    value: { models: [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 272000 }] },
  })
  assert.deepEqual(calls.at(-1), ['models', true])
})

await test('a malformed action body is refused with a stable code', async () => {
  const reply = await route(routes, '/signin').fetch(post('/signin', '{not json'))
  assert.equal(reply.status, 200)
  const body = await reply.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'invalid_request')
  const arrayBody = await (await route(routes, '/signin').fetch(post('/signin', '[1,2]'))).json()
  assert.equal(arrayBody.error.code, 'invalid_request')
})

await test('a refused operation reaches the page as ok:false with its code', async () => {
  const failing = createRoutes({
    session: {
      ...session,
      async beginSignIn() {
        throw new ChatGptError('callback_port_unavailable', 'port busy')
      },
    },
  })
  const body = await (await route(failing, '/signin').fetch(post('/signin'))).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'callback_port_unavailable')
  assert.equal(body.error.message, 'port busy')
})

await test('configuration defaults describe the documented endpoints', () => {
  const config = resolveConfig({})
  assert.equal(config.apiBaseURL, RESOURCE)
  assert.equal(config.authBaseURL, ISSUER)
  assert.equal(config.redirectPort, 1455)
  assert.equal(config.sendHostId, true)
  assert.equal(config.defaultContextWindow, 128000)
  assert.deepEqual(config.defaultInput, ['text', 'image'])
  assert.deepEqual(config.reasoningEfforts, ['low', 'medium', 'high'])
  assert.deepEqual(config.models, [])
})

await test('the model catalog accepts a volatile schema field and normalizes each row', () => {
  const models = [
    { id: 'gpt-x', name: 'GPT X', contextWindow: 272000, input: ['text', 'bogus'] },
    { id: '', name: 'ignored' },
    { id: 'gpt-y', reasoningEfforts: ['low', 'high'] },
  ]
  assert.deepEqual(resolveConfig({ models: { get: () => models } }).models, [
    { id: 'gpt-x', name: 'GPT X', contextWindow: 272000, input: ['text'] },
    { id: 'gpt-y', name: 'gpt-y', reasoningEfforts: ['low', 'high'] },
  ])
  assert.deepEqual(resolveConfig({ models }).models.map(entry => entry.id), ['gpt-x', 'gpt-y'])
})

await test('a non-loopback custom endpoint fails activation with a clear message', () => {
  assert.throws(() => resolveConfig({ authBaseURL: 'https://example.com' }), /local loopback/)
  assert.throws(() => resolveConfig({ apiBaseURL: 'not a url' }), /absolute http\(s\) URL/)
})

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
