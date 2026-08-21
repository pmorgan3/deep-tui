import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  AgentLifecycleService,
  AuditService,
  ConversationService,
  ModelService,
  PermissionService,
  PromptService,
  ToolService,
  type AgentEvent,
  type ModelRequest,
  type ModelResponse,
} from '@deep-tui/sdk'
import { DefaultAgentService, TOOL_ORDER_REST } from '../src/index.js'

async function collect(generator: AsyncGenerator<AgentEvent, string>): Promise<{ events: AgentEvent[]; result: string }> {
  const events: AgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

describe('default agent', () => {
  it('keeps dynamic context in an append-only suffix and canonicalizes the tool envelope', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(ModelService), ctx.plugin(ToolService), ctx.plugin(PromptService),
      ctx.plugin(PermissionService), ctx.plugin(AuditService), ctx.plugin(ConversationService),
    ])
    const requests: ModelRequest[] = []
    let runtimeContext = 'workspace state one'
    const contributions = await ctx.plugin({
      name: 'cache-stability-test', inject: ['models', 'tools', 'prompts'], apply(inner) {
        inner.models.register({
          id: 'fake', async complete(request) {
            requests.push(request)
            return { text: `answer ${requests.length}`, toolCalls: [] }
          },
        })
        inner.tools.register({ name: 'zeta', description: 'Z', inputSchema: { type: 'object' }, execute: () => '' })
        inner.tools.register({
          name: 'alpha', description: 'A', inputSchema: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } },
          execute: () => '',
        })
        inner.prompts.register({ id: 'system', render: () => 'Stable system.' })
        inner.prompts.register({ id: 'runtime', placement: 'context', render: () => runtimeContext })
      },
    })
    const conversation = await ctx.conversations.create({
      projectRoot: process.cwd(), provider: 'fake', model: 'm',
    })
    const agent = await ctx.plugin(DefaultAgentService, {
      provider: 'fake', model: 'm', toolOrder: ['zeta', TOOL_ORDER_REST],
    })

    const first = await collect(ctx.agent.run('first prompt', { cwd: process.cwd(), conversationId: conversation.id }))
    runtimeContext = 'workspace state two'
    const second = await collect(ctx.agent.run('second prompt', { cwd: process.cwd(), conversationId: conversation.id }))
    const records = []
    for await (const record of ctx.conversations.read(conversation.id)) records.push(record)

    expect(requests.map(request => request.tools.map(tool => tool.name))).toEqual([['zeta', 'alpha'], ['zeta', 'alpha']])
    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: 'Stable system.' },
      { role: 'user', content: '<runtime-context source="runtime">\nworkspace state one\n</runtime-context>' },
      { role: 'user', content: 'first prompt' },
    ])
    expect(requests[1]?.messages.slice(0, 3)).toEqual(requests[0]?.messages)
    expect(requests[1]?.messages.at(-2)?.content).toContain('workspace state two')
    expect(first.events.find(event => event.type === 'assistant-start')).toMatchObject({ cache: { status: 'cold' } })
    expect(second.events.find(event => event.type === 'assistant-start')).toMatchObject({ cache: { status: 'stable' } })
    expect(records.filter(record => record.type === 'envelope')).toHaveLength(1)
    expect(records.filter(record => record.type === 'context')).toHaveLength(2)

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })

  it('runs a permission-gated tool round and returns the final answer', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(ModelService),
      ctx.plugin(ToolService),
      ctx.plugin(PromptService),
      ctx.plugin(PermissionService),
      ctx.plugin(AuditService),
      ctx.plugin(ConversationService),
    ])
    const responses: ModelResponse[] = [
      {
        text: '',
        reasoning: 'I should use the tool to calculate this.',
        toolCalls: [{ id: 'call-1', name: 'answer_part', arguments: { value: 40 } }],
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 1,
          contextTokens: 10,
          calculatedCostUsd: 0.001,
        },
      },
      {
        text: 'The answer is 42.',
        toolCalls: [],
        usage: {
          inputTokens: 20,
          cachedInputTokens: 5,
          outputTokens: 4,
          contextTokens: 20,
          calculatedCostUsd: 0.002,
        },
      },
    ]
    const auditEvents: Array<{ type: string; runId?: string; toolCallId?: string }> = []
    const contributions = await ctx.plugin({
      name: 'test-contributions',
      inject: ['audit', 'models', 'tools', 'prompts', 'permissions'],
      apply(inner) {
        inner.audit.registerSink({ id: 'test', record: event => { auditEvents.push(event) } })
        inner.models.register({
          id: 'fake',
          complete: async () => {
            const response = responses.shift()
            if (!response) throw new Error('unexpected model call')
            return response
          },
        })
        inner.tools.register({
          name: 'answer_part',
          description: 'Add two to a number.',
          inputSchema: { type: 'object' },
          permission: () => ({ capability: 'test.execute', risk: 'execute', description: 'test tool' }),
          execute(input, execution) {
            execution.present?.({ type: 'diff', data: { diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' } })
            return Number(input.value) + 2
          },
        })
        inner.prompts.register({ id: 'test', render: () => 'Use tools.' })
        inner.permissions.register({ id: 'allow-test', decide: () => 'allow' })
      },
    })
    const agent = await ctx.plugin(DefaultAgentService, { provider: 'fake', model: 'fake-model' })

    const result = await collect(ctx.agent.run('What is the answer?', { cwd: process.cwd() }))

    expect(result.result).toBe('The answer is 42.')
    expect(result.events.map(event => event.type)).toEqual([
      'start',
      'assistant-start',
      'assistant-reasoning-delta',
      'assistant-finish',
      'tool-call',
      'tool-result',
      'assistant-start',
      'assistant-delta',
      'assistant-finish',
      'finish',
    ])
    expect(result.events.at(-1)).toMatchObject({
      type: 'finish',
      usage: {
        inputTokens: 30,
        cachedInputTokens: 7,
        outputTokens: 5,
        contextTokens: 20,
        calculatedCostUsd: 0.003,
      },
    })
    expect(result.events.filter(event => event.type === 'assistant-finish')).toMatchObject([
      {
        type: 'assistant-finish', reasoning: 'I should use the tool to calculate this.',
        usage: { inputTokens: 10, outputTokens: 1, calculatedCostUsd: 0.001 },
      },
      { type: 'assistant-finish', usage: { inputTokens: 20, outputTokens: 4, calculatedCostUsd: 0.002 } },
    ])
    expect(result.events.find(event => event.type === 'tool-result')).toMatchObject({
      type: 'tool-result', output: 42,
      presentation: { type: 'diff', data: { diff: expect.stringContaining('+new') } },
    })
    expect(responses).toHaveLength(0)
    expect(auditEvents.map(event => event.type)).toEqual([
      'run.start', 'model.start', 'model.finish', 'permission.request', 'permission.decision',
      'tool.start', 'tool.finish', 'model.start', 'model.finish', 'run.finish',
    ])
    expect(new Set(auditEvents.map(event => event.runId).filter(Boolean)).size).toBe(1)
    expect(auditEvents.filter(event => event.toolCallId).every(event => event.toolCallId === 'call-1')).toBe(true)

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })

  it('feeds malformed streamed tool arguments back to the model without executing them', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(ModelService), ctx.plugin(ToolService), ctx.plugin(PromptService),
      ctx.plugin(PermissionService), ctx.plugin(AuditService), ctx.plugin(ConversationService),
    ])
    const requests: ModelRequest[] = []
    const auditEvents: Array<{ type: string; data?: Record<string, unknown> }> = []
    const malformedArguments = String.raw`{"path":"C:\workspace\source.txt"}`
    let executions = 0
    const contributions = await ctx.plugin({
      name: 'malformed-tool-arguments-test', inject: ['audit', 'models', 'tools'], apply(inner) {
        inner.audit.registerSink({ id: 'test', record: event => { auditEvents.push(event) } })
        inner.models.register({
          id: 'fake',
          async complete() { throw new Error('stream should be used') },
          async *stream(request) {
            requests.push(request)
            if (requests.length === 1) {
              yield {
                type: 'tool-call-delta' as const,
                index: 0,
                id: 'call-bad-json',
                name: 'read_path',
                argumentsDelta: malformedArguments,
              }
            } else {
              yield { type: 'text-delta' as const, delta: 'Recovered after invalid tool arguments.' }
            }
            yield { type: 'finish' as const }
          },
        })
        inner.tools.register({
          name: 'read_path', description: 'Read a path.', inputSchema: { type: 'object' },
          execute: () => { executions += 1; return 'should not run' },
        })
      },
    })
    const agent = await ctx.plugin(DefaultAgentService, { provider: 'fake', model: 'm' })

    const result = await collect(ctx.agent.run('Read the path.', { cwd: process.cwd() }))

    expect(result.result).toBe('Recovered after invalid tool arguments.')
    expect(executions).toBe(0)
    expect(result.events.map(event => event.type)).toEqual([
      'start', 'assistant-start', 'assistant-finish', 'tool-call', 'tool-result',
      'assistant-start', 'assistant-delta', 'assistant-finish', 'finish',
    ])
    const toolResult = result.events.find(event => event.type === 'tool-result')
    expect(toolResult).toMatchObject({
      type: 'tool-result',
      call: { name: 'read_path', arguments: {}, rawArguments: malformedArguments },
      output: { error: expect.stringContaining('Retry the tool call with valid JSON arguments') },
    })
    expect(requests[1]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ name: 'read_path', arguments: {}, rawArguments: malformedArguments }],
    })
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('invalid JSON arguments'),
    })
    expect(auditEvents.find(event => event.type === 'tool.error')).toMatchObject({
      data: { name: 'read_path', error: expect.stringContaining('Bad escaped character') },
    })

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })

  it('runs past twelve model steps when no step budget is configured', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(ModelService),
      ctx.plugin(ToolService),
      ctx.plugin(PromptService),
      ctx.plugin(PermissionService),
      ctx.plugin(AuditService),
      ctx.plugin(ConversationService),
    ])
    let modelCalls = 0
    const contributions = await ctx.plugin({
      name: 'unbounded-test-contributions',
      inject: ['models', 'tools'],
      apply(inner) {
        inner.models.register({
          id: 'fake',
          complete: async () => {
            modelCalls += 1
            if (modelCalls <= 13) {
              return {
                text: '',
                toolCalls: [{ id: `call-${modelCalls}`, name: 'keep_going', arguments: { step: modelCalls } }],
              }
            }
            return { text: 'Completed after sustained work.', toolCalls: [] }
          },
        })
        inner.tools.register({
          name: 'keep_going',
          description: 'Continue a long-running task.',
          inputSchema: { type: 'object' },
          execute: input => input.step,
        })
      },
    })
    const agent = await ctx.plugin(DefaultAgentService, { provider: 'fake', model: 'fake-model' })

    const result = await collect(ctx.agent.run('Keep working until done.', { cwd: process.cwd() }))

    expect(modelCalls).toBe(14)
    expect(result.result).toBe('Completed after sustained work.')
    expect(result.events.filter(event => event.type === 'tool-result')).toHaveLength(13)
    expect(result.events.at(-1)).toMatchObject({ type: 'finish', status: 'complete', steps: 14 })

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })

  it('records an explicitly configured step budget as limit-reached instead of complete', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(ModelService),
      ctx.plugin(ToolService),
      ctx.plugin(PromptService),
      ctx.plugin(PermissionService),
      ctx.plugin(AuditService),
      ctx.plugin(ConversationService),
    ])
    let modelCalls = 0
    const contributions = await ctx.plugin({
      name: 'bounded-test-contributions',
      inject: ['models', 'tools'],
      apply(inner) {
        inner.models.register({
          id: 'fake',
          complete: async () => {
            modelCalls += 1
            return {
              text: '',
              toolCalls: [{ id: `call-${modelCalls}`, name: 'keep_going', arguments: { step: modelCalls } }],
            }
          },
        })
        inner.tools.register({
          name: 'keep_going',
          description: 'Continue a long-running task.',
          inputSchema: { type: 'object' },
          execute: input => input.step,
        })
      },
    })
    const conversation = await ctx.conversations.create({
      projectRoot: process.cwd(), provider: 'fake', model: 'fake-model',
    })
    const agent = await ctx.plugin(DefaultAgentService, {
      provider: 'fake', model: 'fake-model', maxSteps: 2,
    })

    const result = await collect(ctx.agent.run('Keep working until done.', {
      cwd: process.cwd(), conversationId: conversation.id,
    }))
    const records = []
    for await (const record of ctx.conversations.read(conversation.id)) records.push(record)

    expect(modelCalls).toBe(2)
    expect(result.events.at(-1)).toMatchObject({ type: 'finish', status: 'limit-reached', steps: 2 })
    expect(records.at(-1)).toMatchObject({ type: 'run', status: 'limit-reached', steps: 2 })

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })

  it('honors plugin lifecycle limits between model steps and reports terminal cleanup', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(AgentLifecycleService), ctx.plugin(ModelService), ctx.plugin(ToolService),
      ctx.plugin(PromptService), ctx.plugin(PermissionService), ctx.plugin(AuditService),
      ctx.plugin(ConversationService),
    ])
    let modelCalls = 0
    const finishes: Array<{ status: string; steps: number }> = []
    const contributions = await ctx.plugin({
      name: 'lifecycle-limit-test', inject: ['agentHooks', 'models', 'tools'], apply(inner) {
        inner.agentHooks.register({
          id: 'test.limit',
          beforeStep: context => context.step > 1 ? 'test lifecycle budget reached' : undefined,
          afterRun: context => { finishes.push({ status: context.status, steps: context.steps }) },
        })
        inner.models.register({
          id: 'fake', async complete() {
            modelCalls += 1
            return { text: '', toolCalls: [{ id: 'call-1', name: 'work', arguments: {} }], usage: { inputTokens: 10 } }
          },
        })
        inner.tools.register({ name: 'work', description: 'Work once.', inputSchema: { type: 'object' }, execute: () => 'done' })
      },
    })
    const agent = await ctx.plugin(DefaultAgentService, { provider: 'fake', model: 'm' })

    const result = await collect(ctx.agent.run('Start.', { cwd: process.cwd() }))

    expect(modelCalls).toBe(1)
    expect(result.events.filter(event => event.type === 'tool-result')).toHaveLength(1)
    expect(result.events.at(-1)).toMatchObject({ type: 'finish', status: 'limit-reached', steps: 1 })
    expect(result.result).toContain('test lifecycle budget reached')
    expect(finishes).toEqual([{ status: 'limit-reached', steps: 1 }])

    await agent.dispose()
    await contributions.dispose()
    await Promise.all(services.map(fiber => fiber.dispose()))
  })
})
