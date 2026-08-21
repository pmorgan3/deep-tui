import type { Context } from 'cordis'
import {
  fallbackConversationTitle,
  formatUnknownError,
  type AgentEvent,
  type CommandEnvironment,
  type ConversationRecord,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionResponse,
  type Theme,
  type TuiActions,
  type TuiKeyEvent,
  type TuiLaunchOptions,
  type TuiOverlay,
  type TuiShell,
  type TuiState,
  type TuiViewportMetrics,
  type ModelUsage,
} from '@deep-tui/sdk'
import { conversationSurface, formatCheckpoint } from '@deep-tui/sdk'
import { background, TuiInputDecoder } from './ansi.js'
import { layoutTuiFrame } from './frame.js'

interface RawInput extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?(enabled: boolean): void
  resume?(): void
}

interface ScreenOutput {
  isTTY?: boolean
  columns?: number
  rows?: number
  write(chunk: string): void
  on?(event: 'resize', listener: () => void): void
  off?(event: 'resize', listener: () => void): void
}

export interface DefaultTuiShellConfig {
  provider: string
  model: string
  models: readonly string[]
  contextWindows: Readonly<Record<string, number>>
  color: boolean
  requireTty: boolean
  mouse: boolean
  scrollLines: number
  renderFps: number
}

interface ApprovalWaiter {
  resolve(response: PermissionResponse): void
}

/** Keep only the newest coordinate in a burst of terminal motion reports. */
export function coalesceMouseMoves(events: readonly TuiKeyEvent[]): TuiKeyEvent[] {
  const output: TuiKeyEvent[] = []
  for (const event of events) {
    if (event.name === 'mouse-move' && output.at(-1)?.name === 'mouse-move') output[output.length - 1] = event
    else output.push(event)
  }
  return output
}

/** Produce a full first frame or absolute-row updates for changed terminal rows. */
export function renderFrameUpdate(
  previous: string | undefined,
  next: string,
  backgroundCode = '',
  forceFull = false,
): string {
  const rows = next.split('\r\n')
  const previousRows = previous?.split('\r\n')
  if (forceFull || !previousRows || previousRows.length !== rows.length) {
    return `\u001b[H${backgroundCode}${next}\u001b[J\u001b[0m`
  }
  let output = ''
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index] === previousRows[index]) continue
    output += `\u001b[${index + 1};1H\u001b[2K${backgroundCode}${rows[index] ?? ''}`
  }
  return output ? `${output}\u001b[0m` : ''
}

export function mergeUsage(total: ModelUsage, next: ModelUsage | undefined): ModelUsage {
  if (!next) return total
  const add = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
  const inputTokens = add(total.inputTokens, next.inputTokens)
  const cachedInputTokens = add(total.cachedInputTokens, next.cachedInputTokens)
  const uncachedInputTokens = add(total.uncachedInputTokens, next.uncachedInputTokens)
  const outputTokens = add(total.outputTokens, next.outputTokens)
  const calculatedCostUsd = add(total.calculatedCostUsd, next.calculatedCostUsd)
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

/** Return only aggregate usage not already observed on individual assistant turns. */
export function unaccountedUsage(total: ModelUsage | undefined, accounted: ModelUsage): ModelUsage {
  if (!total) return {}
  const difference = (key: keyof Pick<ModelUsage,
    'inputTokens' | 'cachedInputTokens' | 'uncachedInputTokens' | 'outputTokens' | 'calculatedCostUsd'>) => {
    const value = total[key]
    if (value === undefined) return undefined
    return Math.max(0, value - (accounted[key] ?? 0))
  }
  const inputTokens = difference('inputTokens')
  const cachedInputTokens = difference('cachedInputTokens')
  const uncachedInputTokens = difference('uncachedInputTokens')
  const outputTokens = difference('outputTokens')
  const calculatedCostUsd = difference('calculatedCostUsd')
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(total.contextTokens === undefined ? {} : { contextTokens: total.contextTokens }),
    ...(calculatedCostUsd === undefined ? {} : { calculatedCostUsd }),
  }
}

export class DefaultTuiShell implements TuiShell {
  readonly id = 'deep-tui.default-shell'
  readonly priority = -100
  private active: TuiSession | undefined

  constructor(
    private readonly ctx: Context,
    private readonly theme: Theme,
    private readonly config: DefaultTuiShellConfig,
  ) {}

