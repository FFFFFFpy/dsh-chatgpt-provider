/**
 * Saved ChatGPT registrations and the active connection used by the settings
 * page and the model adapter.
 *
 * The credential store is the only writer: the sign-in flow and the refresher
 * both commit through `modifyRecord`, so a rotation is durable before it is
 * used and a second process cannot race a rotating refresh token.
 */
import { randomUUID } from 'node:crypto'
import { API_PREFIX } from './constants.js'
import { ChatGPTAuth } from './oauth.js'
import { ProfileStore, putProfile, withoutCredentials } from './profiles.js'
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
  if (entry.visibility !== 'list') return undefined
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

const activeProfile = state => state.profiles.find(profile => profile.clientId === state.activeId)
const hasPlan = profile => ChatGPTAuth.planUsageGranted(profile.scopes)
const sharingDisabled = () => new ChatGptError('sharing_not_enabled', 'Enable ChatGPT plan usage in Settings > ChatGPT.')

/** Replace the previous token set together, including optional expiry and ID-token fields. */
function applyRotation(profile, rotation) {
  const { pendingRefresh, earliestRefreshAt, ...prior } = profile
  const { receivedAt, idToken, ...fields } = rotation
  return { ...prior, ...fields, ...(idToken ? { idToken } : {}), savedAt: new Date().toISOString() }
}

