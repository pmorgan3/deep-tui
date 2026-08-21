import { randomUUID } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type {
  AgentEvent,
  AgentRunStatus,
  AgentLifecycleService,
  AgentRunOptions,
  CachePrefixDiagnostics,
  JsonObject,
  ModelEnvelope,
  ModelMessage,
  ModelRequest,
  ModelTool,
  ModelUsage,
  ToolCall,
  ToolPresentation,
  ConversationRecord,
} from '@flect/sdk'
import {
  assertRecord,
  conversationSurface,
  createModelEnvelope,
  formatCheckpoint,
  formatRuntimeContext,
  formatUnknownError,
  stableJsonStringify,
} from '@flect/sdk'

export const TOOL_ORDER_REST = '<unlisted-tools>'

export interface AgentConfig {
  provider?: string
  model?: string
  /** Optional model-turn budget. Omit to run until completion or cancellation. */
  maxSteps?: number
  /** Explicit model-facing tool order; include one <unlisted-tools> rest entry. */
  toolOrder?: string[]
}

function validateToolOrder(order: readonly string[]): void {
  const rest = order.indexOf(TOOL_ORDER_REST)
  if (rest < 0 || order.lastIndexOf(TOOL_ORDER_REST) !== rest) {
    throw new TypeError(`agent toolOrder must contain exactly one ${TOOL_ORDER_REST} entry`)
  }
  if (new Set(order).size !== order.length) throw new TypeError('agent toolOrder cannot contain duplicates')
}

function orderTools(tools: readonly ModelTool[], order: readonly string[] | undefined): ModelTool[] {
  const lexical = [...tools].sort((left, right) => left.name.localeCompare(right.name))
  if (!order) return lexical
  validateToolOrder(order)
  const byName = new Map(lexical.map(tool => [tool.name, tool]))
  for (const name of order) {
    if (name !== TOOL_ORDER_REST && !byName.has(name)) {
      throw new Error(`agent toolOrder names unregistered tool "${name}"`)
    }
  }
  const listed = new Set(order.filter(name => name !== TOOL_ORDER_REST))
  const remaining = lexical.filter(tool => !listed.has(tool.name))
  return order.flatMap(name => name === TOOL_ORDER_REST ? remaining : [byName.get(name) as ModelTool])
}

function changedEnvelopeReason(previous: ModelEnvelope, current: ModelEnvelope): CachePrefixDiagnostics['reason'] | undefined {
  if (previous.provider !== current.provider) return 'provider'
  if (previous.model !== current.model) return 'model'
  if (previous.system !== current.system) return 'system'
  if (stableJsonStringify(previous.tools) !== stableJsonStringify(current.tools)) return 'tools'
  return undefined
}

