import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectModelStream } from '@deep-tui/sdk'
import { OpenAiCompatibleProvider } from '../src/index.js'
import { readSseData } from '../src/sse.js'

function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } })
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of iterable) output.push(item)
  return output
}

afterEach(() => vi.restoreAllMocks())

describe('OpenAI-compatible SSE streaming', () => {
  it('parses every byte split, UTF-8, CRLF, comments, and multiple data fields', async () => {
    const source = Buffer.from(': keep-alive\r\n\r\ndata: hé\r\ndata: llo\r\n\r\ndata: [DONE]\r\n\r\n')
    for (let split = 1; split < source.length; split += 1) {
      const values = await collect(readSseData(streamChunks([source.subarray(0, split), source.subarray(split)])))
      expect(values).toEqual(['hé\nllo', '[DONE]'])
    }
  })

  it('assembles text, reasoning, tool calls, and exact final usage', async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"why ","content":"hel","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"prompt_cache_hit_tokens":5,"prompt_cache_miss_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(streamChunks([Buffer.from(body)]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://example.test', apiKey: 'test',
      extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    })
    const response = await collectModelStream(provider.stream!({ model: 'm', messages: [], tools: [] }))
    expect(requestBody).toMatchObject({
      model: 'm', stream: true,
      thinking: { type: 'enabled' }, reasoning_effort: 'max',
    })
    expect(response).toEqual({
      text: 'hello', reasoning: 'why ',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' }, rawArguments: '{"path":"a"}' }],
      usage: { inputTokens: 12, cachedInputTokens: 5, uncachedInputTokens: 7, outputTokens: 3, contextTokens: 12 },
    })
  })

  it('rejects malformed and truncated streams', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamChunks([Buffer.from('data: nope\n\n')]), { status: 200 })))
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://example.test' })
    await expect(collect(provider.stream({ model: 'm', messages: [], tools: [] }))).rejects.toThrow('malformed provider SSE data')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(streamChunks([Buffer.from('data: {"choices":[]}\n\n')]), { status: 200 })))
    await expect(collect(provider.stream({ model: 'm', messages: [], tools: [] }))).rejects.toThrow('before data: [DONE]')
  })

  it('preserves raw tool JSON on passback and reads standard cached-token usage', async () => {
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens: 2 },
      })
    }))
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://example.test', apiKey: 'test' })
    const response = await provider.complete({
      model: 'm', tools: [], messages: [{
        role: 'assistant', content: '',
        toolCalls: [{ id: 'c1', name: 'tool', arguments: { a: 1, b: 2 }, rawArguments: '{ "b": 2, "a": 1 }' }],
      }],
    })

    const messages = requestBody?.messages as Array<Record<string, unknown>>
    const calls = messages[0]?.tool_calls as Array<{ function: { arguments: string } }>
    expect(calls[0]?.function.arguments).toBe('{ "b": 2, "a": 1 }')
    expect(response.usage).toMatchObject({
      inputTokens: 10, cachedInputTokens: 6, uncachedInputTokens: 4, outputTokens: 2,
    })
  })
})
