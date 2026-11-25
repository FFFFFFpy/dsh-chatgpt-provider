/**
 * Conversion between the harness's provider-neutral request and the Responses
 * API shape this route accepts, plus translation of its event stream back into
 * harness chunks.
 *
 * The route has documented requirements that shape everything here: send
 * `store: false` and `stream: true`, carry system guidance as a leading
 * developer message inside `input` (never a `system` role item, and never the
 * top-level `instructions` field, which is appended after `input` from GPT-6.2
 * on and always billed as uncached input), and omit `temperature`, `top_p`,
 * `max_output_tokens`, `metadata`, `truncation`, `user`, and
 * `previous_response_id`.
 */
import { createHash } from 'node:crypto'
import { ChatGptError, CODES, apiError, toLlmError } from './errors.js'

const TOOL_NAMESPACE = 'dsh'

/** Block types this adapter emits, in the order their block-start opened. */
const BLOCK = { text: 'text', reasoning: 'reasoning', toolCall: 'tool-call' }

/**
 * Collect the text of one content array.
 * @param {readonly any[]} content - harness content blocks.
 * @returns {string} concatenated text.
 */
function joinText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Build one user-message part list.
 * @param {readonly any[]} content - harness content blocks.
 * @param {(block: any) => Promise<{ type: 'input_image', image_url: string } | undefined>} imagePart - image projection.
 * @param {(block: any) => string} fileText - verbatim file handle text.
 * @returns {Promise<string | any[]>} string content when text-only, else item parts.
 */
async function userContent(content, imagePart, fileText) {
  const parts = []
  let textOnly = true
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') parts.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      const part = await imagePart(block)
      if (part !== undefined) {
        parts.push(part)
        textOnly = false
      }
      continue
    }
    if (block?.type === 'file') {
      parts.push({ type: 'input_text', text: fileText(block) })
      continue
    }
    if (block?.type === 'reasoning') continue
  }
  if (parts.length === 0) parts.push({ type: 'input_text', text: '' })
  if (textOnly) return parts.map(part => part.text).join('\n')
  return parts
}

/**
 * Convert harness history into Responses `input` items.
 * @param {readonly any[]} messages - request messages.
 * @param {object} projectors - content projections.
 * @param {(block: any) => Promise<{ type: 'input_image', image_url: string } | undefined>} projectors.imagePart - image projection.
 * @param {(block: any) => string} projectors.fileText - file handle text.
 * @returns {Promise<any[]>} input items in order.
 */
export async function toInput(messages, projectors) {
  const items = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = joinText(message.content)
      if (text !== '') items.push({ role: 'developer', content: text })
      continue
    }
    if (message.role === 'user') {
      items.push({ role: 'user', content: await userContent(message.content, projectors.imagePart, projectors.fileText) })
      continue
    }
    if (message.role === 'tool') {
      let output = await userContent(message.content, projectors.imagePart, projectors.fileText)
      if (message.isError === true) {
        if (Array.isArray(output)) output.unshift({ type: 'input_text', text: '[error]' })
        else output = '[error] ' + output
      }
      items.push({
        type: 'function_call_output',
        call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
        namespace: TOOL_NAMESPACE,
        output,
      })
      continue
    }
    if (message.role === 'assistant') {
      const text = joinText(message.content)
      if (text !== '') items.push({ role: 'assistant', content: text })
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'tool-call') {
          items.push({
            type: 'function_call',
            namespace: TOOL_NAMESPACE,
            call_id: String(block.id),
            name: block.name,
            arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
          })
        }
      }
    }
  }
  return items
}

/**
 * Derive the cache-routing key one request carries.
 *
 * The key does not change the prompt; it keeps a conversation's requests on the
 * same cache population. Without it the plan route load-balances each request
 * across machines with different cached prefixes, so an identical prefix hits
 * one machine at ~95% and another at 0%. A session id is the natural scope; a
 * caller without one gets a key derived from the stable head of its prompt.
 *
 * @param {object} request - key inputs.
 * @param {unknown} [request.sessionId] - the harness session this request serves.
 * @param {readonly any[]} [request.messages] - request history.
 * @param {string} [request.system] - assembled system prompt.
 * @returns {string} a stable, short cache-routing key.
 */
