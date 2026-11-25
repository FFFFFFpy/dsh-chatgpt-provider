/**
 * End-to-end checks for the ChatGPT provider bundle, run against a local
 * stand-in for the ChatGPT authorization server and the Responses API.
 *
 * Run with `node test/run.mjs` from the bundle directory.
 */
import assert from 'node:assert/strict'
import { startFakeOpenAI } from './fake-server.mjs'
import { LlmRequestError, ChatGptError } from '../src/errors.js'
import { ISSUER, RESOURCE } from '../src/constants.js'
import { resolveEndpoints } from '../src/oauth.js'

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

let capturedUrl
let callbackStatus

/**
 * Build the OAuth client whose browser is the test itself.
 * @param {{ clientId?: string }} [options] - registration the callback should return.
 * @returns {InstanceType<typeof ChatGPTAuth>} the client.
 */
function makeAuth(options = {}) {
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
      const clientId = options.clientId ?? fake.state.clientId
      setTimeout(() => {
        void fetch(`${redirect}?code=test-code&state=${encodeURIComponent(state)}&client_id=${clientId}`)
          .then(response => { callbackStatus = response.status })
          .catch(() => { callbackStatus = -1 })
      }, 5)
      return true
    },
  })
}

const auth = makeAuth()
const session = new ChatGptSession({ ctx, config, auth, logger })
const adapter = new ChatGptAdapter({ session, config, ctx, logger })

/**
 * Read the stored state document.
 * @returns {Promise<Record<string, any>>} the version-2 state.
 */
async function storedState() {
  const record = records.get(session.key)
  return record?.payload
}

/**
 * Rewrite the active profile in place, keeping the store's document shape.
 * @param {(profile: Record<string, any>) => Record<string, any>} mutate - profile rewrite.
 * @returns {Promise<void>} resolves after the write.
 */
async function editProfile(mutate) {
  await ctx.credentials.modifyRecord(session.key, async current => {
    const state = current.payload
    state.profiles = state.profiles.map(profile => (profile.clientId === state.activeId ? mutate(profile) : profile))
    return { kind: 'grant', payload: state }
  })
}

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
  assert.equal(capturedUrl, started.url)
})

await test('the grant is stored as a version-2 profile document', async () => {
  const state = await storedState()
  assert.equal(state.version, 2)
  assert.equal(state.issuer, fake.base)
  assert.equal(state.resource, `${fake.base}/v1`)
  assert.equal(state.activeId, 'oaiapp_test')
  assert.equal(state.profiles.length, 1)
  const profile = state.profiles[0]
  assert.equal(profile.clientId, 'oaiapp_test')
  assert.equal(profile.subject, 'user-1')
  assert.equal(profile.email, 'user@example.com')
  assert.equal(profile.accessToken, 'at-code')
  assert.equal(profile.refreshToken, 'rt-code')
  assert.equal(profile.status, 'connected')
  assert.match(profile.extAgentHostId, /^urn:uuid:/)
  assert.equal(records.get('chatgpt-provider/host').payload.hostId, profile.extAgentHostId)
  assert.equal(await session.hostId(), profile.extAgentHostId)
})

await test('the settings state omits every token and lists the account models', async () => {
  const state = await session.state()
  assert.equal(state.status, 'signed-in')
  assert.equal(state.signedIn, true)
  assert.equal(state.plan.sharing, true)
  assert.equal(state.account.email, 'user@example.com')
  assert.equal(state.renewable, true)
  assert.deepEqual(state.models.map(model => model.id), ['gpt-test'])
  assert.deepEqual(state.profiles.map(profile => profile.clientId), ['oaiapp_test'])
  const serialized = JSON.stringify(state)
  for (const secret of ['at-code', 'rt-code', 'id_token', 'refreshToken', 'accessToken']) {
    assert.equal(serialized.includes(secret), false, `state leaked ${secret}`)
  }
})

