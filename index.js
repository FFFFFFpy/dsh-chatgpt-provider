/**
 * Host half of the ChatGPT provider bundle.
 *
 * It makes a user's ChatGPT plan usable as a model provider in DeepSeek
 * Harness: it registers the `chatgpt` provider route, its Responses adapter,
 * the Sign in with ChatGPT OAuth flow, and the small JSON API the settings page
 * uses to sign in, refresh, and sign out.
 *
 * The host projects the model catalog schema into its Models settings editor.
 */
import Schema from '@deepseek-ai/schemastery'
import { API_PREFIX, ISSUER, PROVIDER, RESOURCE } from './src/constants.js'
import { ChatGptAdapter } from './src/adapter.js'
import { ChatGptError } from './src/errors.js'
import { ChatGPTAuth, resolveEndpoints } from './src/oauth.js'
import { createRoutes } from './src/routes.js'
import { ChatGptSession } from './src/session.js'

/** Stable Cordis plugin name. */
export const name = 'chatgpt-provider'

/** Services the provider needs; `authorization` is optional and joined below. */
export const inject = ['llm', 'connection', 'credentials']

/** The Models editor projects volatile fields under the loader entry's settings namespace. */
export const Config = Schema.object({
  // modelCatalog normalizes each row, including catalogs from older profiles.
  models: Schema.array(Schema.any()).default([]).loose().volatile(),
})

/** Every field's default: a bare row works. */
const DEFAULTS = Object.freeze({
  appName: 'DeepSeek Harness',
  redirectPort: 1455,
  browserCommand: '',
  defaultInput: ['text', 'image'],
  defaultContextWindow: 128000,
  reasoningEfforts: ['low', 'medium', 'high'],
  modelCacheSeconds: 600,
  requestTimeoutMs: 180000,
  signInTimeoutMs: 300000,
  promptCacheKey: true,
  trace: false,
})

/**
 * Accept a non-empty string.
 * @param {unknown} value - candidate.
 * @param {string} fallback - default.
 * @returns {string} the value or the default.
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Accept a non-negative finite number.
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @returns {number} the value or the default.
 */
function count(value, fallback) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback
}

/**
 * Accept a modality list.
 * @param {unknown} value - candidate.
 * @param {Array<string> | undefined} fallback - default.
 * @returns {Array<string> | undefined} known modalities.
 */
function modalities(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const known = value.filter(entry => entry === 'text' || entry === 'image')
  return known.length === 0 ? fallback : known
}

/**
 * Accept a non-empty effort id list.
 * @param {unknown} value - candidate.
 * @param {Array<string> | undefined} fallback - default.
 * @returns {Array<string> | undefined} effort ids.
 */
function efforts(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const known = value.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
  return known.length === 0 ? fallback : known
}

/**
 * Accept an explicit model catalog.
 * @param {unknown} value - candidate.
 * @returns {Array<Record<string, unknown>>} normalized entries.
 */
function modelCatalog(value) {
  if (!Array.isArray(value)) return []
  const models = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    models.push({
      id,
      name: text(entry.name, id),
      ...Number.isFinite(Number(entry.contextWindow)) && Number(entry.contextWindow) > 0 ? { contextWindow: Number(entry.contextWindow) } : {},
      ...Number.isFinite(Number(entry.maxTokens)) && Number(entry.maxTokens) > 0 ? { maxTokens: Number(entry.maxTokens) } : {},
      ...modalities(entry.input, undefined) === undefined ? {} : { input: modalities(entry.input, undefined) },
      ...efforts(entry.reasoningEfforts, undefined) === undefined ? {} : { reasoningEfforts: efforts(entry.reasoningEfforts, undefined) },
    })
  }
  return models
}

/**
 * Normalize the row's configuration.
 * @param {unknown} raw - loader-provided configuration.
 * @returns {Record<string, any>} resolved configuration.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const endpoints = resolveEndpoints(text(input.authBaseURL, ISSUER), text(input.apiBaseURL, RESOURCE))
  return {
    appName: text(input.appName, DEFAULTS.appName),
    redirectPort: count(input.redirectPort, DEFAULTS.redirectPort),
    ...endpoints,
    sendHostId: endpoints.authBaseURL === ISSUER || input.sendHostId !== false,
    browserCommand: text(input.browserCommand, DEFAULTS.browserCommand),
    defaultInput: modalities(input.defaultInput, DEFAULTS.defaultInput),
    defaultContextWindow: count(input.defaultContextWindow, DEFAULTS.defaultContextWindow),
    reasoningEfforts: efforts(input.reasoningEfforts, DEFAULTS.reasoningEfforts),
    get models() {
      return modelCatalog(typeof input.models?.get === 'function' ? input.models.get() : input.models)
    },
    modelCacheSeconds: count(input.modelCacheSeconds, DEFAULTS.modelCacheSeconds),
    requestTimeoutMs: count(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    signInTimeoutMs: count(input.signInTimeoutMs, DEFAULTS.signInTimeoutMs),
    promptCacheKey: input.promptCacheKey !== false,
    trace: input.trace === true,
  }
}

/**
 * Mount the provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {unknown} rawConfig - the row's configuration.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger
  const auth = new ChatGPTAuth({
    authBaseURL: config.authBaseURL,
    apiBaseURL: config.apiBaseURL,
    redirectPort: config.redirectPort,
    appName: config.appName,
    sendHostId: config.sendHostId,
    browserCommand: config.browserCommand,
    logger,
  })
  const session = new ChatGptSession({ ctx, config, auth, logger })
  ctx.effect(() => () => session.dispose(), 'chatgpt-provider: session')

  ctx.inject(['settings'], scope => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })

  // One directory entry: configuration surfaces can show the provider before
  // it has any route of its own, and `nativeAuth.oauth` tells them the
  // credential comes from a sign-in rather than a key field.
  ctx.effect(() => ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'ChatGPT',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
    nativeAuth: { env: [], oauth: true },
    defaultBaseURL: config.apiBaseURL,
  }]), 'chatgpt-provider: configurable provider')

  const adapter = new ChatGptAdapter({ session, config, ctx, logger })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'chatgpt-provider: adapter')

  for (const definition of createRoutes({ session })) {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: definition.path,
        methods: definition.methods,
        requestBody: 'buffered',
        fetch: definition.fetch,
      }),
      `chatgpt-provider: route ${definition.path}`,
    )
  }

  // The seam is optional: a headless composition simply has no surface to run
  // a flow from, while the provider itself still works from the settings API.
  ctx.inject(['authorization'], scope => {
    scope.authorization.registerFlow({
      key: session.key,
      label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
      async run(flow) {
        const started = await session.beginSignIn({ signal: flow.signal })
        flow.notify({ message: 'Continue in your browser to authorize ChatGPT, then return here.', url: started.url })
        const outcome = await started.done
        if (!outcome.ok) throw new ChatGptError(outcome.error.code, outcome.error.message)
      },
    })
  })

  logger?.info?.(`chatgpt-provider: ready (provider "${PROVIDER}", settings ${API_PREFIX})`)
}
