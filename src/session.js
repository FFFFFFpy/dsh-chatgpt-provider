/**
 * One ChatGPT account's durable connection plus the derived state configuration
 * surfaces and the adapter read.
 *
 * The credential store is the only writer: the sign-in flow and the refresher
 * both commit through `modifyRecord`, so a rotation is durable before it is
 * used and a second process cannot race a rotating refresh token.
 */
import { randomUUID } from 'node:crypto'
import { API_PREFIX, PLAN_SCOPE, RECORD_KEY } from './constants.js'
import { ChatGptError, CODES, apiError, requiresSignIn } from './errors.js'

/** The stable host-id record, kept apart from the account grant. */
const HOST_RECORD_KEY = 'chatgpt-provider/host'

/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000

/**
 * Read a JSON body without trusting its shape.
 * @param {Response} response - reply.
 * @returns {Promise<unknown>} parsed body, or raw text.
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

/**
 * Normalize one models-listing entry.
 * @param {unknown} entry - provider entry.
 * @returns {{ id: string, name: string, contextWindow?: number, maxTokens?: number, reasoningEfforts?: string[] } | undefined} normalized model, or undefined when unusable.
 */
function normalizeModel(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const slug = entry.slug ?? entry.id
  if (typeof slug !== 'string' || slug.trim() === '' || slug.length > 200) return undefined
  if (entry.visibility !== undefined && entry.visibility !== 'list') return undefined
  const display = entry.display_name ?? entry.displayName ?? entry.name
  const name = typeof display === 'string' && display.trim() !== '' ? display.slice(0, 200) : slug
  const contextWindow = Number(entry.context_window ?? entry.contextWindow)
  const maxTokens = Number(entry.max_output_tokens ?? entry.maxTokens)
  const efforts = Array.isArray(entry.reasoning_efforts ?? entry.reasoningEfforts)
    ? (entry.reasoning_efforts ?? entry.reasoningEfforts).filter(value => typeof value === 'string' && value !== '')
    : undefined
  return {
    id: slug,
    name,
    ...Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {},
    ...Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {},
    ...efforts === undefined || efforts.length === 0 ? {} : { reasoningEfforts: efforts },
  }
}

/**
 * The live ChatGPT connection for this deployment.
 */
export class ChatGptSession {
  /**
   * @param {object} options - session options.
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Host context; `credentials` is injected by the caller.
   * @param {object} options.config - resolved plugin configuration.
   * @param {import('./oauth.js').ChatGPTAuth} options.auth - the OAuth client.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger] - safe diagnostics.
   */
  constructor({ ctx, config, auth, logger }) {
    this.ctx = ctx
    this.config = config
    this.auth = auth
    this.logger = logger
    this.attempt = undefined
    this.lastSignInError = undefined
    this.refreshPromise = undefined
    this.catalog = { key: undefined, fetchedAt: 0, models: [], error: undefined }
    this.hostIdPromise = undefined
  }

  /** @returns {import('@deepseek-ai/dsh-credentials').CredentialKey} the account record address. */
  get key() {
    return RECORD_KEY
  }

  /**
   * Read the stored connection.
   * @returns {Promise<Record<string, unknown> | undefined>} the payload, or undefined.
   */
  async read() {
    const record = await this.ctx.credentials.readRecord(this.key)
    const payload = record?.kind === 'grant' ? record.payload : undefined
    return payload !== null && typeof payload === 'object' ? payload : undefined
  }