await test('a text request leads input with a developer message and omits rejected fields', async () => {
  fake.state.mode = 'ok'
  fake.state.usageMode = 'legacy'
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
  // Top-level `instructions` are billed uncached on every request from GPT-6.2
  // on, so the system prompt must lead `input` instead.
  assert.equal('instructions' in sent.body, false)
  assert.equal('temperature' in sent.body, false)
  assert.equal('max_output_tokens' in sent.body, false)
  assert.deepEqual(sent.body.input[0], { role: 'developer', content: 'You are terse.' })
  assert.deepEqual(sent.body.input[1], { role: 'developer', content: 'Runtime context.' })
  assert.deepEqual(sent.body.input[2], { role: 'user', content: 'hi' })
  assert.match(sent.headers.authorization, /^Bearer at-code$/)
  assert.ok(sent.headers['user-agent'].startsWith('deepseek-harness'))
  assert.ok(sent.headers['user-agent'].includes('(+https://github.com/deepseek-ai/deepseek-harness)'))

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hello' })
  assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
  // 11 input tokens include the 2 cached ones; the harness wants them disjoint.
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 9, outputTokens: 7, totalTokens: 18, cacheReadTokens: 2, reasoningTokens: 3 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

/**
 * Mirror the harness's disjoint-usage validation so a mapping that would hide
 * the Turn usage row fails here first.
 * @param {Record<string, any>} usage - adapter-reported usage.
 * @returns {boolean} whether the accounting is consistent.
 */
function usageIsConsistent(usage) {
  const knownPrompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (usage.totalTokens === undefined) return usage.cacheReadTokens === undefined ? false : usage.cacheWriteTokens !== undefined
  const exactPrompt = usage.totalTokens - usage.outputTokens
  if (exactPrompt < knownPrompt) return false
  if (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) return false
  return true
}

/**
 * Stream one tiny request and return its usage chunk.
 * @returns {Promise<Record<string, any>>} reported usage.
 */
async function usageOfOneCall() {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'chatgpt',
    model: 'gpt-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'usage probe' }] }],
  })) chunks.push(chunk)
  return chunks.find(chunk => chunk.type === 'usage').usage
}

await test('a cached read alone is reported as disjoint uncached and cached input', async () => {
  fake.state.mode = 'ok'
  fake.state.usageMode = 'legacy'
  const usage = await usageOfOneCall()
  assert.equal(usage.inputTokens, 9)
  assert.equal(usage.cacheReadTokens, 2)
  assert.equal(usage.cacheWriteTokens, undefined)
  assert.equal(usageIsConsistent(usage), true)
})

await test('a model that bills cache writes reports both buckets disjointly', async () => {
  fake.state.mode = 'ok'
  fake.state.usageMode = 'writes'
  const usage = await usageOfOneCall()
  assert.deepEqual(usage, {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 12500,
    cacheReadTokens: 4000,
    cacheWriteTokens: 7000,
    reasoningTokens: 100,
  })
  assert.equal(usageIsConsistent(usage), true)
})

await test('usage without cache detail leaves both buckets absent', async () => {
  fake.state.mode = 'ok'
  fake.state.usageMode = 'uncached'
  const usage = await usageOfOneCall()
  assert.deepEqual(usage, { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 })
  assert.equal(usageIsConsistent(usage), true)
  fake.state.usageMode = 'legacy'
})

await test('the route declares in-history system prompt updates so the prefix survives', async () => {
  const resolved = await adapter.resolveModel('chatgpt', 'gpt-test')
  assert.equal(resolved.systemPromptUpdate, 'in-history')
  assert.equal(resolved.toolUpdate, undefined)
})

await test('a second round repeats the first request prefix byte for byte', async () => {
  fake.state.mode = 'ok'
  const history = [
    { role: 'system', content: [{ type: 'text', text: 'Stable system prompt.' }] },
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
  ]
  for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'gpt-test', messages: history })) { /* round 1 */ }
  const first = fake.recordings.responses.at(-1).body.input

  const second = [...history,
    {
      role: 'assistant',
      source: { kind: 'model', provider: 'chatgpt', model: 'gpt-test' },
      content: [{ type: 'text', text: 'first answer' }],
    },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ]
  for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'gpt-test', messages: second })) { /* round 2 */ }
  const next = fake.recordings.responses.at(-1).body.input

  assert.ok(next.length > first.length)
  assert.deepEqual(next.slice(0, first.length), first)
  assert.deepEqual(fake.recordings.responses.at(-1).body.tools, undefined)
})

