import type { Context } from 'cordis'
import type {
  JsonObject,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCall,
} from '@flect/sdk'
import { assertRecord } from '@flect/sdk'
import { stableJsonStringify } from '@flect/sdk'
import { readSseData } from './sse.js'

export interface OpenAiCompatibleConfig {
  id?: string
  baseUrl?: string
  apiKeyEnv?: string
  apiKey?: string
  headers?: Record<string, string>
  streaming?: boolean
  streamUsage?: boolean
  allowEofTermination?: boolean
  /** Additional provider-specific chat-completion fields. Core request fields win on conflicts. */
  extraBody?: JsonObject
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: Array<{
      id?: string
      function?: { name?: string; arguments?: string }
    }>
  }
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens?: number
  }
  error?: { message?: string }
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatCompletionResponse['usage'] | null
  error?: { message?: string }
}

function toOpenAiMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.rawArguments ?? stableJsonStringify(call.arguments) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function parseArguments(value: string | undefined): JsonObject {
  if (!value) return {}
  const parsed: unknown = JSON.parse(value)
  assertRecord(parsed, 'tool arguments')
  return parsed
}

function parseUsage(usage: NonNullable<ChatCompletionResponse['usage']>) {
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
  const uncached = usage.prompt_cache_miss_tokens
    ?? (usage.prompt_tokens === undefined || cached === undefined
      ? undefined
      : Math.max(0, usage.prompt_tokens - cached))
  return {
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(uncached === undefined ? {} : { uncachedInputTokens: uncached }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.prompt_tokens === undefined ? {} : { contextTokens: usage.prompt_tokens }),
  }
}

function parseResponse(payload: ChatCompletionResponse): ModelResponse {
  if (payload.error?.message) throw new Error(payload.error.message)
  const message = payload.choices?.[0]?.message
  if (!message) throw new Error('provider returned no completion choice')
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => {
    const name = call.function?.name
    if (!name) throw new Error(`provider returned tool call ${index} without a name`)
    return {
      id: call.id ?? `call-${index}`,
      name,
      arguments: parseArguments(call.function?.arguments),
      ...(call.function?.arguments ? { rawArguments: call.function.arguments } : {}),
    }
  })
  return {
    text: message.content ?? '',
    ...(message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
    toolCalls,
    ...(payload.usage ? {
      usage: parseUsage(payload.usage),
    } : {}),
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string
  private readonly baseUrl: string

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.id = config.id ?? 'openai'
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.config.apiKey ?? process.env[this.config.apiKeyEnv ?? 'OPENAI_API_KEY']
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
    }
    if (request.tools.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }))
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    const payload = await response.json() as ChatCompletionResponse
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `provider request failed with HTTP ${response.status}`)
    }
    return parseResponse(payload)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (this.config.streaming === false) {
      const response = await this.complete(request)
      if (response.reasoning) yield { type: 'reasoning-delta', delta: response.reasoning }
      if (response.text) yield { type: 'text-delta', delta: response.text }
      for (let index = 0; index < response.toolCalls.length; index += 1) {
        const call = response.toolCalls[index]
        if (call) yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) }
      }
      if (response.usage) yield { type: 'usage', usage: response.usage }
      yield { type: 'finish' }
      return
    }
    const apiKey = this.config.apiKey ?? process.env[this.config.apiKeyEnv ?? 'OPENAI_API_KEY']
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.config.headers,
    }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      ...(this.config.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
    }
    if (request.tools.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }))
    }
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), ...(request.signal ? { signal: request.signal } : {}),
    })
    if (!response.ok) {
      let message = `provider request failed with HTTP ${response.status}`
      try {
        const payload = await response.json() as ChatCompletionChunk
        message = payload.error?.message ?? message
      } catch {}
      throw new Error(message)
    }
    if (!response.body) throw new Error('provider returned an empty streaming body')
    let finished = false
    let terminalFinish = false
    for await (const data of readSseData(response.body, request.signal)) {
      if (data === '[DONE]') {
        finished = true
        if (!terminalFinish) yield { type: 'finish' }
        break
      }
      let payload: ChatCompletionChunk
      try {
        payload = JSON.parse(data) as ChatCompletionChunk
      } catch {
        throw new Error(`malformed provider SSE data: ${data.slice(0, 200)}`)
      }
      if (payload.error?.message) throw new Error(payload.error.message)
      if (payload.usage) yield { type: 'usage', usage: parseUsage(payload.usage) }
      for (const choice of payload.choices ?? []) {
        const delta = choice.delta
        if (delta?.content) yield { type: 'text-delta', delta: delta.content }
        if (delta?.reasoning_content) yield { type: 'reasoning-delta', delta: delta.reasoning_content }
        for (const call of delta?.tool_calls ?? []) {
          yield {
            type: 'tool-call-delta',
            index: call.index ?? 0,
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { name: call.function.name } : {}),
            ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
          }
        }
        if (choice.finish_reason) {
          terminalFinish = true
          yield { type: 'finish', reason: choice.finish_reason }
        }
      }
    }
    if (!finished && !(this.config.allowEofTermination && terminalFinish)) {
      throw new Error('provider stream ended before data: [DONE]')
    }
  }
}

export const name = 'openai-compatible-provider'
export const inject = ['models']

export function apply(ctx: Context, config: OpenAiCompatibleConfig = {}): void {
  ctx.models.register(new OpenAiCompatibleProvider(config))
}

export default { name, inject, apply }