/** The live ChatGPT connection for this deployment. */
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
    this.profiles = new ProfileStore(ctx.credentials, auth.authBaseURL, auth.apiBaseURL)
    this.key = this.profiles.key
    this.requests = new AbortController()
    this.catalog = { key: undefined, fetchedAt: 0, models: [] }
    this.hostIdPromise = undefined
    this.disconnecting = false
  }

  /** The selected session ends on sign-out. Its reusable registration stays in the profile store. */
  async read() {
    const selected = activeProfile(await this.profiles.read())
    return selected?.status === 'disconnected' ? undefined : selected
  }

  resetRequests() {
    this.requests.abort()
    this.requests = new AbortController()
    this.catalog = { key: undefined, fetchedAt: 0, models: [] }
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

  async beginSignIn({ clientId, newProfile = false, reconsent = false, signal } = {}) {
    if (this.attempt || this.disconnecting) throw new ChatGptError('already_running', 'A ChatGPT connection change is already in progress.')
    const controller = new AbortController()
    const attemptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), this.config.signInTimeoutMs)
    const attempt = { controller, url: undefined }
    this.attempt = attempt
    this.lastSignInError = undefined
    const finish = error => {
      clearTimeout(timer)
      controller.abort()
      if (this.attempt === attempt) this.attempt = undefined
      if (!error) return { ok: true }
      if (attemptSignal.aborted && error.name === 'AbortError') error = new ChatGptError(CODES.cancelled, 'Sign-in was cancelled.')
      const detail = { code: error.code ?? 'unknown', message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) }
      if (detail.code !== CODES.cancelled) this.lastSignInError = detail
      return { ok: false, error: detail }
    }
    try {
      const saved = await this.profiles.read()
      const id = clientId ?? saved.activeId
      const previous = newProfile ? undefined : saved.profiles.find(entry => entry.clientId === id) ??
        (!id && saved.profiles.length === 1 ? saved.profiles[0] : undefined)
      if (clientId && !previous) throw new ChatGptError('profile_not_found', 'Select a saved ChatGPT account.')
      const hostId = previous?.extAgentHostId ?? await this.hostId()
      const started = await this.auth.beginAuthorization({
        previous, hostId, signal: attemptSignal, reconsent,
        onRegistration: async issued => {
          if (previous) return
          await this.profiles.edit(state => {
            attemptSignal.throwIfAborted()
            if (state.profiles.some(entry => entry.clientId === issued)) {
              throw new ChatGptError('profile_exists', 'This registration is already saved. Select its account to continue.')
            }
            putProfile(state, withoutCredentials({ clientId: issued, extAgentHostId: hostId }, 'registration_pending'))
            state.activeId ??= issued
            return true
          })
        },
      })
      attempt.url = started.url
      const done = started.completion.then(async connection => {
        await this.profiles.edit(state => {
          attemptSignal.throwIfAborted()
          const current = state.profiles.find(entry => entry.clientId === connection.clientId)
          if (!current || (previous && current.savedAt !== previous.savedAt)) {
            throw new ChatGptError('connection_changed', 'The ChatGPT connection changed during sign-in. Try again.')
          }
          putProfile(state, connection)
          state.activeId = connection.clientId
          return true
        })
        this.resetRequests()
        return finish()
      }).catch(finish)
      return { url: started.url, browserOpened: started.browserOpened, done }
    } catch (error) {
      finish(error)
      throw error
    }
  }

  cancelSignIn() {
    if (!this.attempt) return false
    this.attempt.controller.abort()
    return true
  }

  async selectProfile(clientId) {
    if (this.attempt || this.disconnecting) throw new ChatGptError('already_running', 'Finish the current connection change first.')
    await this.profiles.edit(state => {
      const profile = state.profiles.find(entry => entry.clientId === clientId)
      if (profile?.status !== 'connected') throw new ChatGptError(CODES.not_signed_in, 'Sign in to this account to use it.')
      state.activeId = clientId
      return true
    })
    this.lastSignInError = undefined
    this.resetRequests()
  }

  async acknowledgePlan(clientId) {
    await this.profiles.edit(state => {
      const profile = activeProfile(state)
      if (!profile || profile.clientId !== clientId || !hasPlan(profile) || state.welcomedSubjects.includes(profile.subject)) return false
      state.welcomedSubjects.push(profile.subject)
      return true
    })
  }

  async signOut() {
    if (this.disconnecting) throw new ChatGptError('already_running', 'Sign-out is already in progress.')
    this.disconnecting = true
    this.cancelSignIn()
    this.resetRequests()
    let revoked = 'no-session'
    try {
      const selected = await this.read()
      if (selected) await this.profiles.edit(async state => {
        const profile = state.profiles.find(entry => entry.clientId === selected.clientId)
        if (!profile || profile.status === 'disconnected') return false
        try {
          revoked = await this.auth.revoke({ connection: profile })
        } catch {
          revoked = 'unconfirmed'
        }
        putProfile(state, withoutCredentials(profile, 'disconnected'))
        return true
      })
      this.lastSignInError = undefined
      return { revoked }
    } finally {
      this.disconnecting = false
    }
  }

  /** Exchange and checkpoint under the host's writer lock. A separate commit promotes a verified rotation. */
  async refresh(signal, { expected, automatic = false } = {}) {
    expected ??= await this.read()
    signal?.throwIfAborted()
    const selected = state => {
      const profile = activeProfile(state)
      if (this.disconnecting || !profile || profile.status !== 'connected' || profile.clientId !== expected?.clientId) {
        throw new ChatGptError(CODES.not_signed_in, 'The selected ChatGPT account is no longer connected.')
      }
      return profile
    }
    let failure
    const invalidate = (state, profile, error) => {
      if (!requiresSignIn(error) && ![CODES.account_mismatch, CODES.invalid_id_token, CODES.invalid_token_response].includes(error.code)) throw error
      putProfile(state, withoutCredentials(profile, 'reauth_required'))
      failure = new ChatGptError(CODES.not_signed_in, `The ChatGPT connection can no longer be used (${error.code}). Sign in again.`, {
        cause: error, requestId: error.requestId, status: error.status,
      })
      return true
    }
    let saved = await this.profiles.edit(async state => {
      const current = selected(state)
      if (current.pendingRefresh || current.refreshToken !== expected.refreshToken) return false
      if (automatic && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return false
      if (!current.refreshToken) {
        if (hasPlan(current) && !(current.expiresAt > Date.now())) {
          return invalidate(state, current, new ChatGptError('invalid_grant', 'The non-renewable ChatGPT access has expired.'))
        }
        throw new ChatGptError('refresh_unavailable', 'This ChatGPT registration has no renewable access.')
      }
      const earliest = typeof current.earliestRefreshAt === 'number' ? current.earliestRefreshAt * 1000 : Date.parse(current.earliestRefreshAt)
      if (Date.now() < earliest) {
        if (automatic && current.expiresAt > Date.now()) return false
        throw new ChatGptError('refresh_not_ready', 'ChatGPT has not opened the refresh window yet.', { retryable: true })
      }
      let rotation
      try {
        signal?.throwIfAborted()
        rotation = await this.auth.refresh({ connection: current, signal: AbortSignal.timeout(45_000) })
      } catch (error) {
        if (automatic && error.retryable && !requiresSignIn(error) && current.expiresAt > Date.now()) return false
        return invalidate(state, current, error)
      }
      putProfile(state, rotation.idToken ? { ...current, pendingRefresh: rotation } : applyRotation(current, rotation))
      return true
    })
    if (failure) throw failure
    if (selected(saved).pendingRefresh) {
      saved = await this.profiles.edit(async state => {
        const current = selected(state)
        if (!current.pendingRefresh) return false
        try {
          const identity = await this.auth.verifyRotation(current, current.pendingRefresh, AbortSignal.timeout(30_000))
          putProfile(state, { ...applyRotation(current, current.pendingRefresh), ...identity })
          return true
        } catch (error) {
          return invalidate(state, current, error)
        }
      })
    }
    if (failure) throw failure
    signal?.throwIfAborted()
    return selected(saved)
  }

  async accessToken(signal, expectedId) {
    let profile = await this.read()
    if (this.disconnecting || !profile || profile.status !== 'connected' || (expectedId && profile.clientId !== expectedId)) {
      throw new ChatGptError(CODES.not_signed_in, 'Sign in to the selected account in Settings > ChatGPT.')
    }
    if (!hasPlan(profile)) throw sharingDisabled()
    const renewBy = Date.now() + (profile.refreshToken ? REFRESH_SKEW_MS : 0)
    if (profile.pendingRefresh || !(profile.expiresAt > renewBy)) {
      profile = await this.refresh(signal, { expected: profile, automatic: true })
    }
    if (!hasPlan(profile)) throw sharingDisabled()
    if (!profile.accessToken || !(profile.expiresAt > Date.now())) {
      throw new ChatGptError('refresh_not_ready', 'The ChatGPT token has expired. Retry to renew it.', { retryable: true })
    }
    signal?.throwIfAborted()
    return profile.accessToken
  }

  async authorizedFetch(url, init, signal, expectedId) {
    const root = this.auth.apiBaseURL
    if (url !== root + '/models' && url !== root + '/responses') {
      throw new ChatGptError(CODES.configuration, 'The request does not belong to the selected ChatGPT resource.')
    }
    signal = signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal
    const token = await this.accessToken(signal, expectedId)
    try {
      return await fetch(url, { ...init, headers: { ...init.headers, authorization: 'Bearer ' + token }, redirect: 'error', signal })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw new ChatGptError(CODES.network_error, 'Could not reach ChatGPT. Try again.', { retryable: true, cause: error })
    }
  }

  /**
   * List the account's models, cached for `modelCacheSeconds`.
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - cache control.
   * @returns {Promise<Array<{ id: string, name: string, contextWindow?: number, maxTokens?: number, reasoningEfforts?: string[] }>>} advertised models.
   */
  async listModels({ force = false, signal } = {}) {
    const connection = await this.read()
    if (connection?.status !== 'connected') throw new ChatGptError(CODES.not_signed_in, 'Sign in to ChatGPT to list models.')
    if (!hasPlan(connection)) throw sharingDisabled()
    const configured = Array.isArray(this.config.models) ? this.config.models : []
    if (configured.length > 0) {
      await this.accessToken(signal, connection.clientId)
      return configured.map(entry => ({
        id: entry.id,
        name: entry.name ?? entry.id,
        ...Number.isFinite(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {},
        ...Number.isFinite(entry.maxTokens) ? { maxTokens: entry.maxTokens } : {},
        ...Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0 ? { reasoningEfforts: entry.reasoningEfforts } : {},
      }))
    }
    const cacheKey = connection.clientId + ':' + connection.savedAt
    const fresh = this.catalog.key === cacheKey && Date.now() - this.catalog.fetchedAt < this.config.modelCacheSeconds * 1000
    if (!force && fresh && !connection.pendingRefresh && connection.expiresAt > Date.now() + REFRESH_SKEW_MS) return this.catalog.models
    try {
      const response = await this.authorizedFetch(this.auth.apiBaseURL + '/models', { headers: { accept: 'application/json' } }, signal ?? AbortSignal.timeout(30_000), connection.clientId)
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
      if (failure.retryable && this.catalog.key === cacheKey && this.catalog.models.length > 0) {
        const latest = await this.read()
        if (latest?.clientId === connection.clientId && latest.savedAt === connection.savedAt && !latest.pendingRefresh) {
          this.logger?.warn?.('chatgpt: model listing failed; serving the cached catalog')
          return this.catalog.models
        }
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
      ? (await this.listModels().catch(() => [])).find(entry => entry.id === model)
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

  async state({ models = true } = {}) {
    const saved = await this.profiles.read()
    const connection = activeProfile(saved)
    const attempt = this.attempt
    const signedIn = connection?.status === 'connected'
    const sharing = signedIn && hasPlan(connection)
    const result = {
      provider: 'chatgpt', endpoint: this.auth.apiBaseURL, settingsRoute: API_PREFIX + '/state',
      status: attempt ? 'pending' : signedIn ? 'signed-in' : connection?.status === 'reauth_required' ? 'reauth-required' : 'signed-out',
      signedIn, activeId: saved.activeId, renewable: !!(signedIn && connection.refreshToken),
      account: connection ? { name: connection.name ?? null, email: connection.email ?? null } : null,
      plan: connection ? { sharing } : null,
      welcome: !!(sharing && !connection.pendingRefresh && !saved.welcomedSubjects.includes(connection.subject)),
      profiles: saved.profiles.map(({ clientId, email, name, status }, index) => ({ clientId, email, name, status, number: index + 1 })),
      expiresAt: Number.isFinite(connection?.expiresAt) ? new Date(connection.expiresAt).toISOString() : null,
      savedAt: connection?.savedAt ?? null,
      ...attempt?.url ? { pendingUrl: attempt.url } : {},
      ...this.lastSignInError ? { error: this.lastSignInError } : {},
    }
    if (!models || attempt || !sharing) return result
    let catalog = []
    let modelsError
    try {
      catalog = (await this.listModels()).map(({ id, name, contextWindow }) => ({ id, name, contextWindow }))
    } catch (error) {
      modelsError = { code: error.code ?? 'unknown', message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) }
    }
    // Refresh or a switch during discovery can change which account, scope and expiry the page should show.
    const latest = await this.state({ models: false })
    if (latest.activeId !== saved.activeId || latest.status === 'pending') return latest
    return { ...latest, models: latest.plan?.sharing ? catalog : [], ...(modelsError ? { modelsError } : {}) }
  }

  dispose() {
    this.cancelSignIn()
    this.resetRequests()
  }
}
