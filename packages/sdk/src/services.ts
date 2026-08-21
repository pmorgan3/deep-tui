import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type {
  AgentRunMetadata,
  AgentRunStatus,
  AgentRuntime,
  AgentLifecycleFinishContext,
  AgentLifecycleHook,
  AgentLifecycleModelContext,
  AgentLifecycleRunContext,
  AgentLifecycleStepContext,
  AuditEvent,
  AuditRedactor,
  AuditSink,
  BillingProvider,
  BillingBalance,
  CommandDefinition,
  CommandEnvironment,
  Conversation,
  ConversationRecord,
  ConversationStore,
  CreateConversation,
  NewConversationRecord,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelUsage,
  ToolCall,
  PermissionDecision,
  PermissionPolicy,
  PermissionContext,
  PermissionReceipt,
  PermissionRequest,
  PermissionRule,
  PermissionResponse,
  ProjectContextConfig,
  PromptContext,
  PromptAssembly,
  PromptSection,
  Theme,
  TuiComponent,
  TuiCodeHighlighter,
  TuiEmptyStateSection,
  TuiEventRenderer,
  TuiKeyEvent,
  TuiKeybinding,
  TuiLaunchOptions,
  TuiRenderContext,
  TuiSessionHook,
  TuiSidebarSection,
  TuiSlashCommand,
  TuiSlashSuggestion,
  TuiShell,
  TuiStatusItem,
  TuiState,
  TuiActions,
  ToolDefinition,
  UiRenderer,
  WorkspaceProvider,
  WorkspaceRoot,
  WorkspaceWalkOptions,
  ToolExecutionContext,
  WorkspaceEntry,
} from './types.js'
import { canonicalizeJsonObject, stableJsonStringify, type Disposer } from './utility.js'

interface Identified {
  id: string
}

abstract class ContributionService<T extends Identified> extends Service {
  protected readonly items = new Map<string, T>()

  protected registerItem(item: T, kind: string): Disposer {
    if (!item.id) throw new TypeError(`${kind} id cannot be empty`)
    if (this.items.has(item.id)) throw new Error(`${kind} "${item.id}" is already registered`)

    return this.ctx.effect(() => {
      this.items.set(item.id, item)
      this.onChanged()
      return () => {
        if (this.items.get(item.id) === item) {
          this.items.delete(item.id)
          this.onChanged()
        }
      }
    }, `${kind}:${item.id}`)
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  list(): T[] {
    return [...this.items.values()]
  }

  protected onChanged(): void {}
}

export class CommandService extends ContributionService<CommandDefinition & Identified> {
  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  register(command: CommandDefinition): Disposer {
    return this.registerItem({ ...command, id: command.name }, 'command')
  }

  async execute(name: string, args: string[], environment: CommandEnvironment): Promise<number> {
    const command = this.get(name)
    if (!command) throw new Error(`unknown command "${name}"`)
    return (await command.run(args, environment)) ?? 0
  }

  defaultName(): string | undefined {
    return this.list()
      .filter(command => command.default)
      .sort((left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) || left.name.localeCompare(right.name))[0]?.name
  }
}

export class ModelService extends ContributionService<ModelProvider> {
  constructor(ctx: Context) {
    super(ctx, 'models')
  }

  register(provider: ModelProvider): Disposer {
    return this.registerItem(provider, 'model provider')
  }

  complete(providerId: string, request: ModelRequest): Promise<ModelResponse> {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`model provider "${providerId}" is not registered`)
    return provider.complete(request)
  }

  async *stream(providerId: string, request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`model provider "${providerId}" is not registered`)
    if (provider.stream) {
      yield* provider.stream(request)
      return
    }
    const response = await provider.complete(request)
    if (response.reasoning) yield { type: 'reasoning-delta', delta: response.reasoning }
    if (response.text) yield { type: 'text-delta', delta: response.text }
    for (let index = 0; index < response.toolCalls.length; index += 1) {
      const call = response.toolCalls[index]
      if (!call) continue
      yield {
        type: 'tool-call-delta',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.rawArguments ?? stableJsonStringify(call.arguments),
      }
    }
    if (response.usage) yield { type: 'usage', usage: response.usage }
    yield { type: 'finish' }
  }
}

/** Ordered, replaceable policy hooks around agent runs and model steps. */
export class AgentLifecycleService extends ContributionService<AgentLifecycleHook> {
  private readonly active = new Map<string, AgentLifecycleHook[]>()

  constructor(ctx: Context) {
    super(ctx, 'agentHooks')
  }