  async run(environment: CommandEnvironment, options: TuiLaunchOptions): Promise<number> {
    if (this.active) throw new Error('the default TUI shell is already running')
    const input = environment.stdin as RawInput
    const output = environment.stdout as ScreenOutput
    if (this.config.requireTty && (!input.isTTY || !output.isTTY)) {
      throw new Error('the TUI requires an interactive terminal; use "deep-tui run" for pipes and scripts')
    }
    const session = new TuiSession(this.ctx, this.theme, this.config, environment, options)
    this.active = session
    try {
      return await session.run()
    } finally {
      if (this.active === session) this.active = undefined
    }
  }

  requestPermission(request: PermissionRequest): Promise<PermissionResponse> | 'abstain' {
    return this.active?.requestPermission(request) ?? 'abstain'
  }

  updateConversationTitle(conversationId: string, title: string): void {
    this.active?.updateConversationTitle(conversationId, title)
  }
}

class TuiSession implements TuiActions {
  readonly state: TuiState
  private readonly input: RawInput
  private readonly output: ScreenOutput
  private stopped = false
  private screenActive = false
  private abort: AbortController | undefined
  private task: Promise<void> | undefined
  private approval: ApprovalWaiter | undefined
  private removeSubscription: (() => void) | undefined
  private removeThemeSubscription: (() => void) | undefined
  private viewportMetrics: Readonly<Record<string, TuiViewportMetrics>> = {}
  private readonly streamMessages = new Map<string, number>()
  private runUsage: ModelUsage = {}
  private renderTimer: NodeJS.Timeout | undefined
  private activityTimer: NodeJS.Timeout | undefined
  private lastStreamRender = 0
  private renderBatchDepth = 0
  private renderPending = false
  private lastFrame: { output: string; width: number; height: number; theme: Theme; color: boolean } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly theme: Theme,
    private readonly config: DefaultTuiShellConfig,
    private readonly environment: CommandEnvironment,
    options: TuiLaunchOptions,
  ) {
    this.input = environment.stdin as RawInput
    this.output = environment.stdout as ScreenOutput
    const configuredModels = [...config.models]
    const model = options.model ?? config.model
    if (!configuredModels.includes(model)) configuredModels.unshift(model)
    this.state = {
      cwd: environment.cwd,
      width: this.output.columns ?? 100,
      height: this.output.rows ?? 30,
      provider: options.provider ?? config.provider,
      model,
      models: configuredModels,
      theme: this.ctx.themes.current()?.id ?? theme.id,
      contextWindow: this.contextWindow(model),
      usage: {},
      input: options.initialPrompt ?? '',
      cursor: (options.initialPrompt ?? '').length,
      slashSelection: 0,
      viewports: { transcript: { top: 0, follow: true, unseen: 0 } },
      busy: false,
      status: 'ready',
      events: [],
      startedAt: Date.now(),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      conversationPersistence: this.ctx.conversations.isDurable() ? 'durable' : 'ephemeral',
    }
  }

  async run(): Promise<number> {
    if (this.state.conversationId) await this.loadConversation(this.state.conversationId)
    await this.ctx.tui.startSession(this)
    this.state.theme = this.ctx.themes.current()?.id ?? this.theme.id
    const wasRaw = this.input.isRaw ?? false
    const decoder = new TuiInputDecoder()
    const resize = () => {
      this.state.width = this.output.columns ?? this.state.width
      this.state.height = this.output.rows ?? this.state.height
      this.render()
    }
    try {
      this.removeSubscription = this.ctx.tui.subscribe(() => this.render())
      this.removeThemeSubscription = this.ctx.themes.subscribe(() => {
        this.state.theme = this.ctx.themes.current()?.id ?? this.theme.id
        this.render()
      })
      this.output.on?.('resize', resize)
      this.input.setRawMode?.(true)
      this.input.resume?.()
      this.output.write(`\u001b[?1049h\u001b[?25l${this.config.mouse ? '\u001b[?1003h\u001b[?1006h' : ''}\u001b[2J\u001b[H\u001b]0;Deep TUI\u0007`)
      this.screenActive = true
      this.render()
      if (this.state.input.trim()) void this.submit()

      for await (const chunk of this.input) {
        for (const event of coalesceMouseMoves(decoder.push(chunk))) {
          await this.batchRender(async () => {
            const bindings = this.ctx.tui.bindings(event)
            for (const binding of bindings) {
              if (await binding.handle(event, this)) break
            }
          })
          if (this.stopped) break
        }
        if (this.stopped) break
      }
      return 0
    } finally {
      this.stopped = true
      this.screenActive = false
      this.abort?.abort(new Error('TUI closed'))
      this.answerPermission('deny')
      await this.task?.catch(() => undefined)
      let stopError: unknown
      try {
        await this.ctx.tui.stopSession(this)
      } catch (error) {
        stopError = error
      }
      this.removeSubscription?.()
      this.removeThemeSubscription?.()
      if (this.renderTimer) clearTimeout(this.renderTimer)
      this.stopActivityAnimation()
      this.output.off?.('resize', resize)
      this.input.setRawMode?.(wasRaw)
      this.output.write(`${this.config.mouse ? '\u001b[?1006l\u001b[?1003l' : ''}\u001b[?25h\u001b[?1049l\u001b]0;\u0007`)
      if (stopError) throw stopError
    }
  }

  setInput(value: string, cursor = value.length): void {
    this.state.input = value
    this.state.cursor = Math.max(0, Math.min(cursor, value.length))
    this.state.slashSelection = 0
    delete this.state.notice
    delete this.state.error
    delete this.state.overlay
    this.render()
  }

  updateConversationTitle(conversationId: string, title: string): void {
    if (this.state.conversationId !== conversationId || this.state.conversationTitle === title) return
    this.state.conversationTitle = title
    this.render()
  }

  async submit(): Promise<void> {
    if (this.state.approval) {
      this.notify('answer the permission request first')
      return
    }
    const prompt = this.state.input.trim()
    if (!prompt) return
    if (prompt.startsWith('/')) {
      try {
        const executed = await this.ctx.tui.executeSlash(prompt, this)
        if (!executed) {
          if (this.acceptSlashSuggestion()) return
          this.state.error = `unknown slash command "${prompt.split(/\s/, 1)[0]}"`
          this.render()
          return
        }
        this.state.input = ''
        this.state.cursor = 0
        this.state.slashSelection = 0
        delete this.state.error
        this.render()
      } catch (error) {
        this.state.error = formatUnknownError(error)
        this.render()
      }
      return
    }
    if (this.state.busy) {
      this.notify('the agent is already working')
      return
    }
    if (!this.state.conversationId) {
      const conversation = await this.ctx.conversations.create({
        title: fallbackConversationTitle(prompt), projectRoot: this.environment.cwd,
        provider: this.state.provider, model: this.state.model,
      })
      this.state.conversationId = conversation.id
      this.state.conversationTitle = conversation.title
    }
    this.state.input = ''
    this.state.cursor = 0
    this.state.busy = true
    this.runUsage = {}
    delete this.state.latestUsage
    delete this.state.cachePrefix
    this.state.status = 'thinking'
    this.startActivityAnimation()
    delete this.state.error
    delete this.state.notice
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.task = this.consume(this.ctx.agent.run(prompt, {
      cwd: this.environment.cwd,
      provider: this.state.provider,
      model: this.state.model,
      conversationId: this.state.conversationId,
      signal,
    }), signal)
    this.render()
  }

  exit(): void {
    this.stopped = true
  }

  cancel(): boolean {
    if (!this.abort) return false
    this.abort.abort(new Error('cancelled by user'))
    this.state.status = 'cancelling'
    this.render()
    return true
  }

  clear(): void {
    if (this.state.busy) {
      this.notify('wait for the current run before clearing')
      return
    }
    this.state.events = []
    this.state.expandedReasoning = {}
    delete this.state.hoveredReasoning
    this.state.viewports = { transcript: { top: 0, follow: true, unseen: 0 } }
    delete this.state.error
    delete this.state.notice
    this.state.status = 'ready'
    this.render()
  }

  cycleModel(offset = 1): void {
    const models = this.state.models
    if (!models.length) return
    const current = Math.max(0, models.indexOf(this.state.model))
    const next = (current + offset + models.length) % models.length
    this.state.model = models[next] ?? this.state.model
    this.state.contextWindow = this.contextWindow(this.state.model)
    this.notify(`model switched to ${this.state.model}`)
  }

  setModel(model: string): void {
    if (!model) return
    this.state.model = model
    if (!this.state.models.includes(model)) this.state.models = [model, ...this.state.models]
    this.state.contextWindow = this.contextWindow(model)
    this.notify(`model switched to ${model}`)
  }

  notify(message: string): void {
    this.state.notice = message
    this.render()
  }

  showOverlay(overlay: TuiOverlay): void {
    this.state.overlay = overlay
    this.render()
  }

  closeOverlay(): void {
    delete this.state.overlay
    this.render()
  }

  moveSlashSelection(offset: number): void {
    const suggestions = this.ctx.tui.slashSuggestions(this.state.input, this.state)
    if (!suggestions.length) return
    this.state.slashSelection = (
      this.state.slashSelection + offset + suggestions.length
    ) % suggestions.length
    this.render()
  }

  acceptSlashSuggestion(): boolean {
    const suggestions = this.ctx.tui.slashSuggestions(this.state.input, this.state)
    const suggestion = suggestions[this.state.slashSelection % Math.max(1, suggestions.length)]
    if (!suggestion) return false
    this.setInput(suggestion.value)
    return true
  }

  scrollViewport(id: string, lines: number): void {
    const current = this.state.viewports[id] ?? { top: 0, follow: true, unseen: 0 }
    const metrics = this.viewportMetrics[id]
    if (!metrics) return
    const resolved = current.follow ? metrics.maxTop : metrics.top
    const top = Math.max(0, Math.min(metrics.maxTop, resolved + lines))
    const follow = top >= metrics.maxTop
    this.state.viewports = {
      ...this.state.viewports,
      [id]: { top, follow, unseen: follow ? 0 : current.unseen },
    }
    this.render()
  }

  pageViewport(id: string, pages: number): void {
    const height = this.viewportMetrics[id]?.height ?? 1
    this.scrollViewport(id, pages * Math.max(1, height - 1))
  }

  followViewport(id: string): void {
    const current = this.state.viewports[id] ?? { top: 0, follow: true, unseen: 0 }
    this.state.viewports = { ...this.state.viewports, [id]: { ...current, follow: true, unseen: 0 } }
    this.render()
  }

  toggleReasoning(messageId?: string): void {
    let target = messageId
    if (!target) {
      const latest = [...this.state.events].reverse().find(event =>
        event.type === 'assistant-finish' && Boolean(event.reasoning))
      if (latest?.type === 'assistant-finish') target = latest.messageId
    }
    if (!target) {
      this.notify('no model reasoning is available yet')
      return
    }
    const expanded = this.state.expandedReasoning ?? {}
    this.state.expandedReasoning = { ...expanded, [target]: !expanded[target] }
    this.render()
  }

  setHoveredReasoning(messageId?: string): void {
    if (this.state.hoveredReasoning === messageId) return
    if (messageId) this.state.hoveredReasoning = messageId
    else delete this.state.hoveredReasoning
    this.render()
  }

  revealEvent(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.events.length) return
    this.state.revealEventIndex = index
    const current = this.state.viewports.transcript ?? { top: 0, follow: true, unseen: 0 }
    this.state.viewports = {
      ...this.state.viewports,
      transcript: { ...current, follow: false, unseen: 0 },
    }
    this.render()
  }

  selectPermissionCandidate(offset: number): void {
    const candidates = this.state.approval?.remember ?? []
    if (!candidates.length) return
    this.state.permissionSelection = ((this.state.permissionSelection ?? 0) + offset + candidates.length) % candidates.length
    this.render()
  }

  async newConversation(title?: string): Promise<void> {
    if (this.state.busy) throw new Error('wait for the current run before starting a conversation')
    const conversation = await this.ctx.conversations.create({
      ...(title ? { title } : {}),
      projectRoot: this.environment.cwd,
      provider: this.state.provider,
      model: this.state.model,
    })
    this.state.conversationId = conversation.id
    this.state.conversationTitle = conversation.title
    this.state.events = []
    this.state.expandedReasoning = {}
    delete this.state.hoveredReasoning
    this.state.usage = {}
    delete this.state.latestUsage
    delete this.state.cachePrefix
    this.state.viewports = { transcript: { top: 0, follow: true, unseen: 0 } }
    this.notify(`started ${conversation.title}`)
  }

  async openConversation(id: string): Promise<void> {
    if (this.state.busy) throw new Error('wait for the current run before resuming a conversation')
    await this.loadConversation(id)
    this.state.notice = `resumed ${this.state.conversationTitle ?? id}`
    this.render()
  }

  async forkConversation(throughSeq?: number): Promise<void> {
    if (!this.state.conversationId) throw new Error('no active conversation to fork')
    const fork = await this.ctx.conversations.fork(this.state.conversationId, throughSeq)
    await this.loadConversation(fork.id)
    this.notify(`forked to ${fork.title}`)
  }

  async renameConversation(title: string): Promise<void> {
    if (!this.state.conversationId) throw new Error('no active conversation to rename')
    const updated = await this.ctx.conversations.update(this.state.conversationId, { title })
    this.state.conversationTitle = updated.title
    this.notify(`renamed conversation to ${updated.title}`)
  }

  answerPermission(response: PermissionResponse | Exclude<PermissionDecision, 'abstain'>): void {
    const waiter = this.approval
    if (!waiter) return
    const normalized = typeof response === 'string' ? { decision: response } : response
    this.approval = undefined
    delete this.state.approval
    delete this.state.permissionSelection
    this.state.status = normalized.decision === 'allow' ? 'permission allowed' : 'permission denied'
    waiter.resolve(normalized)
    this.render()
  }

  requestPermission(request: PermissionRequest): Promise<PermissionResponse> {
    if (this.approval) return Promise.resolve({ decision: 'deny' })
    this.state.approval = request
    this.state.permissionSelection = 0
    this.state.status = 'permission required'
    this.render()
    return new Promise(resolve => {
      this.approval = { resolve }
    })
  }

  private async consume(events: AsyncGenerator<AgentEvent, string>, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of events) {
        let appended = true
        if (event.type === 'assistant-start') {
          if (event.cache) this.state.cachePrefix = event.cache
          else delete this.state.cachePrefix
          const index = this.state.events.length
          this.streamMessages.set(event.messageId, index)
          this.state.events = [...this.state.events, { type: 'assistant-finish', messageId: event.messageId, text: '' }]
        } else if (event.type === 'assistant-delta') {
          appended = false
          const index = this.streamMessages.get(event.messageId)
          const current = index === undefined ? undefined : this.state.events[index]
          if (index !== undefined && current?.type === 'assistant-finish') {
            const next = [...this.state.events]
            next[index] = { ...current, text: `${current.text}${event.delta}` }
            this.state.events = next
          }
        } else if (event.type === 'assistant-reasoning-delta') {
          appended = false
          const index = this.streamMessages.get(event.messageId)
          const current = index === undefined ? undefined : this.state.events[index]
          if (index !== undefined && current?.type === 'assistant-finish') {
            const next = [...this.state.events]
            next[index] = { ...current, reasoning: `${current.reasoning ?? ''}${event.delta}` }
            this.state.events = next
          }
        } else if (event.type === 'assistant-finish') {
          appended = false
          const index = this.streamMessages.get(event.messageId)
          if (index !== undefined) {
            const next = [...this.state.events]
            next[index] = event
            this.state.events = next
            this.streamMessages.delete(event.messageId)
          } else {
            appended = true
            this.state.events = [...this.state.events, event]
          }
        } else {
          this.state.events = [...this.state.events, event]
        }
        const viewport = this.state.viewports.transcript
        if (appended && viewport && !viewport.follow) {
          this.state.viewports = {
            ...this.state.viewports,
            transcript: { ...viewport, unseen: viewport.unseen + 1 },
          }
        }
        if (event.type === 'tool-call') this.state.status = `running ${event.call.name}`
        else if (event.type === 'tool-result') this.state.status = `finished ${event.call.name}`
        else if (event.type === 'finish') {
          this.state.status = event.status === 'limit-reached'
            ? `stopped · step limit reached after ${event.steps}`
            : `ready · ${event.steps} step${event.steps === 1 ? '' : 's'}`
        }
        else this.state.status = 'thinking'
        if ((event.type === 'assistant' || event.type === 'assistant-finish') && event.usage) {
          this.runUsage = mergeUsage(this.runUsage, event.usage)
          this.state.usage = mergeUsage(this.state.usage, event.usage)
          this.state.latestUsage = event.usage
        } else if (event.type === 'finish') {
          this.state.usage = mergeUsage(this.state.usage, unaccountedUsage(event.usage, this.runUsage))
        }
        if (event.type === 'finish') this.render()
        else this.scheduleStreamRender()
      }
    } catch (error) {
      if (!signal.aborted) {
        this.state.error = formatUnknownError(error)
        this.state.status = 'failed'
      }
    } finally {
      this.state.busy = false
      this.abort = undefined
      this.task = undefined
      this.runUsage = {}
      this.stopActivityAnimation()
      if (this.renderTimer) {
        clearTimeout(this.renderTimer)
        this.renderTimer = undefined
      }
      this.render()
    }
  }

  private render(): void {
    if (this.stopped || !this.screenActive) return
    if (this.renderBatchDepth > 0) {
      this.renderPending = true
      return
    }
    const theme = this.ctx.themes.current() ?? this.theme
    const layout = layoutTuiFrame(this.ctx.tui, this.state, theme, this.config.color)
    this.viewportMetrics = layout.viewports
    if (this.state.revealEventIndex !== undefined) {
      const metrics = layout.viewports.transcript
      if (metrics) {
        this.state.viewports = {
          ...this.state.viewports,
          transcript: { top: metrics.top, follow: false, unseen: 0 },
        }
      }
      delete this.state.revealEventIndex
    }
    const previous = this.lastFrame
    const forceFull = !previous
      || previous.width !== this.state.width
      || previous.height !== this.state.height
      || previous.theme !== theme
      || previous.color !== this.config.color
    const update = renderFrameUpdate(
      previous?.output,
      layout.output,
      background(theme, this.config.color),
      forceFull,
    )
    this.lastFrame = {
      output: layout.output,
      width: this.state.width,
      height: this.state.height,
      theme,
      color: this.config.color,
    }
    if (update) this.output.write(update)
  }

  private async batchRender(work: () => Promise<void>): Promise<void> {
    this.renderBatchDepth += 1
    try {
      await work()
    } finally {
      this.renderBatchDepth -= 1
      if (this.renderBatchDepth === 0 && this.renderPending) {
        this.renderPending = false
        this.render()
      }
    }
  }

  private scheduleStreamRender(): void {
    if (this.renderTimer) return
    const interval = Math.max(1, Math.floor(1_000 / this.config.renderFps))
    const delay = Math.max(0, interval - (Date.now() - this.lastStreamRender))
    if (delay === 0) {
      this.lastStreamRender = Date.now()
      this.render()
      return
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      this.lastStreamRender = Date.now()
      this.render()
    }, delay)
  }

  private startActivityAnimation(): void {
    this.stopActivityAnimation()
    this.state.runStartedAt = Date.now()
    this.state.activityFrame = 0
    this.activityTimer = setInterval(() => {
      this.state.activityFrame = (this.state.activityFrame ?? 0) + 1
      this.render()
    }, 90)
    this.activityTimer.unref?.()
  }

  private stopActivityAnimation(): void {
    if (this.activityTimer) clearInterval(this.activityTimer)
    this.activityTimer = undefined
  }

  private async loadConversation(id: string): Promise<void> {
    const conversation = await this.ctx.conversations.get(id)
    if (!conversation) throw new Error(`conversation "${id}" was not found`)
    const events: AgentEvent[] = []
    let usage: ModelUsage = {}
    let latestUsage: ModelUsage | undefined
    const records: ConversationRecord[] = []
    for await (const record of this.ctx.conversations.read(id)) records.push(record)
    for (const record of conversationSurface(records)) {
      if (record.type === 'user') events.push({ type: 'start', input: record.text })
      else if (record.type === 'checkpoint') events.push({ type: 'start', input: formatCheckpoint(record.summary) })
      else if (record.type === 'assistant') {
        events.push({
          type: 'assistant-finish', messageId: record.messageId, text: record.text,
          ...(record.reasoning ? { reasoning: record.reasoning } : {}),
          ...(record.usage ? { usage: record.usage } : {}),
        })
        if (record.usage) latestUsage = record.usage
        for (const call of record.toolCalls ?? []) events.push({ type: 'tool-call', call })
      } else if (record.type === 'tool' || record.type === 'tool-prune') {
        events.push({
          type: 'tool-result', call: { id: record.toolCallId, name: record.name, arguments: {} }, output: record.content,
          ...(record.presentation ? { presentation: record.presentation } : {}),
        })
      }
    }
    for (const record of records) {
      if (record.type === 'run' && (record.status === 'complete' || record.status === 'limit-reached')) {
        usage = mergeUsage(usage, record.usage)
      }
    }
    const route = [...records].reverse().find(record => record.type === 'envelope')
    this.state.conversationId = conversation.id
    this.state.conversationTitle = conversation.title
    this.state.provider = route?.type === 'envelope' ? route.envelope.provider : conversation.provider
    this.state.model = route?.type === 'envelope' ? route.envelope.model : conversation.model
    this.state.events = events
    this.state.expandedReasoning = {}
    delete this.state.hoveredReasoning
    this.state.usage = usage
    if (latestUsage) this.state.latestUsage = latestUsage
    else delete this.state.latestUsage
    delete this.state.cachePrefix
    this.state.viewports = { transcript: { top: 0, follow: true, unseen: 0 } }
  }

  private contextWindow(model: string): number {
    return this.config.contextWindows[model]
      ?? this.config.contextWindows.default
      ?? 0
  }
}
