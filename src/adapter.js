/**
 * The harness LLM adapter for ChatGPT plan usage.
 *
 * It owns one provider route (`chatgpt`) and speaks exactly the wire the Sign
 * in with ChatGPT open-source flow documents: bearer OAuth access token against
 * `POST {apiBaseURL}/responses` with `store: false`, `stream: true`, system
 * guidance in `instructions`, and no fields that route rejects.
 *
 * The class implements the adapter contract structurally rather than extending
 * `@deepseek-ai/dsh-llm`'s base class: a bundle installed into a profile
 * resolves its own modules, not the harness installation's, and the contract
 * the registry consumes is method-shaped. Failures are raised as
 * `LlmRequestError`, whose own `code` and `failure` data properties the runtime
 * accepts from a cross-package copy.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PROVIDER } from './constants.js'
import { ChatGptError, CODES, LlmRequestError, apiError, toLlmError } from './errors.js'
import { buildBody, translate } from './wire.js'

/** Human labels for effort ids the provider may advertise. */
const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/**
 * One effort id as the picker renders it.
 * @param {string} id - provider effort id.
 * @returns {{ id: string, name: string }} effort metadata.
 */
function effort(id) {
  return { id, name: EFFORT_LABELS[id] ?? id }
}

/**
 * The `User-Agent` the harness's own adapters send. The running version is read
 * from the installation when it is reachable; the product token and URL are
 * always sent, so attribution cannot be lost.
 * @returns {string} user-agent value.
 */
function userAgent() {
  let version = ''
  try {
    const installDir = process.env.DSH_INSTALL_DIR
    if (typeof installDir === 'string' && installDir !== '') {
      const manifest = JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version !== '') version = `/${manifest.version}`
    }
  } catch {
    // A composition that cannot read its own manifest still identifies itself.
  }
  const suffix = typeof process.env.DSH_USER_AGENT_SUFFIX === 'string' ? process.env.DSH_USER_AGENT_SUFFIX.trim() : ''
  return `deepseek-harness${version} (+https://github.com/deepseek-ai/deepseek-harness)${suffix === '' ? '' : ` ${suffix}`}`
}

/**
 * The ChatGPT plan-usage adapter.
 */
export class ChatGptAdapter {
  /**
   * @param {object} options - adapter options.
   * @param {import('./session.js').ChatGptSession} options.session - the account connection.
   * @param {object} options.config - resolved plugin configuration.
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Host context providing `attachments` and `llm`.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger] - safe diagnostics.
   */
  constructor({ session, config, ctx, logger }) {
    this.session = session
    this.config = config
    this.ctx = ctx
    this.logger = logger
    this.attribution = { 'user-agent': userAgent() }
  }

  /**
   * Describe this route.
   * @param {string} _provider - owned route.
   * @returns {{ id: string, name: string }} display metadata.
   */
  providerInfo(_provider) {
    return { id: PROVIDER, name: 'ChatGPT' }
  }

