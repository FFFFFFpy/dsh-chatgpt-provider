/**
 * End-to-end checks for the ChatGPT provider bundle, run against a local
 * stand-in for the ChatGPT authorization server and the Responses API.
 *
 * Run with `node test/run.mjs` from the bundle directory.
 */
import assert from 'node:assert/strict'
import { startFakeOpenAI } from './fake-server.mjs'
import { LlmRequestError } from '../src/errors.js'

const fake = await startFakeOpenAI()
const records = new Map()
const attachments = {
  async readImageRequest() {
    return { data: Buffer.from('png-bytes'), mediaType: 'image/png' }
  },
}
const logs = []
const logger = {
  info: (...args) => logs.push(['info', ...args]),
  warn: (...args) => logs.push(['warn', ...args]),
  debug: (...args) => logs.push(['debug', ...args]),
}

const ctx = {
  credentials: {
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  },
  get(name) {
    return name === 'attachments' ? attachments : undefined
  },
  llm: { fileRequestText: ref => `[file ${ref.name}]` },
}

const config = {
  appName: 'DeepSeek Harness Test',
  redirectPort: 0,
  authBaseURL: fake.base,
  apiBaseURL: `${fake.base}/v1`,
  sendHostId: true,
  browserCommand: '',
  defaultInput: ['text', 'image'],
  defaultContextWindow: 128000,
  reasoningEfforts: ['low', 'medium', 'high'],
  models: [],
  modelCacheSeconds: 600,
  requestTimeoutMs: 180000,
  signInTimeoutMs: 30000,
  trace: false,
}

const { ChatGPTAuth } = await import('../src/oauth.js')
const { ChatGptSession } = await import('../src/session.js')
const { ChatGptAdapter } = await import('../src/adapter.js')

let failures = 0
let passes = 0

/**
 * Run one named check.
 * @param {string} name - check name.
 * @param {() => Promise<void>} work - the check.
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

/** Build the OAuth client whose browser is the test itself. */
function makeAuth() {
  return new ChatGPTAuth({
    authBaseURL: fake.base,
    apiBaseURL: `${fake.base}/v1`,
    redirectPort: 0,
    appName: 'DeepSeek Harness Test',
    sendHostId: true,
    logger,
    openBrowser: async url => {
      capturedUrl = url
      const parsed = new URL(url)
      fake.state.nonce = parsed.searchParams.get('nonce')
      const state = parsed.searchParams.get('state')
      const redirect = parsed.searchParams.get('redirect_uri')
      setTimeout(() => {
        void fetch(`${redirect}?code=test-code&state=${encodeURIComponent(state)}&client_id=${fake.state.clientId}`)
          .then(response => { callbackStatus = response.status })
          .catch(() => { callbackStatus = -1 })
      }, 5)
      return true
    },
  })
}

let capturedUrl
let callbackStatus
let session
let adapter

const auth = makeAuth()
session = new ChatGptSession({ ctx, config, auth, logger })
adapter = new ChatGptAdapter({ session, config, ctx, logger })

await test('sign-in starts a documented authorization request', async () => {
  const started = await session.beginSignIn()
  const parsed = new URL(started.url)
  assert.equal(parsed.origin, fake.base)
  assert.equal(parsed.pathname, '/api/accounts/authorize')
  assert.equal(parsed.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(parsed.searchParams.get('agent_name_hint'), 'DeepSeek Harness Test')
  assert.match(parsed.searchParams.get('ext_agent_host_id'), /^urn:uuid:/)
  assert.equal(parsed.searchParams.get('response_type'), 'code')
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
  assert.match(parsed.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/)
  assert.equal(parsed.searchParams.get('resource'), `${fake.base}/v1`)
  assert.match(parsed.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  const outcome = await started.done
  assert.deepEqual(outcome, { ok: true })
  assert.equal(callbackStatus, 200)
})

await test('the grant is stored with the verified identity and issued client id', async () => {
  const connection = await session.read()
  assert.equal(connection.clientId, 'oaiapp_test')
  assert.equal(connection.subject, 'user-1')
  assert.equal(connection.email, 'user@example.com')
  assert.equal(connection.accessToken, 'at-code')
  assert.equal(connection.refreshToken, 'rt-code')
  assert.equal(connection.status, 'connected')
  assert.match(connection.extAgentHostId, /^urn:uuid:/)
  assert.equal(records.get('chatgpt-provider/host').payload.hostId, connection.extAgentHostId)
})

await test('the settings state omits every token and lists the account models', async () => {
  const state = await session.state()
  assert.equal(state.status, 'signed-in')
  assert.equal(state.signedIn, true)
  assert.equal(state.plan.sharing, true)
  assert.equal(state.account.email, 'user@example.com')
  assert.deepEqual(state.models.map(model => model.id), ['gpt-test'])
  const serialized = JSON.stringify(state)
  for (const secret of ['at-code', 'rt-code', 'id_token', 'refreshToken', 'accessToken']) {
    assert.equal(serialized.includes(secret), false, `state leaked ${secret}`)
  }
})

await test('a text request uses instructions, store:false, stream:true, and no rejected fields', async () => {
  fake.state.mode = 'ok'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    system: 'You are terse.',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Runtime context.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    temperature: 0.3,
    maxTokens: 100,
  })) chunks.push(chunk)

  const sent = fake.recordings.responses.at(-1)
  assert.equal(sent.body.store, false)
  assert.equal(sent.body.stream, true)
  assert.equal(sent.body.instructions, 'You are terse.')
  assert.equal('temperature' in sent.body, false)
  assert.equal('max_output_tokens' in sent.body, false)
  assert.deepEqual(sent.body.input[0], { role: 'developer', content: 'Runtime context.' })
  assert.deepEqual(sent.body.input[1], { role: 'user', content: 'hi' })
  assert.match(sent.headers.authorization, /^Bearer at-code$/)
  assert.ok(sent.headers['user-agent'].startsWith('deepseek-harness'))
  assert.ok(sent.headers['user-agent'].includes('(+https://github.com/deepseek-ai/deepseek-harness)'))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hello' })
  assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 2, reasoningTokens: 3 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await test('tool rounds replay as function_call and function_call_output items', async () => {
  fake.state.mode = 'tool'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
      {
        role: 'assistant',
        source: { kind: 'model', provider: 'chatgpt', model: 'gpt-test' },
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool-call', id: 'call-0', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
      {
        role: 'tool',
        source: { kind: 'tool', callId: 'call-0' },
        toolCallId: 'call-0',
        content: [{ type: 'text', text: 'alpha' }],
      },
    ],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    reasoningEffort: 'high',
  })) chunks.push(chunk)

  const sent = fake.recordings.responses.at(-1).body
  assert.deepEqual(sent.input, [
    { role: 'user', content: 'read a.txt' },
    { role: 'assistant', content: 'Reading.' },
    { type: 'function_call', call_id: 'call-0', name: 'read', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'call-0', output: 'alpha' },
  ])
  assert.equal(sent.tools[0].type, 'function')
  assert.equal(sent.tools[0].name, 'read')
  assert.equal(sent.tool_choice, 'auto')
  assert.deepEqual(sent.reasoning, { effort: 'high' })

  const toolBlock = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(toolBlock.block, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

await test('reasoning summary deltas become a reasoning block', async () => {
  fake.state.mode = 'reasoning'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
  })) chunks.push(chunk)
  const reasoning = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoning.block.text, 'Thinking…')
})