  /**
   * Commit a payload as this plugin's grant record.
   * @param {Record<string, unknown>} payload - owner-defined JSON.
   * @returns {Promise<void>} resolves once durable.
   */
  async write(payload) {
    await this.ctx.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload }))
  }

  /**
   * Delete the stored grant.
   * @returns {Promise<void>} resolves once removed.
   */
  async clear() {
    await this.ctx.credentials.deleteRecord(this.key)
    this.catalog = { key: undefined, fetchedAt: 0, models: [], error: undefined }
  }

  /**
   * Return this host's stable `ext_agent_host_id`, creating it once.
   * @returns {Promise<string>} the opaque host id.
   */
  async hostId() {
    this.hostIdPromise ??= (async () => {
      const record = await this.ctx.credentials.modifyRecord(HOST_RECORD_KEY, async current => {
        const existing = current?.kind === 'grant' && current.payload !== null && typeof current.payload === 'object'
          ? current.payload.hostId
          : undefined
        if (typeof existing === 'string' && existing.startsWith('urn:')) return current
        return { kind: 'grant', payload: { hostId: `urn:uuid:${randomUUID()}` } }
      })
      const value = record?.kind === 'grant' && record.payload !== null && typeof record.payload === 'object' ? record.payload.hostId : undefined
      if (typeof value !== 'string' || !value.startsWith('urn:')) {
        throw new ChatGptError(CODES.configuration, 'The ChatGPT host identifier could not be stored.')
      }
      return value
    })().catch(error => {
      this.hostIdPromise = undefined
      throw error
    })
    return this.hostIdPromise
  }

  /**
   * Start one sign-in attempt.
   * @returns {Promise<{ url: string, browserOpened: boolean, done: Promise<{ ok: true } | { ok: false, error: { code: string, message: string } }> }>} the authorization URL, whether a browser was launched, and the attempt's settlement.
   */
  async beginSignIn() {
    if (this.attempt !== undefined) {
      throw new ChatGptError('already_running', 'A ChatGPT sign-in is already waiting for the browser.')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.signInTimeoutMs)
    const attempt = { controller, url: undefined, error: undefined, settled: false, resolveDone: undefined }
    const done = new Promise(resolve => {
      attempt.resolveDone = resolve
    })
    this.attempt = attempt
    this.lastSignInError = undefined
    const settle = value => {
      attempt.settled = true
      clearTimeout(timeout)
      if (this.attempt === attempt) this.attempt = undefined
      controller.abort()
      attempt.resolveDone(value)
    }
    try {
      const previous = await this.read()
      const hostId = await this.hostId()
      const started = await this.auth.beginAuthorization({
        previous,
        hostId,
        signal: controller.signal,
        onRegistration: async clientId => {
          // Persist the issued registration before the one-time code is
          // exchanged, so a failed exchange does not register a second app.
          await this.write({
            ...previous ?? {},
            version: 1,
            extAgentHostId: hostId,
            clientId,
            ...typeof previous?.subject === 'string' ? { subject: previous.subject } : {},
            status: 'reauth_required',
            savedAt: new Date().toISOString(),
          })
        },
      })
      attempt.url = started.url
      void started.completion
        .then(async connection => {
          await this.write(connection)
          this.catalog = { key: undefined, fetchedAt: 0, models: [], error: undefined }
          this.lastSignInError = undefined
          this.logger?.info?.('chatgpt: signed in')
          settle({ ok: true })
        })
        .catch(error => {
          const failure = error instanceof ChatGptError ? error : new ChatGptError('unknown', error instanceof Error ? error.message : String(error))
          attempt.error = { code: failure.code, message: failure.message }
          this.lastSignInError = attempt.error
          if (failure.code !== CODES.cancelled) this.logger?.warn?.(`chatgpt: sign-in failed (${failure.code}): ${failure.message}`)
          settle({ ok: false, error: attempt.error })
        })
      return { url: started.url, browserOpened: started.browserOpened, done }
    } catch (error) {
      const failure = error instanceof ChatGptError ? error : new ChatGptError('unknown', error instanceof Error ? error.message : String(error))
      this.lastSignInError = { code: failure.code, message: failure.message }
      settle({ ok: false, error: this.lastSignInError })
      throw error
    }
  }

  /**
   * Wait for the running sign-in attempt, when there is one.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ ok: true } | { ok: false, error: { code: string, message: string } }>} the settlement.
   */
  async waitForSignIn(signal) {
    const attempt = this.attempt
    if (attempt === undefined) {
      const connection = await this.read()
      if (connection?.status === 'connected') return { ok: true }
      return { ok: false, error: this.lastSignInError ?? { code: CODES.cancelled, message: 'No ChatGPT sign-in is running.' } }
    }
    const done = new Promise(resolve => {
      const previous = attempt.resolveDone
      attempt.resolveDone = value => {
        previous(value)
        resolve(value)
      }
    })
    if (signal === undefined) return done
    return await Promise.race([
      done,
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new ChatGptError(CODES.cancelled, 'Sign-in was cancelled.'))
          return
        }
        signal.addEventListener('abort', () => reject(new ChatGptError(CODES.cancelled, 'Sign-in was cancelled.')), { once: true })
      }),
    ])
  }

  /**
   * Withdraw a running sign-in attempt.
   * @returns {boolean} whether an attempt was running.
   */
  cancelSignIn() {
    const attempt = this.attempt
    if (attempt === undefined) return false
    attempt.controller.abort()
    return true
  }

  /**
   * Sign out: revoke the renewable session when possible, then forget it.
   * @returns {Promise<{ revoked: 'revoked' | 'unconfirmed' }>} the revocation outcome.
   */
  async signOut() {
    this.cancelSignIn()
    const connection = await this.read()
    let revoked = 'unconfirmed'
    if (connection !== undefined) {
      revoked = await this.auth.revoke({ connection })
      if (revoked !== 'revoked') {
        this.logger?.warn?.('chatgpt: local credentials removed, remote revocation unconfirmed')
      }
    }
    await this.clear()
    return { revoked }
  }

  /**
   * Refresh the stored grant, serializing concurrent refreshes.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, unknown>>} the refreshed connection.
   */
  refresh(signal) {
    this.refreshPromise ??= (async () => {
      const connection = await this.read()
      if (connection === undefined || typeof connection.refreshToken !== 'string') {
        throw new ChatGptError(CODES.not_signed_in, 'ChatGPT is not signed in. Open Settings > ChatGPT and sign in.')
      }
      let refreshed
      try {
        refreshed = await this.auth.refresh({
          connection,
          signal: signal ?? new AbortController().signal,
          persistRotation: async checkpoint => {
            await this.write(checkpoint)
          },
        })
      } catch (error) {
        if (requiresSignIn(error)) {
          await this.write({ ...connection, status: 'reauth_required', savedAt: new Date().toISOString() })
        }
        throw error
      }
      await this.write(refreshed)
      this.catalog = { key: undefined, fetchedAt: 0, models: [], error: undefined }
      return refreshed
    })().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  /**
   * Resolve a usable access token, refreshing near expiry.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<string>} bearer token.
   */
  async accessToken(signal) {
    const connection = await this.read()
    if (connection === undefined) {
      throw new ChatGptError(CODES.not_signed_in, 'ChatGPT is not signed in. Open Settings > ChatGPT and sign in.')
    }
    if (connection.status === 'reauth_required') {
      throw new ChatGptError(CODES.not_signed_in, 'The ChatGPT connection has expired. Sign in again in Settings > ChatGPT.')
    }
    const expiresAt = Number(connection.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt - REFRESH_SKEW_MS > Date.now()) {
      if (typeof connection.accessToken === 'string' && connection.accessToken !== '') return connection.accessToken
    }
    try {
      const refreshed = await this.refresh(signal)
      if (typeof refreshed.accessToken !== 'string' || refreshed.accessToken === '') {
        throw new ChatGptError(CODES.not_signed_in, 'ChatGPT is not signed in. Open Settings > ChatGPT and sign in.')
      }
      return refreshed.accessToken
    } catch (error) {
      // A still-valid token survives a failed refresh attempt.
      if (typeof connection.accessToken === 'string' && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        this.logger?.warn?.('chatgpt: refresh failed while the access token is still valid; using it')
        return connection.accessToken
      }
      throw error
    }
  }

  /**
   * Fetch through the account, retrying once after a 401.
   * @param {string} url - absolute URL.
   * @param {RequestInit} init - fetch options without authorization.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Response>} the provider response.
   */
  async authorizedFetch(url, init, signal) {
    let token = await this.accessToken(signal)
    const once = async bearer => fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${bearer}` },
      redirect: 'error',
      ...signal === undefined ? {} : { signal },
    })
    let response
    try {
      response = await once(token)
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new ChatGptError(CODES.network_error, 'Could not reach ChatGPT. Check your connection and try again.', { retryable: true, cause: error })
    }
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => undefined)
    token = (await this.refresh(signal)).accessToken
    if (typeof token !== 'string' || token === '') {
      throw new ChatGptError(CODES.not_signed_in, 'ChatGPT is not signed in. Open Settings > ChatGPT and sign in.')
    }
    return once(token)
  }

  /**
   * List the account's models, cached for `modelCacheSeconds`.
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - cache control.
   * @returns {Promise<Array<{ id: string, name: string, contextWindow?: number, maxTokens?: number, reasoningEfforts?: string[] }>>} advertised models.
   */
  async listModels({ force = false, signal } = {}) {
    const configured = Array.isArray(this.config.models) ? this.config.models : []
    if (configured.length > 0) {
      return configured.map(entry => ({
        id: entry.id,
        name: entry.name ?? entry.id,
        ...Number.isFinite(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {},
        ...Number.isFinite(entry.maxTokens) ? { maxTokens: entry.maxTokens } : {},
        ...Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0 ? { reasoningEfforts: entry.reasoningEfforts } : {},
      }))
    }
    const connection = await this.read()
    const cacheKey = connection === undefined ? 'anonymous' : `${connection.clientId}:${connection.subject}`
    const fresh = this.catalog.key === cacheKey && Date.now() - this.catalog.fetchedAt < this.config.modelCacheSeconds * 1000
    if (!force && fresh && this.catalog.models.length > 0) return this.catalog.models
    try {
      const response = await this.authorizedFetch(`${this.config.apiBaseURL}/models`, { headers: { accept: 'application/json' } }, signal)
      const body = await jsonBody(response)
      if (!response.ok) throw apiError(body, response.status, response.headers.get('x-request-id'))
      const list = body !== null && typeof body === 'object' && Array.isArray(body.models)
        ? body.models
        : body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : undefined
      if (list === undefined) {
        throw new ChatGptError(CODES.invalid_model_catalog, 'ChatGPT returned an unexpected model catalog. Try again.', { retryable: true, status: response.status })
      }
      const seen = new Set()
      const models = []
      for (const entry of list) {
        const model = normalizeModel(entry)
        if (model === undefined || seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
      }
      this.catalog = { key: cacheKey, fetchedAt: Date.now(), models, error: undefined }
      return models
    } catch (error) {
      const failure = error instanceof ChatGptError ? error : new ChatGptError('unknown', error instanceof Error ? error.message : String(error))
      this.catalog = { ...this.catalog, error: { code: failure.code, message: failure.message } }
      if (this.catalog.models.length > 0 && this.catalog.key === cacheKey) {
        this.logger?.warn?.('chatgpt: model listing failed; serving the cached catalog')
        return this.catalog.models
      }
      throw failure
    }
  }

  /**
   * Resolve one model's metadata, preferring the configured catalog, then the
   * listed one, then the route's capacity fallbacks.
   * @param {string} model - exact model id.
   * @returns {Promise<{ id: string, name: string, contextWindow: number, maxTokens?: number, reasoningEfforts?: string[] }>} metadata.
   */
  async resolveModel(model) {
    const configured = (Array.isArray(this.config.models) ? this.config.models : []).find(entry => entry.id === model)
    const listed = configured === undefined
      ? (this.catalog.models.find(entry => entry.id === model) ?? (await this.listModels().catch(() => [])).find(entry => entry.id === model))
      : undefined
    const chosen = configured ?? listed
    const efforts = chosen?.reasoningEfforts
      ?? (Array.isArray(this.config.reasoningEfforts) && this.config.reasoningEfforts.length > 0 ? this.config.reasoningEfforts : undefined)
    return {
      id: model,
      name: chosen?.name ?? model,
      contextWindow: Number.isFinite(chosen?.contextWindow) ? chosen.contextWindow : this.config.defaultContextWindow,
      ...Number.isFinite(chosen?.maxTokens) ? { maxTokens: chosen.maxTokens } : {},
      ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    }
  }

  /**
   * The configuration surface's view of this connection. Safe to send to a
   * renderer: no token, id token, or refresh token crosses this boundary.
   * @param {{ models?: boolean }} [options] - whether to include the catalog.
   * @returns {Promise<Record<string, unknown>>} view state.
   */
  async state({ models = true } = {}) {
    const connection = await this.read()
    const attempt = this.attempt
    const base = {
      provider: 'chatgpt',
      endpoint: this.config.apiBaseURL,
      settingsRoute: `${API_PREFIX}/state`,
    }
    if (connection === undefined && attempt === undefined) {
      return {
        ...base,
        status: 'signed-out',
        signedIn: false,
        account: null,
        plan: null,
        ...this.lastSignInError === undefined ? {} : { error: this.lastSignInError },
      }
    }
    if (connection?.status === 'reauth_required') {
      return {
        ...base,
        status: 'reauth-required',
        signedIn: false,
        account: { email: connection.email ?? null, name: connection.name ?? null },
        plan: { sharing: Array.isArray(connection.scopes) && connection.scopes.includes(PLAN_SCOPE) },
        error: { code: 'reauth_required', message: 'The ChatGPT connection expired. Sign in again.' },
      }
    }
    const scopes = Array.isArray(connection?.scopes) ? connection.scopes : []
    const result = {
      ...base,
      status: attempt === undefined ? 'signed-in' : 'pending',
      signedIn: connection !== undefined,
      account: { email: connection?.email ?? null, name: connection?.name ?? null },
      plan: { sharing: scopes.includes(PLAN_SCOPE) },
      expiresAt: Number.isFinite(connection?.expiresAt) ? new Date(Number(connection.expiresAt)).toISOString() : null,
      savedAt: typeof connection?.savedAt === 'string' ? connection.savedAt : null,
      ...attempt?.url === undefined ? {} : { pendingUrl: attempt.url },
      ...attempt?.error === undefined ? {} : { error: attempt.error },
    }
    if (models) {
      try {
        result.models = (await this.listModels()).map(model => ({
          id: model.id,
          name: model.name,
          ...Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {},
        }))
      } catch (error) {
        const failure = error instanceof ChatGptError ? error : new ChatGptError('unknown', String(error))
        result.models = []
        result.modelsError = { code: failure.code, message: failure.message }
        if (requiresSignIn(failure)) {
          result.status = 'reauth-required'
          result.signedIn = false
          result.error = { code: failure.code, message: failure.message }
        }
      }
    }
    return result
  }

  /**
   * Dispose process-level state owned by the session.
   * @returns {void}
   */
  dispose() {
    this.cancelSignIn()
  }
}