function requestCacheDiagnostics(
  request: ModelRequest,
  envelope: ModelEnvelope,
  previousRequest: ModelRequest | undefined,
  previousEnvelope: ModelEnvelope | undefined,
  persistedMessages: number,
  checkpointChanged: boolean,
): CachePrefixDiagnostics {
  if (previousRequest) {
    let stableMessages = 0
    while (stableMessages < previousRequest.messages.length
      && stableJsonStringify(previousRequest.messages[stableMessages]) === stableJsonStringify(request.messages[stableMessages])) {
      stableMessages += 1
    }
    const reason = previousRequest.model !== request.model
      ? 'model'
      : stableJsonStringify(previousRequest.tools) !== stableJsonStringify(request.tools)
        ? 'tools'
        : stableMessages < previousRequest.messages.length ? 'history' : undefined
    return {
      status: reason ? 'changed' : 'stable',
      ...(reason ? { reason } : {}),
      stableMessages,
      totalMessages: request.messages.length,
      envelopeFingerprint: envelope.fingerprint,
    }
  }
  if (!previousEnvelope) return {
    status: 'cold', reason: 'new-conversation', stableMessages: 0,
    totalMessages: request.messages.length, envelopeFingerprint: envelope.fingerprint,
  }
  const reason = changedEnvelopeReason(previousEnvelope, envelope) ?? (checkpointChanged ? 'checkpoint' : undefined)
  return {
    status: reason ? 'changed' : 'stable',
    ...(reason ? { reason } : {}),
    stableMessages: reason ? (reason === 'checkpoint' ? 1 : 0) : persistedMessages,
    totalMessages: request.messages.length,
    envelopeFingerprint: envelope.fingerprint,
  }
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

interface AssembledToolCall {
  call: ToolCall
  parseError?: string
}

function assembleToolCall(
  index: number,
  streamed: { id: string; name: string; arguments: string },
): AssembledToolCall {
  if (!streamed.name) throw new Error(`provider streamed tool call ${index} without a name`)
  try {
    const parsed: unknown = streamed.arguments ? JSON.parse(streamed.arguments) : {}
    assertRecord(parsed, `tool call ${streamed.name} arguments`)
    return {
      call: {
        id: streamed.id,
        name: streamed.name,
        arguments: parsed,
        ...(streamed.arguments ? { rawArguments: streamed.arguments } : {}),
      },
    }
  } catch (error) {
    return {
      call: {
        id: streamed.id,
        name: streamed.name,
        arguments: {},
        ...(streamed.arguments ? { rawArguments: streamed.arguments } : {}),
      },
      parseError: `Tool "${streamed.name}" was not executed because the model supplied invalid JSON arguments: `
        + `${formatUnknownError(error)}. Retry the tool call with valid JSON arguments.`,
    }
  }
}

function addUsage(total: ModelUsage, next: ModelUsage | undefined): ModelUsage {
  if (!next) return total
  const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'uncachedInputTokens' | 'outputTokens' | 'calculatedCostUsd') => {
    const value = (total[key] ?? 0) + (next[key] ?? 0)
    return value || total[key] !== undefined || next[key] !== undefined ? value : undefined
  }
  const inputTokens = sum('inputTokens')
  const cachedInputTokens = sum('cachedInputTokens')
  const uncachedInputTokens = sum('uncachedInputTokens')
  const outputTokens = sum('outputTokens')
  const calculatedCostUsd = sum('calculatedCostUsd')
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(next.contextTokens === undefined && total.contextTokens === undefined
      ? {}
      : { contextTokens: next.contextTokens ?? total.contextTokens ?? 0 }),
    ...(calculatedCostUsd === undefined ? {} : { calculatedCostUsd }),
  }
}

export class DefaultAgentService extends Service<AgentConfig> {
  static inject = ['audit', 'conversations', 'models', 'tools', 'prompts', 'permissions']

  private readonly config: { provider: string; model: string; maxSteps?: number; toolOrder?: string[] }

  constructor(ctx: Context, config: AgentConfig = {}) {
    super(ctx, 'agent')
    this.config = {
      provider: config.provider ?? 'deepseek',
      model: config.model ?? 'flash',
      ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
      ...(config.toolOrder === undefined ? {} : { toolOrder: [...config.toolOrder] }),
    }
    if (this.config.maxSteps !== undefined
      && (!Number.isInteger(this.config.maxSteps) || this.config.maxSteps < 1)) {
      throw new TypeError('agent maxSteps must be a positive integer')
    }
    if (this.config.toolOrder) validateToolOrder(this.config.toolOrder)
  }