await test('tools are grouped in one namespace and tool rounds replay with it', async () => {
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
    { type: 'function_call', namespace: 'dsh', call_id: 'call-0', name: 'read', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', namespace: 'dsh', call_id: 'call-0', output: 'alpha' },
  ])
  assert.equal(sent.tools.length, 1)
  assert.equal(sent.tools[0].type, 'namespace')
  assert.equal(sent.tools[0].name, 'dsh')
  assert.equal(sent.tools[0].tools[0].type, 'function')
  assert.equal(sent.tools[0].tools[0].name, 'read')
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
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1)
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
  fake.state.mode = 'ineligible'
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

await test('an expiring access token refreshes, checkpoints, and verifies the rotation', async () => {
  fake.state.mode = 'ok'
  fake.state.refreshIdToken = true
  await editProfile(profile => ({ ...profile, expiresAt: Date.now() - 1000 }))
  const before = await storedState()
  const token = await session.accessToken()
  assert.equal(token, 'at-refreshed')
  const refresh = fake.recordings.tokenRequests.at(-1)
  assert.equal(refresh.grant_type, 'refresh_token')
  assert.equal(refresh.client_id, 'oaiapp_test')
  assert.equal(refresh.resource, `${fake.base}/v1`)
  const after = await storedState()
  const profile = after.profiles.find(entry => entry.clientId === 'oaiapp_test')
  assert.equal(profile.refreshToken, 'rt-refreshed')
  assert.equal(profile.accessToken, 'at-refreshed')
  assert.equal(profile.pendingRefresh, undefined)
  assert.ok(profile.expiresAt > Date.now())
  assert.notEqual(profile.savedAt, before.profiles[0].savedAt)
})

await test('a closed refresh window is reported instead of forcing a refresh', async () => {
  fake.state.earliestRefreshAt = Math.floor(Date.now() / 1000) + 3600
  fake.state.clientId = 'oaiapp_window'
  fake.state.subject = 'user-window'
  const started = await session.beginSignIn({ newProfile: true })
  assert.deepEqual(await started.done, { ok: true })
  await ctx.credentials.modifyRecord(session.key, async current => {
    const state = current.payload
    state.profiles = state.profiles.map(profile => profile.clientId === state.activeId
      ? { ...profile, expiresAt: Date.now() - 1000 }
      : profile)
    return { kind: 'grant', payload: state }
  })
  await assert.rejects(() => session.accessToken(), error => error instanceof ChatGptError && error.code === 'refresh_not_ready')
  // Restore the first account for the remaining checks.
  await session.selectProfile('oaiapp_test')
  fake.state.earliestRefreshAt = undefined
})

await test('a terminal refresh failure marks the profile for sign-in', async () => {
  // A dedicated account: a terminal failure drops this registration's tokens
  // and marks it reauth_required, which must not disturb the other accounts.
  fake.state.clientId = 'oaiapp_poison'
  fake.state.subject = 'user-3'
  fake.state.email = 'third@example.com'
  fake.state.earliestRefreshAt = undefined
  assert.deepEqual(await (await session.beginSignIn({ newProfile: true })).done, { ok: true })
  fake.state.refreshFails = true
  await editProfile(profile => ({ ...profile, expiresAt: Date.now() - 1000 }))
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: 'chatgpt', model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) { /* drain */ }
  }, error => error instanceof LlmRequestError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED')
  const state = await storedState()
  const poison = state.profiles.find(entry => entry.clientId === 'oaiapp_poison')
  assert.equal(poison.status, 'reauth_required')
  assert.equal(poison.refreshToken, undefined)
  const view = await session.state({ models: false })
  assert.equal(view.status, 'reauth-required')
  fake.state.refreshFails = false
  await session.selectProfile('oaiapp_test')
})

