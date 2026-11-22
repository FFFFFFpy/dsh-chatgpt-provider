/**
 * Errors raised inside the bundle.
 *
 * `ChatGptError` carries the machine code, HTTP status, and request id a
 * sign-in or inference failure came with, so both the settings page and the
 * adapter can report them without inventing a second vocabulary.
 *
 * `LlmRequestError` is the adapter boundary's shape. It deliberately mirrors
 * the harness's own typed error: the LLM runtime normalizes a cross-package
 * failure by trusting an error's own `code` and `failure` data properties, so
 * a plugin that ships its own copy of the class keeps its stable codes without
 * importing a second copy of `@deepseek-ai/dsh-llm`.
 */

/** Codes this bundle can produce, most of them minted from an OAuth or API reply. */
export const CODES = Object.freeze({
  cancelled: 'cancelled',
  configuration: 'configuration',
  discovery_failed: 'discovery_failed',
  browser_unavailable: 'browser_unavailable',
  callback_failed: 'callback_failed',
  callback_port_unavailable: 'callback_port_unavailable',
  registration_incomplete: 'registration_incomplete',
  invalid_token_response: 'invalid_token_response',
  invalid_id_token: 'invalid_id_token',
  identity_verification_unavailable: 'identity_verification_unavailable',
  account_mismatch: 'account_mismatch',
  invalid_model_catalog: 'invalid_model_catalog',
  invalid_stream: 'invalid_stream',
  response_incomplete: 'response_incomplete',
  stream_interrupted: 'stream_interrupted',
  network_error: 'network_error',
  not_signed_in: 'not_signed_in',
  refresh_failed: 'refresh_failed',
  revoke_failed: 'revoke_failed',
  unknown: 'unknown',
})

/** One failure with a stable code plus the provider facts worth preserving. */
export class ChatGptError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable summary; never contains a token.
   * @param {object} [options] - optional provider facts.
   * @param {boolean} [options.retryable] - whether a bounded retry may succeed.
   * @param {number} [options.status] - HTTP status when one was received.
   * @param {string} [options.requestId] - provider request id when present.
   * @param {string} [options.param] - provider field that failed validation.
   * @param {unknown} [options.cause] - underlying error.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChatGptError'
    this.code = code
    this.retryable = options.retryable === true
    if (options.status !== undefined) this.status = options.status
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.param !== undefined) this.param = options.param
  }
}

/**
 * The adapter's typed failure. Own `code` and `failure` data properties are
 * what the runtime reads; `failure` must stay a non-empty message plus code.
 */
export class LlmRequestError extends Error {
  /**
   * @param {string} message - human-readable summary without credentials.
   * @param {string} code - stable provider-neutral code.
   * @param {object} [options] - optional facts.
   * @param {number} [options.status] - provider HTTP status.
   * @param {number} [options.providerRetryAfterMs] - provider-requested delay.
   * @param {string} [options.requestId] - provider request id.
   * @param {unknown} [options.cause] - underlying error.
   */
  constructor(message, code, options = {}) {
    super(message.length > 0 ? message : 'LLM adapter failed', options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmRequestError'
    this.code = code
    this.failure = {
      message: message.length > 0 ? message : 'LLM adapter failed',
      code,
      ...Number.isInteger(options.status) && options.status >= 100 && options.status <= 599 ? { status: options.status } : {},
      ...Number.isFinite(options.providerRetryAfterMs) && options.providerRetryAfterMs > 0 ? { providerRetryAfterMs: options.providerRetryAfterMs } : {},
      ...typeof options.requestId === 'string' && options.requestId !== '' ? { requestId: options.requestId } : {},
    }
  }
}

/**
 * Read an error body without assuming the API's usual `error` object: the
 * direct route can answer `{"detail": "..."}` before admission.
 * @param {unknown} body - parsed JSON body, or raw text when unparsable.
 * @returns {{ code?: string, message: string, param?: string }} normalized fields.
 */
export function errorShape(body) {
  if (typeof body === 'string') return { message: body.slice(0, 400) }
  if (body === null || typeof body !== 'object') return { message: 'The request failed.' }
  const error = body.error
  if (typeof error === 'string') return { code: error, message: error }
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : undefined
    const param = typeof error.param === 'string' ? error.param : undefined
    const message = typeof error.message === 'string' ? error.message : (code ?? 'The request failed.')
    return { ...code === undefined ? {} : { code }, ...param === undefined ? {} : { param }, message }
  }
  if (typeof body.detail === 'string') return { message: body.detail }
  if (typeof body.message === 'string') return { message: body.message }
  return { message: 'The request failed.' }
}

/**
 * Build a `ChatGptError` from an HTTP failure.
 * @param {unknown} body - parsed body or text.
 * @param {number} status - HTTP status.
 * @param {string | null} [requestId] - provider request id header.
 * @returns {ChatGptError} the classified failure.
 */