  /**
   * No provider-owned retry policy: the harness's default applies.
   * @param {string} _provider - owned route.
   * @returns {undefined} the default policy.
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * No provider-side image pricing is declared.
   * @param {string} _provider - owned route.
   * @param {string} _model - model id.
   * @returns {undefined} no declared pricing.
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * The image projection this adapter sends: the normalized image unchanged.
   * @param {string} _provider - owned route.
   * @param {string} _model - model id.
   * @param {{ width: number, height: number, bytes: number }} image - normalized reference.
   * @returns {{ width: number, height: number, maxBytes: number }} request target.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * Declared input modalities for one model.
   * @param {string} model - exact model id.
   * @returns {Array<'text' | 'image'>} modalities this route claims.
   */
  #inputModalities(model) {
    const configured = (Array.isArray(this.config.models) ? this.config.models : []).find(entry => entry.id === model)
    const input = Array.isArray(configured?.input) ? configured.input : this.config.defaultInput
    const values = Array.isArray(input) ? input.filter(value => value === 'text' || value === 'image') : []
    return values.length > 0 ? values : ['text']
  }

  /**
   * Project one image attachment into a Responses image part.
   * @param {any} block - harness image block.
   * @param {string} model - exact model id.
   * @param {AbortSignal | undefined} signal - request cancellation.
   * @returns {Promise<{ type: 'input_image', image_url: string } | undefined>} the part.
   */
  async #imagePart(block, model, signal) {
    const attachments = this.ctx.get('attachments')
    const ref = block?.attachment
    if (attachments === undefined || ref === undefined) {
      throw new LlmRequestError('ChatGPT image input needs the attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (!this.#inputModalities(model).includes('image')) {
      throw new LlmRequestError(`ChatGPT model "${model}" is configured as text-only; enable image input in the model's settings`, 'UNSUPPORTED_CONTENT')
    }
    const target = this.imageRequestTarget(PROVIDER, model, ref)
    const image = await attachments.readImageRequest(ref, target, signal)
    const base64 = Buffer.from(image.data).toString('base64')
    return { type: 'input_image', image_url: `data:${image.mediaType};base64,${base64}` }
  }

  /**
   * The deterministic handle text a file block contributes.
   * @param {any} block - harness file block.
   * @returns {string} handle text.
   */
  #fileText(block) {
    try {
      return this.ctx.llm.fileRequestText(block.attachment)
    } catch {
      const name = typeof block?.attachment?.name === 'string' ? block.attachment.name : 'file'
      return `[attachment: ${name}]`
    }
  }

  /**
   * Advertise the signed-in account's models.
   * @param {string} _provider - owned route.
   * @returns {Promise<Array<Record<string, unknown>>>} model metadata.
   */
  async listModels(_provider) {
    let models
    try {
      models = await this.session.listModels()
    } catch (error) {
      // A catalog that cannot load is not a routing failure: the picker simply
      // shows nothing until the account answers.
      this.logger?.debug?.('chatgpt: model listing unavailable: %s', error instanceof Error ? error.message : String(error))
      return []
    }
    return models.map(model => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: this.#inputModalities(model.id),
    }))
  }

  /**
   * Resolve one model's metadata for validation and the picker.
   * @param {string} _provider - owned route.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, unknown>>} resolved metadata.
   */
  async resolveModel(_provider, model, signal) {
    const resolved = await this.session.resolveModel(model)
    signal?.throwIfAborted()
    const efforts = Array.isArray(resolved.reasoningEfforts) ? resolved.reasoningEfforts : []
    return {
      provider: PROVIDER,
      id: model,
      name: resolved.name,
      context: { contextWindow: resolved.contextWindow },
      inputModalities: this.#inputModalities(model),
      ...efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map(effort) } },
    }
  }

  /**
   * Bind exact model metadata to the eventual dispatch.
   * @param {string} provider - owned route.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ model: Record<string, unknown>, stream: (options: any) => AsyncIterable<any> }>} the prepared call.
   */
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }

  /**
   * Stream one Responses call as harness chunks.
   * @param {any} options - the assembled request.
   * @returns {AsyncIterable<Record<string, unknown>>} harness chunks.
   */
  async *stream(options) {
    if (Array.isArray(options.stop) && options.stop.length > 0) {
      throw new LlmRequestError('ChatGPT plan usage does not accept stop sequences on this route', 'UNSUPPORTED_OPTION')
    }
    const model = options.model
    let body
    try {
      body = await buildBody({
        model,
        messages: options.messages,
        system: options.system,
        tools: options.tools,
        reasoningEffort: options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      }, {
        imagePart: block => this.#imagePart(block, model, options.signal),
        fileText: block => this.#fileText(block),
      })
    } catch (error) {
      throw toLlmError(error)
    }

    // One deadline for the whole exchange: headers and body. The route holds a
    // stream open for the duration of the answer, so a stalled socket must not
    // outlive the configured bound.
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    let response
    try {
      response = await this.session.authorizedFetch(`${this.config.apiBaseURL}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...this.attribution,
        },
        body: JSON.stringify(body),
      }, signal)
    } catch (error) {
      throw toLlmError(error)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text.slice(0, 400)
      }
      throw toLlmError(apiError(parsed, response.status, response.headers.get('x-request-id')))
    }
    try {
      yield* translate(response, {
        signal,
        ...this.config.trace === true ? { onEvent: event => this.logger?.debug?.('chatgpt: event %s', event.type) } : {},
      })
    } catch (error) {
      throw toLlmError(signal.aborted ? signal.reason : error)
    }
  }
}

/**
 * Whether a failure is one only a fresh sign-in can fix.
 * @param {unknown} error - candidate failure.
 * @returns {boolean} true for grant failures.
 */
export function isSignInFailure(error) {
  return error instanceof ChatGptError && error.code === CODES.not_signed_in
}