await test('images are projected through the attachment service', async () => {
  fake.state.mode = 'ok'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } },
      ],
    }],
  })) chunks.push(chunk)
  const sent = fake.recordings.responses.at(-1).body
  assert.deepEqual(sent.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,cG5nLWJ5dGVz' })
})

await test('a provider that never closes an opened item still yields one block-end per start', async () => {
  fake.state.mode = 'unclosed'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)
  const starts = chunks.filter(chunk => chunk.type === 'block-start').length
  const ends = chunks.filter(chunk => chunk.type === 'block-end').length
  assert.equal(starts, 1)
  assert.equal(ends, 1)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, { type: 'text', text: 'Hello world' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await test('a usage-limit refusal becomes QUOTA', async () => {
  fake.state.mode = 'quota'
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'QUOTA')
})

await test('an ineligible account becomes AUTH', async () => {
  fake.state.mode = 'unsupported-purpose'
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'AUTH')
})

await test('an in-stream failure becomes UNSUPPORTED_OPTION', async () => {
  fake.state.mode = 'fail'
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'UNSUPPORTED_OPTION')
})

await test('a truncated response reports max-tokens', async () => {
  fake.state.mode = 'incomplete'
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

await test('stop sequences are refused instead of silently dropped', async () => {
  fake.state.mode = 'ok'
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [], stop: ['END'],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'UNSUPPORTED_OPTION')
})

await test('an expiring access token is refreshed and the rotation is stored', async () => {
  fake.state.mode = 'ok'
  const before = await session.read()
  await ctx.credentials.modifyRecord('chatgpt-provider/default', async () => ({
    kind: 'grant',
    payload: { ...before, expiresAt: Date.now() - 1000, refreshToken: 'rt-code' },
  }))
  const token = await session.accessToken()
  assert.equal(token, 'at-refreshed')
  const refresh = fake.recordings.tokenRequests.at(-1)
  assert.equal(refresh.grant_type, 'refresh_token')
  assert.equal(refresh.client_id, 'oaiapp_test')
  assert.equal(refresh.resource, `${fake.base}/v1`)
  const after = await session.read()
  assert.equal(after.refreshToken, 'rt-refreshed')
  assert.ok(after.expiresAt > Date.now())
})

await test('a terminal refresh failure marks the grant for sign-in', async () => {
  fake.state.refreshFails = true
  const before = await session.read()
  await ctx.credentials.modifyRecord('chatgpt-provider/default', async () => ({
    kind: 'grant',
    payload: { ...before, expiresAt: Date.now() - 1000 },
  }))
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED')
  const after = await session.read()
  assert.equal(after.status, 'reauth_required')
  fake.state.refreshFails = false
})

await test('signing out revokes the session and forgets the grant', async () => {
  const outcome = await session.signOut()
  assert.equal(outcome.revoked, 'revoked')
  assert.equal(fake.recordings.revocations.length, 1)
  assert.equal(fake.recordings.revocations[0].token_type_hint, 'refresh_token')
  assert.equal(await session.read(), undefined)
  const state = await session.state()
  assert.equal(state.status, 'signed-out')
})

await test('a mismatched callback state cannot complete a sign-in', async () => {
  const start = await session.beginSignIn()
  const parsed = new URL(start.url)
  const redirect = parsed.searchParams.get('redirect_uri')
  fake.state.nonce = parsed.searchParams.get('nonce')
  const response = await fetch(`${redirect}?code=test-code&state=wrong&client_id=oaiapp_test`)
  assert.equal(response.status, 400)
  assert.equal(session.cancelSignIn(), true)
  const outcome = await start.done
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'cancelled')
})

await fake.close()
console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1