export function apiError(body, status, requestId) {
  const shape = errorShape(body)
  const unavailable = shape.code === 'subscription_sharing_usage_unavailable' || shape.code === 'subscription_sharing_user_unavailable'
  const retryable = shape.code !== 'subscription_sharing_usage_limit_exceeded' && (unavailable || status === 429 || status >= 500)
  return new ChatGptError(shape.code ?? `http_${status}`, shape.message, {
    retryable,
    status,
    param: shape.param,
    ...requestId === null || requestId === undefined ? {} : { requestId },
  })
}

/** Provider error codes whose recovery the Sign in with ChatGPT documentation names. */
const SIGN_IN_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

/**
 * Whether a failure means the stored grant is unusable and the human must sign
 * in again, rather than a transient outage.
 * @param {unknown} error - candidate failure.
 * @returns {boolean} true when only a fresh sign-in can recover.
 */
export function requiresSignIn(error) {
  return error instanceof ChatGptError && SIGN_IN_CODES.has(error.code)
}

/**
 * Convert a bundle failure into the LLM contract's typed error.
 * @param {unknown} error - candidate failure.
 * @returns {LlmRequestError} the provider-neutral error the agent loop routes on.
 */
export function toLlmError(error) {
  if (error instanceof LlmRequestError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new LlmRequestError('The ChatGPT request was cancelled.', 'ABORTED', { cause: error })
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new LlmRequestError('The ChatGPT request timed out. Try again, or raise requestTimeoutMs.', 'TIMEOUT', { cause: error })
  }
  const failure = error instanceof ChatGptError
    ? error
    : new ChatGptError(CODES.unknown, error instanceof Error ? error.message : String(error))
  const status = failure.status
  const code = failure.code
  const providerCode = code === `http_${status}` ? undefined : code
  const detail = providerCode === undefined || failure.message === providerCode ? failure.message : `${failure.message} [${providerCode}]`
  const requestId = typeof failure.requestId === 'string' ? failure.requestId : undefined

  if (code === CODES.not_signed_in) {
    return new LlmRequestError(failure.message, 'ACCOUNT_SIGN_IN_REQUIRED', { cause: failure, status, requestId })
  }
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return new LlmRequestError(`${detail} Manage ChatGPT usage at https://chatgpt.com/settings/usage`, 'QUOTA', { cause: failure, status, requestId })
  }
  if (code === 'subscription_sharing_user_not_eligible' || code === 'subscription_sharing_route_not_supported' || code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') {
    return new LlmRequestError(`${detail} The signed-in account cannot use ChatGPT plan usage for this request.`, 'AUTH', { cause: failure, status, requestId })
  }
  if (code === 'sharing_not_enabled') return new LlmRequestError(detail, 'AUTH', { cause: failure, status, requestId })
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || code === CODES.identity_verification_unavailable || code === 'refresh_not_ready') {
    return new LlmRequestError(detail, 'SERVER', { cause: failure, status, requestId })
  }
  if (code === 'subscription_sharing_unsupported_capability') {
    return new LlmRequestError(failure.param ? detail + ' (' + failure.param + ')' : detail, 'UNSUPPORTED_OPTION', { cause: failure, status, requestId })
  }
  if (code === 'context_length_exceeded' || code === 'string_above_max_length' || /context (window|length)/i.test(failure.message)) {
    return new LlmRequestError(detail, 'CONTEXT_WINDOW_EXCEEDED', { cause: failure, status, requestId })
  }
  if (code === 'subscription_sharing_invalid_user' || status === 401) {
    return new LlmRequestError(`${detail} Check the selected ChatGPT account, workspace and granted permissions.`, 'AUTH', { cause: failure, status, requestId })
  }
  if (status === 403) {
    return new LlmRequestError(detail, 'AUTH', { cause: failure, status, requestId })
  }
  if (status === 429) {
    return new LlmRequestError(detail, 'RATE_LIMIT', { cause: failure, status, requestId })
  }
  if (status !== undefined && status >= 500) {
    return new LlmRequestError(detail, 'SERVER', { cause: failure, status, requestId })
  }
  if (failure.code === CODES.network_error || failure.code === CODES.stream_interrupted) {
    return new LlmRequestError(detail, 'TRANSPORT', { cause: failure, requestId })
  }
  if (failure.code === CODES.invalid_stream) {
    return new LlmRequestError(detail, 'STREAM_CLOSED', { cause: failure, requestId })
  }
  if (code === 'content_filter' || code === 'content_policy_violation') {
    return new LlmRequestError(detail, 'CONTENT_REFUSED', { cause: failure, status, requestId })
  }
  if (status !== undefined && status >= 400) {
    return new LlmRequestError(detail, `HTTP_${status}`, { cause: failure, status, requestId })
  }
  return new LlmRequestError(detail, 'UNKNOWN', { cause: failure, requestId })
}
