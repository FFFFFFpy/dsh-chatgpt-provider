/**
 * Conversion between the harness's provider-neutral request and the Responses
 * API shape this route accepts, plus translation of its event stream back into
 * harness chunks.
 *
 * The route has documented requirements that shape everything here: send
 * `store: false` and `stream: true`, put system guidance in `instructions` or
 * developer messages (never a `system` role item), and omit `temperature`,
 * `top_p`, `max_output_tokens`, `metadata`, `truncation`, `user`, and
 * `previous_response_id`.
 */
import { ChatGptError, CODES, errorShape, toLlmError } from './errors.js'

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
      const text = joinText(message.content)
      items.push({
        type: 'function_call_output',
        call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
        output: message.isError === true ? `[error] ${text}` : text,
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
 * Build the JSON body for one Responses call.
 * @param {object} request - request fields.
 * @param {string} request.model - model id.
 * @param {readonly any[]} request.messages - harness history.
 * @param {string} [request.system] - assembled system prompt.
 * @param {readonly any[]} [request.tools] - active tool schemas.
 * @param {string} [request.reasoningEffort] - selected effort id.
 * @param {object} projectors - content projections.
 * @returns {Promise<Record<string, unknown>>} request body.
 */
export async function buildBody({ model, messages, system, tools, reasoningEffort }, projectors) {
  const input = await toInput(messages, projectors)
  const body = {
    model,
    input,
    store: false,
    stream: true,
  }
  if (typeof system === 'string' && system !== '') body.instructions = system
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      strict: false,
    }))
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
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) break
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = raw.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (data === '' || data === '[DONE]') continue
      try {
        const event = JSON.parse(data)
        if (event !== null && typeof event === 'object') yield event
      } catch {
        // A keepalive or comment line is not an event.
      }
    }
  }
  buffer += decoder.decode()
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    try {
      const event = JSON.parse(tail.slice(5).trim())
      if (event !== null && typeof event === 'object') yield event
    } catch {
      /* ignore */
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
    throw toLlmError(new ChatGptError(
      errorShape(parsed).code ?? `http_${response.status}`,
      `${errorShape(parsed).message} (HTTP ${response.status})`,
      { status: response.status, retryable: response.status >= 500 || response.status === 429 },
    ))
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
        usage = {
          inputTokens: Number(reported.input_tokens) || 0,
          outputTokens: Number(reported.output_tokens) || 0,
          ...Number.isFinite(reported.total_tokens) ? { totalTokens: Number(reported.total_tokens) } : {},
          ...Number.isFinite(reported.input_tokens_details?.cached_tokens) ? { cacheReadTokens: Number(reported.input_tokens_details.cached_tokens) } : {},
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
      const shape = errorShape(detail !== null && typeof detail === 'object' && 'error' in detail ? detail : { error: detail })
      throw toLlmError(new ChatGptError(shape.code ?? `http_${response.status}`, `${shape.message} (HTTP ${response.status})`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      }))
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