  register(hook: AgentLifecycleHook): Disposer {
    return this.registerItem(hook, 'agent lifecycle hook')
  }

  private ordered(): AgentLifecycleHook[] {
    return this.list().sort((left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
  }

  async start(context: AgentLifecycleRunContext): Promise<void> {
    if (this.active.has(context.runId)) throw new Error(`agent run "${context.runId}" already started lifecycle hooks`)
    const started: AgentLifecycleHook[] = []
    this.active.set(context.runId, started)
    try {
      for (const hook of this.ordered()) {
        started.push(hook)
        await hook.beforeRun?.(context)
      }
    } catch (error) {
      this.active.delete(context.runId)
      const finish: AgentLifecycleFinishContext = { ...context, steps: 0, status: 'failed', usage: {} }
      await Promise.allSettled([...started].reverse().map(hook => hook.afterRun?.(finish)))
      throw error
    }
  }

  async beforeStep(context: AgentLifecycleStepContext): Promise<string | undefined> {
    for (const hook of this.active.get(context.runId) ?? []) {
      const reason = (await hook.beforeStep?.(context))?.trim()
      if (reason) return reason
    }
    return undefined
  }

  async afterModel(context: AgentLifecycleModelContext): Promise<void> {
    for (const hook of this.active.get(context.runId) ?? []) await hook.afterModel?.(context)
  }

  async finish(context: AgentLifecycleFinishContext): Promise<void> {
    const hooks = this.active.get(context.runId)
    if (!hooks) return
    this.active.delete(context.runId)
    const results = await Promise.allSettled([...hooks].reverse().map(hook => hook.afterRun?.(context)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length === 1) throw failures[0]?.reason
    if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), 'agent lifecycle cleanup failed')
  }
}

/** Collect a provider stream into the same canonical response returned by complete(). */
export async function collectModelStream(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelResponse> {
  let text = ''
  let reasoning = ''
  let usage: ModelUsage | undefined
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  for await (const event of stream) {
    if (event.type === 'text-delta') text += event.delta
    else if (event.type === 'reasoning-delta') reasoning += event.delta
    else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'tool-call-delta') {
      const current = calls.get(event.index) ?? { id: event.id ?? `call-${event.index}`, name: '', arguments: '' }
      if (event.id) current.id = event.id
      if (event.name) current.name += event.name
      if (event.argumentsDelta) current.arguments += event.argumentsDelta
      calls.set(event.index, current)
    }
  }
  const toolCalls: ToolCall[] = [...calls.entries()].sort(([left], [right]) => left - right).map(([index, call]) => {
    if (!call.name) throw new Error(`provider streamed tool call ${index} without a name`)
    const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`provider tool call ${call.name} arguments must be an object`)
    }
    return {
      id: call.id,
      name: call.name,
      arguments: parsed as Record<string, unknown>,
      ...(call.arguments ? { rawArguments: call.arguments } : {}),
    }
  })
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    ...(usage ? { usage } : {}),
  }
}

export class BillingService extends ContributionService<BillingProvider> {
  constructor(ctx: Context) {
    super(ctx, 'billing')
  }

  register(provider: BillingProvider): Disposer {
    return this.registerItem(provider, 'billing provider')
  }

  balances(providerId: string): Promise<readonly BillingBalance[]> {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`billing provider "${providerId}" is not registered`)
    return provider.balances()
  }
}

export class ToolService extends ContributionService<ToolDefinition & Identified> {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: ToolDefinition): Disposer {
    return this.registerItem({ ...tool, id: tool.name }, 'tool')
  }

  definitions(): ToolDefinition[] {
    return this.list()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(tool => ({ ...tool, inputSchema: canonicalizeJsonObject(tool.inputSchema) }))
  }
}

export class PromptService extends ContributionService<PromptSection> {
  constructor(ctx: Context) {
    super(ctx, 'prompts')
  }

  register(section: PromptSection): Disposer {
    return this.registerItem(section, 'prompt section')
  }

  async assemble(context: PromptContext): Promise<PromptAssembly> {
    const sections = this.list().sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
    const output = await Promise.all(sections.map(section => section.render(context)))
    const resolved = sections.flatMap((section, index) => {
      const text = output[index]?.trim()
      return text ? [{ section, text }] : []
    })
    return {
      system: resolved.filter(item => item.section.placement !== 'context').map(item => item.text).join('\n\n'),
      contexts: resolved.filter(item => item.section.placement === 'context')
        .map(item => ({ id: item.section.id, text: item.text })),
    }
  }