await test('a second account is added beside the others and can be selected', async () => {
  fake.state.clientId = 'oaiapp_second'
  fake.state.subject = 'user-2'
  fake.state.email = 'second@example.com'
  const started = await session.beginSignIn({ newProfile: true })
  assert.deepEqual(await started.done, { ok: true })
  let state = await storedState()
  assert.equal(state.activeId, 'oaiapp_second')
  assert.deepEqual(state.profiles.map(entry => entry.clientId), ['oaiapp_test', 'oaiapp_window', 'oaiapp_poison', 'oaiapp_second'])
  await session.selectProfile('oaiapp_test')
  state = await storedState()
  assert.equal(state.activeId, 'oaiapp_test')
  const view = await session.state({ models: false })
  assert.deepEqual(view.profiles.map(entry => entry.number), [1, 2, 3, 4])
  assert.deepEqual(view.profiles.map(entry => entry.status), ['connected', 'connected', 'reauth_required', 'connected'])
})

await test('signing out revokes the session and keeps the reusable registration', async () => {
  await session.selectProfile('oaiapp_second')
  const outcome = await session.signOut()
  assert.equal(outcome.revoked, 'revoked')
  assert.ok(fake.recordings.revocations.length >= 1)
  assert.equal(fake.recordings.revocations.at(-1).token_type_hint, 'refresh_token')
  assert.equal(await session.read(), undefined)
  const state = await storedState()
  const profile = state.profiles.find(entry => entry.clientId === 'oaiapp_second')
  assert.equal(profile.status, 'disconnected')
  assert.equal(profile.refreshToken, undefined)
  assert.equal(profile.clientId, 'oaiapp_second')
  const view = await session.state({ models: false })
  assert.equal(view.status, 'signed-out')
  await session.selectProfile('oaiapp_test')
})

await test('a version-1 record is migrated to a registration that must sign in again', async () => {
  const saved = records.get(session.key)
  records.set(session.key, {
    kind: 'grant',
    payload: { version: 1, clientId: 'oaiapp_legacy', subject: 'user-legacy', accessToken: 'at-legacy', refreshToken: 'rt-legacy', expiresAt: Date.now() + 60_000, savedAt: new Date().toISOString() },
  })
  try {
    await session.read()
    const state = await storedState()
    assert.equal(state.version, 2)
    assert.equal(state.activeId, 'oaiapp_legacy')
    assert.equal(state.profiles[0].status, 'reauth_required')
    assert.equal(state.profiles[0].accessToken, undefined)
    assert.equal(state.profiles[0].refreshToken, undefined)
  } finally {
    records.set(session.key, saved)
    await session.selectProfile('oaiapp_test')
  }
})

await test('a mismatched callback state cannot complete a sign-in', async () => {
  const start = await session.beginSignIn({ newProfile: true })
  const parsed = new URL(start.url)
  const redirect = parsed.searchParams.get('redirect_uri')
  fake.state.nonce = parsed.searchParams.get('nonce')
  const response = await fetch(`${redirect}?code=test-code&state=wrong&client_id=oaiapp_third`)
  assert.equal(response.status, 400)
  assert.equal(session.cancelSignIn(), true)
  const outcome = await start.done
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'cancelled')
})

await test('only the official or a loopback endpoint pair is accepted', () => {
  assert.deepEqual(resolveEndpoints(ISSUER, RESOURCE), { authBaseURL: ISSUER, apiBaseURL: RESOURCE })
  assert.deepEqual(resolveEndpoints(fake.base, `${fake.base}/v1`), { authBaseURL: fake.base, apiBaseURL: `${fake.base}/v1` })
  assert.throws(() => resolveEndpoints('https://example.com', 'https://example.com/v1'), /local loopback/)
  assert.throws(() => resolveEndpoints('ftp://127.0.0.1', 'http://127.0.0.1:1/v1'), /HTTP\(S\) endpoint/)
})

await fake.close()
console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1