  async *run(input: string, options: AgentRunOptions): AsyncGenerator<AgentEvent, string> {
    const runId = options.runId ?? randomUUID()
    const runStartedAt = Date.now()
    const provider = options.provider ?? this.config.provider
    const model = options.model ?? this.config.model
    const lifecycle = this.ctx.get('agentHooks') as AgentLifecycleService | undefined
    const lifecycleContext = {
      runId, input, cwd: options.cwd, provider, model,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }
    const assembly = await this.ctx.prompts.assemble({ cwd: options.cwd, model })
    const tools = orderTools(this.ctx.tools.definitions().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })), this.config.toolOrder)
    const envelope = createModelEnvelope(provider, model, assembly.system, tools)
    const messages: ModelMessage[] = []
    if (assembly.system) messages.push({ role: 'system', content: assembly.system })
    let persistedMessages = messages.length
    let sequence = 0
    let previousEnvelope: ModelEnvelope | undefined
    let checkpointChanged = false
    await lifecycle?.start(lifecycleContext)
    try {
      if (options.conversationId) {
        const records: ConversationRecord[] = []
        for await (const record of this.ctx.conversations.read(options.conversationId)) records.push(record)
        sequence = records.at(-1)?.seq ?? 0
        previousEnvelope = [...records].reverse().find(record => record.type === 'envelope')?.envelope
        const lastRun = [...records].reverse().find(record => record.type === 'run')?.seq ?? 0
        checkpointChanged = records.some(record => record.type === 'checkpoint' && record.seq > lastRun)
        for (const record of conversationSurface(records)) {
          const message = recordToModelMessage(record)
          if (message) messages.push(message)
        }
      }
      persistedMessages = messages.length
      const createdAt = new Date().toISOString()
      const appended = [
        ...(!previousEnvelope || previousEnvelope.fingerprint !== envelope.fingerprint
          ? [{ type: 'envelope' as const, envelope, createdAt }]
          : []),
        ...assembly.contexts.map(context => ({
          type: 'context' as const, messageId: randomUUID(), source: context.id, text: context.text, createdAt,
        })),
        { type: 'user' as const, messageId: randomUUID(), text: input, createdAt },
      ]
      if (options.conversationId) {
        sequence = await this.ctx.conversations.append(options.conversationId, sequence, appended)
      }
      for (const context of assembly.contexts) {
        messages.push({ role: 'user', content: formatRuntimeContext(context.id, context.text) })
      }
      messages.push({ role: 'user', content: input })
    } catch (error) {
      await lifecycle?.finish({ ...lifecycleContext, steps: 0, status: 'failed', usage: {} })
      throw error
    }

    let latestText = ''
    let usage: ModelUsage = {}
    let terminalRecorded = false
    let attemptedSteps = 0
    const finishRun = async (status: AgentRunStatus, steps: number) => {
      if (terminalRecorded) return
      terminalRecorded = true
      try {
        if (options.conversationId) {
          sequence = await this.ctx.conversations.append(options.conversationId, sequence, [{
            type: 'run', runId, ...(Object.keys(usage).length ? { usage } : {}), steps, status, createdAt: new Date().toISOString(),
          }])
        }
        await this.ctx.audit.record({
          id: randomUUID(), type: 'run.finish', timestamp: new Date().toISOString(), projectRoot: options.cwd,
          runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          data: { status, steps, durationMs: Date.now() - runStartedAt, ...usage },
        })
      } finally {
        await lifecycle?.finish({ ...lifecycleContext, steps, status, usage })
      }
    }
    try {
      await this.ctx.audit.record({
        id: randomUUID(), type: 'run.start', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        data: { provider, model },
      })

      this.ctx.emit('harness/agent/start', input, {
        cwd: options.cwd,
        provider,
        model,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      })
      yield { type: 'start', input }

      const maxSteps = this.config.maxSteps
      let previousRequest: ModelRequest | undefined
      for (let step = 1; maxSteps === undefined || step <= maxSteps; step += 1) {
        attemptedSteps = step - 1
      const lifecycleLimit = await lifecycle?.beforeStep({ ...lifecycleContext, step, usage })
      if (lifecycleLimit) {
        const completedSteps = step - 1
        const stopped = latestText || `Stopped before model step ${step}: ${lifecycleLimit}`
        this.ctx.emit('harness/agent/finish', stopped, completedSteps, 'limit-reached')
        yield {
          type: 'finish', text: stopped, steps: completedSteps, status: 'limit-reached',
          ...(Object.keys(usage).length ? { usage } : {}),
        }
        await finishRun('limit-reached', completedSteps)
        return stopped
      }
      if (options.signal?.aborted) {
        await finishRun('cancelled', step - 1)
        this.ctx.emit('harness/agent/finish', latestText, step - 1, 'cancelled')
        throw options.signal.reason
      }
      attemptedSteps = step
      const request: ModelRequest = {
        model,
        messages: [...messages],
        tools,
        ...(options.signal ? { signal: options.signal } : {}),
      }
      const cache = requestCacheDiagnostics(
        request, envelope, previousRequest, previousEnvelope, persistedMessages, checkpointChanged)
      await this.ctx.audit.record({
        id: randomUUID(), type: 'model.start', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        data: { provider, model, step, cacheStatus: cache.status, cacheReason: cache.reason ?? '',
          stableMessages: cache.stableMessages, envelopeFingerprint: cache.envelopeFingerprint },
      })
      const modelStartedAt = Date.now()
      const messageId = randomUUID()
      let text = ''
      let reasoning = ''
      let responseUsage: ModelUsage | undefined
      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      yield { type: 'assistant-start', messageId, cache }
      try {
        for await (const event of this.ctx.models.stream(provider, request)) {
          if (event.type === 'text-delta') {
            text += event.delta
            yield { type: 'assistant-delta', messageId, delta: event.delta }
          } else if (event.type === 'reasoning-delta') {
            reasoning += event.delta
            yield { type: 'assistant-reasoning-delta', messageId, delta: event.delta }
          } else if (event.type === 'tool-call-delta') {
            const current = calls.get(event.index) ?? { id: event.id ?? `call-${event.index}`, name: '', arguments: '' }
            if (event.id) current.id = event.id
            if (event.name) current.name += event.name
            if (event.argumentsDelta) current.arguments += event.argumentsDelta
            calls.set(event.index, current)
          } else if (event.type === 'usage') responseUsage = event.usage
        }
      } catch (error) {
        await this.ctx.audit.record({
          id: randomUUID(), type: 'model.error', timestamp: new Date().toISOString(), projectRoot: options.cwd,
          runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          data: { provider, model, durationMs: Date.now() - modelStartedAt, error: formatUnknownError(error) },
        })
        const status = options.signal?.aborted ? 'cancelled' : 'failed'
        await finishRun(status, step)
        this.ctx.emit('harness/agent/finish', latestText, step, status)
        throw error
      }
      const assembledCalls = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => assembleToolCall(index, call))
      const toolCalls = assembledCalls.map(item => item.call)
      previousRequest = request
      const response = { text, reasoning, toolCalls, ...(responseUsage ? { usage: responseUsage } : {}) }
      usage = addUsage(usage, response.usage)
      await lifecycle?.afterModel({ ...lifecycleContext, step, ...(response.usage ? { responseUsage: response.usage } : {}), usage })
      latestText = response.text || latestText
      messages.push({
        role: 'assistant',
        content: response.text,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
      })

      yield {
        type: 'assistant-finish', messageId, text: response.text,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      }
      await this.ctx.audit.record({
        id: randomUUID(), type: 'model.finish', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        data: { provider, model, step, durationMs: Date.now() - modelStartedAt, toolCalls: response.toolCalls.length, ...(response.usage ?? {}) },
      })
      if (options.conversationId) {
        sequence = await this.ctx.conversations.append(options.conversationId, sequence, [{
          type: 'assistant', messageId, text: response.text,
          ...(response.reasoning ? { reasoning: response.reasoning } : {}),
          ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
          createdAt: new Date().toISOString(),
        }])
      }

      if (!response.toolCalls.length) {
        this.ctx.emit('harness/agent/finish', latestText, step, 'complete')
        yield {
          type: 'finish',
          text: latestText,
          steps: step,
          status: 'complete',
          ...(Object.keys(usage).length ? { usage } : {}),
        }
        await finishRun('complete', step)
        return latestText
      }

      for (const [index, call] of response.toolCalls.entries()) {
        yield { type: 'tool-call', call }
        const parseError = assembledCalls[index]?.parseError
        const result: { output: unknown; presentation?: ToolPresentation } = parseError
          ? { output: { error: parseError } }
          : await this.executeTool(call, { ...options, runId })
        if (parseError) {
          await this.ctx.audit.record({
            id: randomUUID(), type: 'tool.error', timestamp: new Date().toISOString(), projectRoot: options.cwd,
            runId, ...(options.conversationId ? { conversationId: options.conversationId } : {}),
            toolCallId: call.id, data: { name: call.name, error: parseError },
          })
        }
        const { output } = result
        yield { type: 'tool-result', call, output, ...(result.presentation ? { presentation: result.presentation } : {}) }
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: serializeToolOutput(output),
        })
        if (options.conversationId) {
          sequence = await this.ctx.conversations.append(options.conversationId, sequence, [{
            type: 'tool', messageId: randomUUID(), toolCallId: call.id, name: call.name,
            content: serializeToolOutput(output),
            ...(result.presentation ? { presentation: result.presentation } : {}),
            createdAt: new Date().toISOString(),
          }])
        }
      }
      }

      if (maxSteps === undefined) throw new Error('unbounded agent loop terminated unexpectedly')
      const stopped = latestText || `Stopped after ${maxSteps} model steps because the configured step limit was reached.`
      this.ctx.emit('harness/agent/finish', stopped, maxSteps, 'limit-reached')
      yield {
        type: 'finish',
        text: stopped,
        steps: maxSteps,
        status: 'limit-reached',
        ...(Object.keys(usage).length ? { usage } : {}),
      }
      await finishRun('limit-reached', maxSteps)
      return stopped
    } catch (error) {
      if (!terminalRecorded) {
        const status = options.signal?.aborted ? 'cancelled' : 'failed'
        await finishRun(status, attemptedSteps)
        this.ctx.emit('harness/agent/finish', latestText, attemptedSteps, status)
      }
      throw error
    } finally {
      // Closing an async generator early is a cancellation even without an AbortSignal.
      if (!terminalRecorded) await finishRun('cancelled', attemptedSteps)
    }
  }

  private async executeTool(
    call: ToolCall,
    options: AgentRunOptions,
  ): Promise<{ output: unknown; presentation?: ToolPresentation }> {
    const tool = this.ctx.tools.get(call.name)
    if (!tool) return { output: { error: `Tool "${call.name}" is not registered.` } }

    const startedAt = Date.now()
    try {
      let presentation: ToolPresentation | undefined
      const permission = tool.permission?.(call.arguments as JsonObject)
      if (permission) await this.ctx.permissions.authorize(permission, {
        cwd: options.cwd,
        ...(options.conversationId ? { sessionId: options.conversationId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        toolCallId: call.id,
      })
      await this.ctx.audit.record({
        id: randomUUID(), type: 'tool.start', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        ...(options.runId ? { runId: options.runId } : {}), ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        toolCallId: call.id, data: { name: call.name },
      })
      this.ctx.emit('harness/tool/start', call.name, call.arguments)
      const output = await tool.execute(call.arguments, {
        cwd: options.cwd,
        ...(options.conversationId ? { sessionId: options.conversationId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        toolCallId: call.id,
        ...(options.signal ? { signal: options.signal } : {}),
        present(value) {
          if (!value.type || value.type.length > 100 || /[^a-z\d._-]/i.test(value.type)) {
            throw new TypeError('tool presentation type must be a bounded identifier')
          }
          presentation = value
        },
      })
      this.ctx.emit('harness/tool/finish', call.name, output)
      await this.ctx.audit.record({
        id: randomUUID(), type: 'tool.finish', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        ...(options.runId ? { runId: options.runId } : {}), ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        toolCallId: call.id, data: { name: call.name, durationMs: Date.now() - startedAt },
      })
      return { output, ...(presentation ? { presentation } : {}) }
    } catch (error) {
      const output = { error: formatUnknownError(error) }
      this.ctx.emit('harness/tool/finish', call.name, output)
      await this.ctx.audit.record({
        id: randomUUID(), type: 'tool.error', timestamp: new Date().toISOString(), projectRoot: options.cwd,
        ...(options.runId ? { runId: options.runId } : {}), ...(options.conversationId ? { conversationId: options.conversationId } : {}), toolCallId: call.id,
        data: { name: call.name, durationMs: Date.now() - startedAt, error: formatUnknownError(error) },
      })
      return { output }
    }
  }
}

function recordToModelMessage(record: ConversationRecord): ModelMessage | undefined {
  if (record.type === 'user') return { role: 'user', content: record.text }
  if (record.type === 'context') return { role: 'user', content: formatRuntimeContext(record.source, record.text) }
  if (record.type === 'checkpoint') return { role: 'user', content: formatCheckpoint(record.summary) }
  if (record.type === 'assistant') return {
    role: 'assistant', content: record.text,
    ...(record.reasoning ? { reasoning: record.reasoning } : {}),
    ...(record.toolCalls?.length ? { toolCalls: record.toolCalls } : {}),
  }
  if (record.type === 'tool' || record.type === 'tool-prune') {
    return { role: 'tool', content: record.content, toolCallId: record.toolCallId, name: record.name }
  }
  return undefined
}

export default DefaultAgentService