export function derivePromptCacheKey({ sessionId, messages, system }) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    const key = `dsh:${sessionId}`
    // Provider keys are short strings; a branded session id is already short.
    return key.length <= 64 ? key : `dsh:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
  }
  let leadingSystem = ''
  let leadingUser = ''
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue
    const text = joinText(message.content)
    if (leadingSystem === '' && (message.role === 'system' || message.role === 'developer')) leadingSystem = text
    if (leadingUser === '' && message.role === 'user') leadingUser = text
    if (leadingSystem !== '' && leadingUser !== '') break
  }
  const digest = createHash('sha256')
    .update(`${typeof system === 'string' ? system : ''}\u0000${leadingSystem}\u0000${leadingUser}`)
    .digest('hex')
  return `dsh:p:${digest.slice(0, 32)}`
}

/**
 * Build the JSON body for one Responses call.
 * @param {object} request - request fields.
 * @param {string} request.model - model id.
 * @param {readonly any[]} request.messages - harness history.
 * @param {string} [request.system] - assembled system prompt.
 * @param {readonly any[]} [request.tools] - active tool schemas.
 * @param {string} [request.reasoningEffort] - selected effort id.
 * @param {unknown} [request.sessionId] - serving harness session, for cache routing.
 * @param {string} [request.promptCacheKey] - cache-routing key to send, when the adapter computed one.
 * @param {object} projectors - content projections.
 * @returns {Promise<Record<string, unknown>>} request body.
 */
export async function buildBody({ model, messages, system, tools, reasoningEffort, promptCacheKey }, projectors) {
  const input = await toInput(messages, projectors)
  // Reusable system guidance has to lead `input` as a developer message. From
  // GPT-6.2 on, top-level `instructions` are appended after `input`, beyond the
  // eligible cache prefix, and are billed as uncached input on every request
  // even when the text repeats — so they can never be served from cache.
  if (typeof system === 'string' && system !== '') input.unshift({ role: 'developer', content: system })
  const body = {
    model,
    input,
    store: false,
    stream: true,
  }
  if (typeof promptCacheKey === 'string' && promptCacheKey !== '') body.prompt_cache_key = promptCacheKey
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = [{
      type: 'namespace', name: TOOL_NAMESPACE, description: 'DeepSeek Harness tools.',
      tools: tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
        strict: false,
      })),
    }]
    body.tool_choice = 'auto'
  }
  const effort = typeof reasoningEffort === 'string' ? reasoningEffort : ''
  if (effort !== '' && effort !== 'off' && effort !== 'none') body.reasoning = { effort }
  return body
}

/**
 * Read one fetch body as an event stream.
 * @param {Response} response - provider reply.
 * @returns {AsyncIterable<Record<string, unknown>>} decoded events.
 */
async function* events(response) {
  if (response.body === null) {
    throw new ChatGptError(CODES.invalid_stream, 'ChatGPT did not return the expected response stream.', { retryable: true, status: response.status })
  }
  let buffer = ''
  let endedWithCR = false
  for await (let chunk of response.body.pipeThrough(new TextDecoderStream())) {
    if (!chunk) continue
    if (endedWithCR && chunk.startsWith('\n')) chunk = chunk.slice(1)
    endedWithCR = chunk.endsWith('\r')
    buffer += chunk.replace(/\r\n?/g, '\n')
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data || data === '[DONE]') continue
      let event
      try {
        event = JSON.parse(data)
      } catch {
        throw new ChatGptError(CODES.invalid_stream, 'ChatGPT sent an invalid streaming event.', { retryable: true })
      }
      if (event && typeof event === 'object') yield event
    }
  }
}

/**
 * Translate one Responses event stream into harness chunks.
 *
 * Blocks open on `response.output_item.added` and close on
 * `response.output_item.done`, so text, reasoning, and tool calls keep the
 * provider's order. The stream ends with one `finish` chunk; failures throw a
 * typed `LlmError` and the runtime turns that into a terminal error chunk.
 *
 * @param {Response} response - provider reply.
 * @param {{ onEvent?: (event: Record<string, unknown>) => void, signal?: AbortSignal }} [options] - diagnostics and cancellation.
 * @returns {AsyncGenerator<Record<string, unknown>>} harness chunks.
 */
export async function* translate(response, { onEvent, signal } = {}) {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== undefined && contentType !== '' && contentType !== 'text/event-stream') {
    const body = await response.text().catch(() => '')
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = body.slice(0, 400)
    }
    throw toLlmError(apiError(parsed, response.status, response.headers.get('x-request-id')))
  }

  /** @type {Map<string, { index: number, kind: string, text: string, name?: string, callId?: string }>} */
  const blocks = new Map()
  /** Provider item id to its opened block index; per stream, never shared. */
  const blockKeys = new Map()
  let nextIndex = 0
  let completed = false
  let sawToolCall = false
  let usage
  let finish

  const startBlock = (item, kind) => {
    const id = typeof item.id === 'string' ? item.id : `item-${nextIndex}`
    const entry = { index: nextIndex, kind, text: '', name: typeof item.name === 'string' ? item.name : undefined, callId: typeof item.call_id === 'string' ? item.call_id : (typeof item.id === 'string' ? item.id : undefined), closed: false }
    nextIndex += 1
    blocks.set(id, entry)
    if (kind === BLOCK.toolCall) sawToolCall = true
    return { id, entry }
  }

  /**
   * Close one block with the content accumulated so far.
   * @param {any} entry - block state.
   * @returns {Record<string, unknown>} the block-end chunk.
   */
  const closeBlock = entry => {
    entry.closed = true
    if (entry.kind === BLOCK.text) {
      return { type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } }
    }
    if (entry.kind === BLOCK.reasoning) {
      return { type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } }
    }
    return {
      type: 'block-end',
      index: entry.index,
      block: {
        type: 'tool-call',
        id: String(entry.callId ?? ''),
        name: String(entry.name ?? ''),
        arguments: entry.text === '' ? '{}' : entry.text,
      },
    }
  }

  for await (const event of events(response)) {
    signal?.throwIfAborted()
    onEvent?.(event)
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'response.output_item.added') {
      const item = event.item ?? {}
      const itemType = item.type
      if (itemType === 'message') {
        const { id, entry } = startBlock(item, BLOCK.text)
        yield { type: 'block-start', index: entry.index, blockType: 'text' }
        blockKeys.set(id, entry.index)
      } else if (itemType === 'function_call') {
        const { id, entry } = startBlock(item, BLOCK.toolCall)
        yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
        blockKeys.set(id, entry.index)
      } else if (itemType === 'reasoning') {
        const { id, entry } = startBlock(item, BLOCK.reasoning)
        yield { type: 'block-start', index: entry.index, blockType: 'reasoning' }
        blockKeys.set(id, entry.index)
      }
      continue
    }
    if (type === 'response.output_text.delta') {
      const index = blockKeys.get(typeof event.item_id === 'string' ? event.item_id : '')
      if (index === undefined || typeof event.delta !== 'string') continue
      const entry = blocks.get(event.item_id)
      entry.text += event.delta
      yield { type: 'text-delta', index, text: event.delta }
      continue
    }
    if (type === 'response.refusal.delta') {
      const index = blockKeys.get(typeof event.item_id === 'string' ? event.item_id : '')
      if (index === undefined || typeof event.delta !== 'string') continue
      const entry = blocks.get(event.item_id)
      entry.text += event.delta
      yield { type: 'text-delta', index, text: event.delta }
      continue
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const key = typeof event.item_id === 'string' ? event.item_id : typeof event.output_index === 'number' ? [...blocks.keys()][event.output_index] : undefined
      const index = key === undefined ? undefined : blockKeys.get(key)
      if (index === undefined || typeof event.delta !== 'string') continue
      const entry = key === undefined ? undefined : blocks.get(key)
      if (entry !== undefined) entry.text += event.delta
      yield { type: 'reasoning-delta', index, text: event.delta }
      continue
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = typeof event.item_id === 'string' ? event.item_id : ''
      const entry = blocks.get(key)
      if (entry === undefined || typeof event.delta !== 'string') continue
      entry.text += event.delta
      yield {
        type: 'tool-call-delta',
        index: entry.index,
        id: entry.callId ?? key,
        ...entry.name === undefined ? {} : { name: entry.name },
        argumentsDelta: event.delta,
      }
      continue
    }
    if (type === 'response.output_item.done') {
      const item = event.item ?? {}
      const key = typeof item.id === 'string' ? item.id : ''
      const entry = blocks.get(key)
      if (entry === undefined) continue
      if (entry.kind === BLOCK.text) {
        const text = typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content) ? item.content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : entry.text
        entry.text = text === '' ? entry.text : text
        yield closeBlock(entry)
      } else if (entry.kind === BLOCK.reasoning) {
        const text = Array.isArray(item.summary) ? item.summary.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : entry.text
        entry.text = text === '' ? entry.text : text
        yield closeBlock(entry)
      } else {
        const args = typeof item.arguments === 'string' ? item.arguments : entry.text
        entry.text = args
        entry.callId = String(item.call_id ?? entry.callId ?? key)
        entry.name = String(item.name ?? entry.name ?? '')
        yield closeBlock(entry)
      }
      continue
    }
    if (type === 'response.completed') {
      completed = true
      const responseValue = event.response ?? {}
      const reported = responseValue.usage
      if (reported !== null && typeof reported === 'object') {
        const details = reported.input_tokens_details ?? {}
        // `input_tokens` folds ordinary input, cached reads, and cache writes
        // together; the harness contract wants the three buckets disjoint.
        // `cache_write_tokens` exists from the models that bill writes, so an
        // older model simply reports no write bucket.
        const cached = Number.isFinite(details.cached_tokens) ? Number(details.cached_tokens) : undefined
        const written = Number.isFinite(details.cache_write_tokens) ? Number(details.cache_write_tokens) : undefined
        const reportedInput = Number(reported.input_tokens)
        const rawInput = Number.isFinite(reportedInput) ? reportedInput : 0
        usage = {
          inputTokens: Math.max(0, rawInput - (cached ?? 0) - (written ?? 0)),
          outputTokens: Number(reported.output_tokens) || 0,
          ...Number.isFinite(reported.total_tokens) ? { totalTokens: Number(reported.total_tokens) } : {},
          ...cached === undefined ? {} : { cacheReadTokens: cached },
          ...written === undefined ? {} : { cacheWriteTokens: written },
          ...Number.isFinite(reported.output_tokens_details?.reasoning_tokens) ? { reasoningTokens: Number(reported.output_tokens_details.reasoning_tokens) } : {},
        }
      }
      const output = Array.isArray(responseValue.output) ? responseValue.output : []
      if (output.some(item => item?.type === 'function_call')) sawToolCall = true
      finish = { kind: sawToolCall ? 'tool-calls' : 'stop' }
      break
    }
    if (type === 'response.incomplete') {
      const reason = event.response?.incomplete_details?.reason
      if (reason === 'max_output_tokens') {
        completed = true
        finish = { kind: 'max-tokens' }
        break
      }
      throw toLlmError(new ChatGptError(CODES.response_incomplete, 'ChatGPT stopped before completing the response. Try again.'))
    }
    if (type === 'response.failed' || type === 'error') {
      const detail = type === 'response.failed' ? event.response?.error ?? event.response : event.error ?? event
      throw toLlmError(apiError({ error: detail }, response.status, response.headers.get('x-request-id')))
    }
  }

  if (!completed || finish === undefined) {
    throw toLlmError(new ChatGptError(CODES.stream_interrupted, 'The response ended before completion. You can keep the partial text or try again.', { retryable: true }))
  }
  // A provider may complete without closing every opened item; close what is
  // still open so the consumer's assembler sees one end for each start.
  for (const entry of [...blocks.values()].sort((left, right) => left.index - right.index)) {
    if (!entry.closed) yield closeBlock(entry)
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish }
}