  /** Compatibility renderer for prompt previews; the agent uses assemble(). */
  async render(context: PromptContext): Promise<string> {
    const assembly = await this.assemble(context)
    return [assembly.system, ...assembly.contexts.map(item => item.text)].filter(Boolean).join('\n\n')
  }
}

export class PermissionService extends ContributionService<PermissionPolicy> {
  constructor(ctx: Context) {
    super(ctx, 'permissions')
  }

  register(policy: PermissionPolicy): Disposer {
    return this.registerItem(policy, 'permission policy')
  }

  async authorize(request: PermissionRequest, context: PermissionContext = { cwd: '.' }): Promise<PermissionReceipt> {
    const requestId = randomUUID()
    const audit = this.ctx.get('audit') as AuditService | undefined
    const project = this.ctx.get('project') as ProjectService | undefined
    const projectRoot = project?.root ?? context.cwd
    await audit?.record({
      id: randomUUID(), type: 'permission.request', timestamp: new Date().toISOString(), projectRoot,
      requestId, ...(context.runId ? { runId: context.runId } : {}),
      ...(context.sessionId ? { conversationId: context.sessionId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      data: { capability: request.capability, risk: request.risk, candidates: (request.remember ?? []).map(item => item.key) },
    })
    const policies = this.list().sort((left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
    let decision: PermissionDecision | PermissionReceipt = 'abstain'
    let policyId: string | undefined
    for (const policy of policies) {
      decision = await policy.decide(request, context)
      const value = typeof decision === 'string' ? decision : decision.decision
      if (value !== 'abstain') {
        policyId = policy.id
        break
      }
    }
    const receipt: PermissionReceipt = typeof decision === 'string'
      ? { decision: decision === 'allow' ? 'allow' : 'deny', ...(policyId ? { policyId } : {}) }
      : { ...decision, ...(decision.policyId || !policyId ? {} : { policyId }) }
    const rule = receipt.ruleId
      ? (this.ctx.get('permissionRules') as PermissionRuleService | undefined)?.list().find(item => item.id === receipt.ruleId)
      : undefined
    await audit?.record({
      id: randomUUID(), type: 'permission.decision', timestamp: new Date().toISOString(), projectRoot,
      requestId, ...(context.runId ? { runId: context.runId } : {}),
      ...(context.sessionId ? { conversationId: context.sessionId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      data: {
        decision: receipt.decision, ...(receipt.policyId ? { policyId: receipt.policyId } : {}),
        ...(receipt.ruleId ? { ruleId: receipt.ruleId } : {}), ...(rule ? { rememberedScope: rule.scope, ruleKey: rule.key } : {}),
      },
    })
    if (receipt.decision !== 'allow') {
      throw new Error(`permission denied: ${request.description}`)
    }
    return receipt
  }
}

export class PermissionRuleService extends Service {
  private readonly rules = new Map<string, PermissionRule>()
  private readonly listeners = new Set<() => void>()
  private readonly writers = new Set<(rules: readonly PermissionRule[]) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'permissionRules')
  }

  add(input: Omit<PermissionRule, 'id' | 'createdAt' | 'decision'> & Partial<Pick<PermissionRule, 'id' | 'createdAt'>>): PermissionRule {
    if (!input.key || input.key.length > 500 || /[\u0000-\u001f\u007f]/.test(input.key)) {
      throw new TypeError('permission rule key must be a non-empty, bounded namespaced string')
    }
    const existing = this.list().find(rule => rule.key === input.key && rule.scope === input.scope
      && path.resolve(rule.projectRoot) === path.resolve(input.projectRoot)
      && rule.sessionId === input.sessionId)
    if (existing) return existing
    const rule: PermissionRule = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      decision: 'allow',
    }
    this.rules.set(rule.id, rule)
    this.notify()
    return rule
  }

  remove(id: string): boolean {
    const removed = this.rules.delete(id)
    if (removed) this.notify()
    return removed
  }

  clear(scope?: PermissionRule['scope']): void {
    if (!scope) this.rules.clear()
    else for (const [id, rule] of this.rules) if (rule.scope === scope) this.rules.delete(id)
    this.notify()
  }

  list(): PermissionRule[] {
    return [...this.rules.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  match(keys: readonly string[], context: PermissionContext): PermissionRule | undefined {
    const rules = this.list()
    for (const key of keys) {
      const match = rules.find(rule => rule.key === key
        && path.resolve(rule.projectRoot) === path.resolve(context.cwd)
        && (rule.scope !== 'session' || rule.sessionId === context.sessionId))
      if (match) return match
    }
    return undefined
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  registerWriter(writer: (rules: readonly PermissionRule[]) => Promise<void>): Disposer {
    this.writers.add(writer)
    return () => {
      this.writers.delete(writer)
    }
  }

  async persist(): Promise<void> {
    const projectRules = this.list().filter(rule => rule.scope === 'project')
    await Promise.all([...this.writers].map(writer => writer(projectRules)))
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export class ProjectService extends Service<ProjectContextConfig> {
  readonly root: string
  readonly invocationCwd: string
  readonly configFiles: readonly string[]

  constructor(ctx: Context, config: ProjectContextConfig = {}) {
    super(ctx, 'project')
    this.root = path.resolve(config.root ?? process.cwd())
    this.invocationCwd = path.resolve(config.invocationCwd ?? this.root)
    this.configFiles = config.configFiles ?? []
  }

  statePath(...segments: string[]): string {
    const base = path.join(this.root, '.deep-tui')
    const resolved = path.resolve(base, ...segments)
    const relative = path.relative(base, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('project state path escapes .deep-tui')
    }
    return resolved
  }
}

export class WorkspaceService extends ContributionService<WorkspaceProvider> {
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'workspace')
  }

  register(provider: WorkspaceProvider): Disposer {
    return this.registerItem(provider, 'workspace provider')
  }

  private provider(): WorkspaceProvider {
    const provider = this.list().sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0]
    if (!provider) throw new Error('no workspace provider is registered')
    return provider
  }

  resolveRead(relative: string, context: ToolExecutionContext): Promise<string> {
    return this.provider().resolveRead(relative, context)
  }

  resolveWrite(relative: string, context: ToolExecutionContext): Promise<string> {
    return this.provider().resolveWrite(relative, context)
  }

  walk(options: WorkspaceWalkOptions, context: ToolExecutionContext): AsyncIterable<WorkspaceEntry> {
    return this.provider().walk(options, context)
  }

  async roots(context: ToolExecutionContext): Promise<readonly WorkspaceRoot[]> {
    const provider = this.provider()
    return await provider.roots?.(context) ?? [{
      id: 'primary', label: path.basename(context.cwd) || context.cwd,
      path: path.resolve(context.cwd), prefix: '.', primary: true,
      access: 'read-write', available: true,
    }]
  }

  displayPath(absolute: string, context: ToolExecutionContext): Promise<string> {
    const provider = this.provider()
    return provider.displayPath?.(absolute, context)
      ?? Promise.resolve(path.relative(path.resolve(context.cwd), path.resolve(absolute)) || '.')
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  invalidate(): void { this.notify() }

  protected override onChanged(): void { this.notify() }

  private notify(): void { for (const listener of this.listeners) listener() }
}

class MemoryConversationStore implements ConversationStore {
  readonly id = 'memory'
  readonly priority = -1_000
  private readonly conversations = new Map<string, Conversation>()
  private readonly records = new Map<string, ConversationRecord[]>()

  async create(input: CreateConversation): Promise<Conversation> {
    const now = new Date().toISOString()
    const conversation: Conversation = {
      id: randomUUID(),
      title: input.title?.trim() || 'New conversation',
      projectRoot: input.projectRoot,
      provider: input.provider,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    }
    this.conversations.set(conversation.id, conversation)
    this.records.set(conversation.id, [])
    return conversation
  }

  async get(id: string): Promise<Conversation | undefined> {
    return this.conversations.get(id)
  }

  async list(): Promise<readonly Conversation[]> {
    return [...this.conversations.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async *read(id: string): AsyncIterable<ConversationRecord> {
    if (!this.conversations.has(id)) throw new Error(`conversation "${id}" does not exist`)
    yield* this.records.get(id) ?? []
  }

  async append(id: string, expectedSeq: number, records: readonly NewConversationRecord[]): Promise<number> {
    const conversation = this.conversations.get(id)
    if (!conversation) throw new Error(`conversation "${id}" does not exist`)
    const current = this.records.get(id) ?? []
    if (current.length !== expectedSeq) throw new Error(`conversation changed; expected sequence ${expectedSeq}, got ${current.length}`)
    const appended = records.map((record, index) => ({ ...record, seq: expectedSeq + index + 1 } as ConversationRecord))
    this.records.set(id, [...current, ...appended])
    this.conversations.set(id, { ...conversation, updatedAt: new Date().toISOString() })
    return expectedSeq + appended.length
  }

  async update(id: string, patch: Partial<Pick<Conversation, 'title' | 'provider' | 'model'>>): Promise<Conversation> {
    const current = this.conversations.get(id)
    if (!current) throw new Error(`conversation "${id}" does not exist`)
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.conversations.set(id, updated)
    return updated
  }

  async remove(id: string): Promise<void> {
    this.conversations.delete(id)
    this.records.delete(id)
  }

  async fork(id: string, throughSeq = Number.POSITIVE_INFINITY): Promise<Conversation> {
    const current = this.conversations.get(id)
    if (!current) throw new Error(`conversation "${id}" does not exist`)
    const fork = await this.create({
      title: `${current.title} (fork)`,
      projectRoot: current.projectRoot,
      provider: current.provider,
      model: current.model,
      parentId: current.id,
    })
    const source = (this.records.get(id) ?? []).filter(record => record.seq <= throughSeq)
    this.records.set(fork.id, source.map((record, index) => ({ ...record, seq: index + 1 })))
    return fork
  }
}

export class ConversationService extends Service {
  private readonly memory = new MemoryConversationStore()
  private readonly stores = new Map<string, ConversationStore>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'conversations')
  }

  registerStore(store: ConversationStore): Disposer {
    if (!store.id) throw new TypeError('conversation store id cannot be empty')
    if (this.stores.has(store.id)) throw new Error(`conversation store "${store.id}" is already registered`)
    return this.ctx.effect(() => {
      this.stores.set(store.id, store)
      this.notify()
      return () => {
        if (this.stores.get(store.id) === store) {
          this.stores.delete(store.id)
          this.notify()
        }
      }
    }, `conversation store:${store.id}`)
  }

  store(): ConversationStore {
    return [...this.stores.values()].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0] ?? this.memory
  }

  isDurable(): boolean { return this.store().durable === true }
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void { for (const listener of this.listeners) listener() }
  private validateId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`invalid conversation id: ${id}`)
  }

  async create(input: CreateConversation): Promise<Conversation> { const value = await this.store().create(input); this.notify(); return value }
  get(id: string): Promise<Conversation | undefined> { this.validateId(id); return this.store().get(id) }
  list(): Promise<readonly Conversation[]> { return this.store().list() }
  async *read(id: string): AsyncIterable<ConversationRecord> {
    this.validateId(id)
    let expected = 1
    for await (const record of this.store().read(id)) {
      if (record.seq !== expected) throw new Error(`conversation "${id}" has invalid sequence ${record.seq}; expected ${expected}`)
      expected += 1
      yield record
    }
  }
  async append(id: string, expectedSeq: number, records: readonly NewConversationRecord[]): Promise<number> {
    this.validateId(id)
    const sequence = await this.store().append(id, expectedSeq, records)
    this.notify()
    return sequence
  }
  async update(id: string, patch: Partial<Pick<Conversation, 'title' | 'provider' | 'model'>>): Promise<Conversation> {
    this.validateId(id)
    const value = await this.store().update(id, patch)
    this.notify()
    return value
  }
  async remove(id: string): Promise<void> { this.validateId(id); await this.store().remove(id); this.notify() }
  async fork(id: string, throughSeq?: number): Promise<Conversation> {
    this.validateId(id)
    const value = await this.store().fork(id, throughSeq)
    this.notify()
    return value
  }
}

export class ThemeService extends ContributionService<Theme> {
  private readonly listeners = new Set<() => void>()
  private activeId: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'themes')
  }

  register(theme: Theme): Disposer {
    return this.registerItem(theme, 'theme')
  }

  select(id: string): Theme {
    const theme = this.get(id)
    if (!theme) throw new Error(`theme "${id}" is not registered`)
    if (this.activeId !== id) {
      this.activeId = id
      this.notify()
    }
    return theme
  }

  current(): Theme | undefined {
    return (this.activeId ? this.get(this.activeId) : undefined) ?? this.list()[0]
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  protected override onChanged(): void {
    if (this.activeId && !this.get(this.activeId)) this.activeId = undefined
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export class UiService extends ContributionService<UiRenderer> {
  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  register(renderer: UiRenderer): Disposer {
    return this.registerItem(renderer, 'UI renderer')
  }
}

interface PrioritizedContribution extends Identified {
  priority?: number
}

interface ContributionLayer<T> {
  item: T
  order: number
}

class LayeredRegistry<T extends PrioritizedContribution> {
  private readonly layers = new Map<string, ContributionLayer<T>[]>()
  private order = 0

  constructor(private readonly changed: () => void) {}

  register(ctx: Context, item: T, kind: string): Disposer {
    if (!item.id) throw new TypeError(`${kind} id cannot be empty`)
    return ctx.effect(() => {
      const layer = { item, order: this.order++ }
      const current = this.layers.get(item.id) ?? []
      current.push(layer)
      this.layers.set(item.id, current)
      this.changed()
      return () => {
        const remaining = this.layers.get(item.id)?.filter(candidate => candidate !== layer) ?? []
        if (remaining.length) this.layers.set(item.id, remaining)
        else this.layers.delete(item.id)
        this.changed()
      }
    }, `${kind}:${item.id}`)
  }

  list(): T[] {
    const active: ContributionLayer<T>[] = []
    for (const layers of this.layers.values()) {
      const winner = [...layers].sort(compareLayers)[0]
      if (winner) active.push(winner)
    }
    return active.sort(compareLayers).map(layer => layer.item)
  }
}

function compareLayers<T extends PrioritizedContribution>(left: ContributionLayer<T>, right: ContributionLayer<T>): number {
  return (right.item.priority ?? 0) - (left.item.priority ?? 0) || right.order - left.order
}

export interface AuditServiceConfig { failureMode?: 'warn' | 'fail-closed' }

export class AuditService extends Service<AuditServiceConfig> {
  private readonly sinks: LayeredRegistry<AuditSink>
  private readonly redactors: LayeredRegistry<AuditRedactor>

  private readonly failureMode: 'warn' | 'fail-closed'

  constructor(ctx: Context, config: AuditServiceConfig = {}) {
    super(ctx, 'audit')
    this.failureMode = config.failureMode ?? 'warn'
    this.sinks = new LayeredRegistry(() => undefined)
    this.redactors = new LayeredRegistry(() => undefined)
  }

  registerSink(sink: AuditSink): Disposer {
    return this.sinks.register(this.ctx, sink, 'audit sink')
  }

  registerRedactor(redactor: AuditRedactor): Disposer {
    return this.redactors.register(this.ctx, redactor, 'audit redactor')
  }

  listSinks(): AuditSink[] { return this.sinks.list() }
  listRedactors(): AuditRedactor[] { return this.redactors.list() }

  async record(event: AuditEvent): Promise<void> {
    let current: AuditEvent | undefined = { ...event, version: 1 }
    for (const redactor of this.redactors.list()) {
      if (!current) return
      current = await redactor.redact(current)
    }
    if (!current) return
    const results = await Promise.allSettled(this.sinks.list().map(sink => sink.record(current as AuditEvent)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (!failures.length) return
    if (this.failureMode === 'fail-closed') throw new AggregateError(failures.map(result => result.reason), 'audit sink failure')
    process.emitWarning(`audit sink failure: ${failures.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)).join('; ')}`)
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled(this.sinks.list().map(sink => sink.flush?.()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length && this.failureMode === 'fail-closed') throw new AggregateError(failures.map(result => result.reason), 'audit flush failure')
    if (failures.length) process.emitWarning(`audit flush failure: ${failures.map(result => String(result.reason)).join('; ')}`)
  }
}

export class TuiService extends Service {
  private readonly listeners = new Set<() => void>()
  private readonly components: LayeredRegistry<TuiComponent>
  private readonly keybindings: LayeredRegistry<TuiKeybinding>
  private readonly shells: LayeredRegistry<TuiShell>
  private readonly slashCommands: LayeredRegistry<TuiSlashCommand>
  private readonly sessionHooks: LayeredRegistry<TuiSessionHook>
  private readonly eventRenderers: LayeredRegistry<TuiEventRenderer>
  private readonly statusItems: LayeredRegistry<TuiStatusItem>
  private readonly codeHighlighters: LayeredRegistry<TuiCodeHighlighter>
  private readonly sidebarSections: LayeredRegistry<TuiSidebarSection>
  private readonly emptyStateSections: LayeredRegistry<TuiEmptyStateSection>
  private readonly activeSessionHooks = new WeakMap<TuiActions, TuiSessionHook[]>()
  revision = 0

  constructor(ctx: Context) {
    super(ctx, 'tui')
    const changed = () => {
      this.revision += 1
      for (const listener of this.listeners) listener()
    }
    this.components = new LayeredRegistry(changed)
    this.keybindings = new LayeredRegistry(changed)
    this.shells = new LayeredRegistry(changed)
    this.slashCommands = new LayeredRegistry(changed)
    this.sessionHooks = new LayeredRegistry(changed)
    this.eventRenderers = new LayeredRegistry(changed)
    this.statusItems = new LayeredRegistry(changed)
    this.codeHighlighters = new LayeredRegistry(changed)
    this.sidebarSections = new LayeredRegistry(changed)
    this.emptyStateSections = new LayeredRegistry(changed)
  }

  registerComponent(component: TuiComponent): Disposer {
    if (!component.slot) throw new TypeError('TUI component slot cannot be empty')
    return this.components.register(this.ctx, component, 'TUI component')
  }

  component(slot: string): TuiComponent | undefined {
    return this.components.list().find(component => component.slot === slot)
  }

  listComponents(): TuiComponent[] {
    return this.components.list()
  }

  registerSidebarSection(section: TuiSidebarSection): Disposer {
    if (!section.title) throw new TypeError('TUI sidebar section title cannot be empty')
    return this.sidebarSections.register(this.ctx, section, 'TUI sidebar section')
  }

  listSidebarSections(): TuiSidebarSection[] {
    return this.sidebarSections.list().sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
  }

  registerEmptyStateSection(section: TuiEmptyStateSection): Disposer {
    return this.emptyStateSections.register(this.ctx, section, 'TUI empty-state section')
  }

  listEmptyStateSections(): TuiEmptyStateSection[] {
    return this.emptyStateSections.list()
  }

  registerKeybinding(keybinding: TuiKeybinding): Disposer {
    if (!keybinding.keys.length) throw new TypeError('TUI keybinding must declare at least one key')
    return this.keybindings.register(this.ctx, keybinding, 'TUI keybinding')
  }

  bindings(event: TuiKeyEvent): TuiKeybinding[] {
    const names = new Set([event.name, ...(event.text ? [event.text] : [])])
    return this.keybindings.list().filter(binding => binding.keys.some(key => names.has(key)))
  }

  listKeybindings(): TuiKeybinding[] {
    return this.keybindings.list()
  }

  registerEventRenderer(renderer: TuiEventRenderer): Disposer {
    return this.eventRenderers.register(this.ctx, renderer, 'TUI event renderer')
  }

  listEventRenderers(): TuiEventRenderer[] {
    return this.eventRenderers.list()
  }

  renderEvent(event: Parameters<TuiEventRenderer['render']>[0], context: TuiRenderContext): readonly string[] {
    const prepend: string[][] = []
    const append: string[][] = []
    let replacement: readonly string[] | undefined
    for (const renderer of this.eventRenderers.list()) {
      if ((renderer.mode ?? 'replace') === 'replace' && replacement) continue
      const lines = renderer.render(event, context)
      if (!lines) continue
      if (renderer.mode === 'prepend') prepend.push([...lines])
      else if (renderer.mode === 'append') append.push([...lines])
      else replacement = lines
    }
    return [...prepend.flat(), ...(replacement ?? []), ...append.flat()]
  }

  registerStatusItem(item: TuiStatusItem): Disposer {
    return this.statusItems.register(this.ctx, item, 'TUI status item')
  }

  listStatusItems(): TuiStatusItem[] {
    return this.statusItems.list()
  }

  registerCodeHighlighter(highlighter: TuiCodeHighlighter): Disposer {
    return this.codeHighlighters.register(this.ctx, highlighter, 'TUI code highlighter')
  }

  listCodeHighlighters(): TuiCodeHighlighter[] {
    return this.codeHighlighters.list()
  }

  highlightCode(code: string, language: string | undefined, context: TuiRenderContext) {
    const highlighters = this.codeHighlighters.list()
    if (context.phase === 'measure' && highlighters.length) {
      return code.split('\n').map(text => ({ spans: [{ text }] }))
    }
    for (const highlighter of highlighters) {
      const lines = highlighter.highlight(code, language, context)
      if (lines) return lines
    }
    return undefined
  }

  registerSlashCommand(command: TuiSlashCommand): Disposer {
    if (!/^[a-z\d][a-z\d_-]*$/i.test(command.name)) {
      throw new TypeError(`invalid TUI slash command name "${command.name}"`)
    }
    for (const alias of command.aliases ?? []) {
      if (!/^[a-z\d][a-z\d_-]*$/i.test(alias)) {
        throw new TypeError(`invalid TUI slash command alias "${alias}"`)
      }
    }
    return this.slashCommands.register(this.ctx, command, 'TUI slash command')
  }

  listSlashCommands(): TuiSlashCommand[] {
    const names = new Set<string>()
    return this.slashCommands.list().filter(command => {
      const name = command.name.toLowerCase()
      if (names.has(name)) return false
      names.add(name)
      return true
    })
  }

  slashCommand(name: string): TuiSlashCommand | undefined {
    const normalized = name.toLowerCase()
    return this.listSlashCommands().find(command =>
      command.name.toLowerCase() === normalized
      || command.aliases?.some(alias => alias.toLowerCase() === normalized))
  }

  slashSuggestions(input: string, state: Readonly<TuiState>): TuiSlashSuggestion[] {
    const beforeCursor = input.slice(0, state.cursor)
    if (!beforeCursor.startsWith('/')) return []
    const body = beforeCursor.slice(1)
    const separator = body.search(/\s/)
    if (separator < 0) {
      const query = body.toLowerCase()
      return this.listSlashCommands()
        .filter(command => command.name.toLowerCase().startsWith(query)
          || command.aliases?.some(alias => alias.toLowerCase().startsWith(query)))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(command => ({
          command: command.name,
          value: `/${command.name}${command.complete ? ' ' : ''}`,
          label: `/${command.name}`,
          description: command.description,
        }))
    }

    const name = body.slice(0, separator)
    const command = this.slashCommand(name)
    if (!command?.complete) return []
    const rawArguments = body.slice(separator + 1)
    const match = rawArguments.match(/(?:^|\s)([^\s]*)$/)
    const query = match?.[1] ?? ''
    const prefix = beforeCursor.slice(0, beforeCursor.length - query.length)
    const args = tokenizeSlashArguments(rawArguments)
    return command.complete({ args, query, state }).map(suggestion => ({
      command: command.name,
      value: `${prefix}${suggestion.value}`,
      label: suggestion.label ?? suggestion.value,
      description: suggestion.description ?? command.description,
    }))
  }

  async executeSlash(input: string, actions: TuiActions): Promise<boolean> {
    const match = input.trim().match(/^\/([^\s]+)(?:\s+(.*))?$/s)
    if (!match?.[1]) return false
    const command = this.slashCommand(match[1])
    if (!command) return false
    await command.run(tokenizeSlashArguments(match[2] ?? ''), actions)
    return true
  }

  registerSessionHook(hook: TuiSessionHook): Disposer {
    return this.sessionHooks.register(this.ctx, hook, 'TUI session hook')
  }

  listSessionHooks(): TuiSessionHook[] {
    return this.sessionHooks.list()
  }

  async startSession(actions: TuiActions): Promise<void> {
    if (this.activeSessionHooks.has(actions)) throw new Error('TUI session hooks have already started')
    const started: TuiSessionHook[] = []
    try {
      for (const hook of this.sessionHooks.list()) {
        await hook.start(actions)
        started.push(hook)
      }
      this.activeSessionHooks.set(actions, started)
    } catch (error) {
      await stopHooks(started, actions).catch(() => undefined)
      throw error
    }
  }

  async stopSession(actions: TuiActions): Promise<void> {
    const started = this.activeSessionHooks.get(actions)
    if (!started) return
    this.activeSessionHooks.delete(actions)
    await stopHooks(started, actions)
  }

  registerShell(shell: TuiShell): Disposer {
    return this.shells.register(this.ctx, shell, 'TUI shell')
  }

  shell(): TuiShell | undefined {
    return this.shells.list()[0]
  }

  async run(environment: CommandEnvironment, options: TuiLaunchOptions = {}): Promise<number> {
    const shell = this.shell()
    if (!shell) throw new Error('no TUI shell is registered')
    return shell.run(environment, options)
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Request a repaint after plugin-owned state changes. */
  invalidate(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

async function stopHooks(hooks: readonly TuiSessionHook[], actions: TuiActions): Promise<void> {
  const errors: unknown[] = []
  for (const hook of [...hooks].reverse()) {
    try {
      await hook.stop?.(actions)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'multiple TUI session hooks failed to stop')
}

function tokenizeSlashArguments(value: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g
  for (const match of value.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined) tokens.push(token.replace(/\\([\\"'])/g, '$1'))
  }
  return tokens
}

declare module 'cordis' {
  interface Context {
    project: ProjectService
    commands: CommandService
    audit: AuditService
    billing: BillingService
    conversations: ConversationService
    models: ModelService
    tools: ToolService
    workspace: WorkspaceService
    prompts: PromptService
    permissions: PermissionService
    permissionRules: PermissionRuleService
    themes: ThemeService
    ui: UiService
    tui: TuiService
    agent: AgentRuntime
    agentHooks: AgentLifecycleService
  }

  interface Events {
    'harness/agent/start'(input: string, metadata: AgentRunMetadata): void
    'harness/agent/finish'(
      output: string,
      steps: number,
      status: AgentRunStatus,
    ): void
    'harness/tool/start'(name: string, input: Record<string, unknown>): void
    'harness/tool/finish'(name: string, output: unknown): void
    'harness/conversation/title'(conversationId: string, title: string): void
  }
}
