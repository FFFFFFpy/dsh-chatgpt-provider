/**
 * Route and configuration checks that need no network: the browser-facing
 * envelope the settings page parses, and the row configuration normalizer.
 */
import assert from 'node:assert/strict'
import { createRoutes } from '../src/routes.js'
import { ChatGptError } from '../src/errors.js'
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

const calls = []
const state = { status: 'signed-out', signedIn: false, account: null, plan: null }
const session = {
  async state() {
    calls.push('state')
    return state
  },
  async beginSignIn() {
    calls.push('signin')
    return { url: 'https://auth.example/authorize?state=1', browserOpened: true }
  },
  cancelSignIn() {
    calls.push('cancel')
    return true
  },
  async signOut() {
    calls.push('signout')
    return { revoked: 'revoked' }
  },
  async refresh() {
    calls.push('refresh')
    return {}
  },
  async listModels({ force } = {}) {
    calls.push(`models:${force === true}`)
    return [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 272000 }]
  },
}

const routes = createRoutes({ session })
const request = () => new Request('http://127.0.0.1:20086/api/chatgpt-provider/x', { method: 'POST' })

await test('every route answers with the JSON envelope the page parses', async () => {
  const reply = await route(routes, '/state').fetch(request())
  assert.equal(reply.status, 200)
  assert.equal(reply.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(reply.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await reply.json(), { ok: true, value: state })
})

await test('signin, cancel, signout, refresh, and the model list are exposed', async () => {
  assert.deepEqual(await (await route(routes, '/signin').fetch(request())).json(), {
    ok: true,
    value: { url: 'https://auth.example/authorize?state=1', browserOpened: true },
  })
  assert.deepEqual(await (await route(routes, '/cancel').fetch(request())).json(), { ok: true, value: { cancelled: true } })
  const signedOut = await (await route(routes, '/signout').fetch(request())).json()
  assert.equal(signedOut.ok, true)
  assert.equal(signedOut.value.revoked, 'revoked')
  assert.deepEqual(signedOut.value.state, state)
  assert.equal((await (await route(routes, '/refresh').fetch(request())).json()).ok, true)
  assert.deepEqual(await (await route(routes, '/models/refresh').fetch(request())).json(), {
    ok: true,
    value: { models: [{ id: 'gpt-test', name: 'GPT Test', contextWindow: 272000 }] },
  })
  assert.ok(calls.includes('models:true'))
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
  const reply = await route(failing, '/signin').fetch(request())
  assert.equal(reply.status, 200)
  const body = await reply.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'callback_port_unavailable')
  assert.equal(body.error.message, 'port busy')
})

await test('configuration defaults describe the documented endpoint and scopes', () => {
  const config = resolveConfig({})
  assert.equal(config.apiBaseURL, 'https://api.openai.com/v1')
  assert.equal(config.authBaseURL, 'https://auth.openai.com')
  assert.equal(config.redirectPort, 1455)
  assert.equal(config.sendHostId, true)
  assert.deepEqual(config.defaultInput, ['text', 'image'])
  assert.deepEqual(config.reasoningEfforts, ['low', 'medium', 'high'])
  assert.deepEqual(config.models, [])
})

await test('configuration overrides and an explicit model catalog are accepted', () => {
  const config = resolveConfig({
    appName: 'My Harness',
    redirectPort: 0,
    defaultContextWindow: 272000,
    defaultInput: ['text', 'bogus'],
    models: [
      { id: 'gpt-x', name: 'GPT X', contextWindow: 272000, input: ['text'] },
      { id: '', name: 'ignored' },
    ],
  })
  assert.equal(config.appName, 'My Harness')
  assert.equal(config.redirectPort, 0)
  assert.equal(config.defaultContextWindow, 272000)
  assert.deepEqual(config.defaultInput, ['text'])
  assert.deepEqual(config.models, [{ id: 'gpt-x', name: 'GPT X', contextWindow: 272000, input: ['text'] }])
})

await test('a non-URL endpoint fails activation with a clear message', () => {
  assert.throws(() => resolveConfig({ apiBaseURL: 'not a url' }), /apiBaseURL must be an absolute http\(s\) URL/)
})

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
