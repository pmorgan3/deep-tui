import type { Awaitable } from './utility.js'

export type JsonObject = Record<string, unknown>

export interface ToolCall {
  id: string
  name: string
  arguments: JsonObject
  /** Exact provider-emitted JSON used when the call is passed back in history. */
  rawArguments?: string
}

export type ModelMessage =
  | {
    role: 'system' | 'user'
    content: string
  }
  | {
    role: 'assistant'
    content: string
    reasoning?: string
    toolCalls?: ToolCall[]
  }
  | {
    role: 'tool'
    content: string
    toolCallId: string
    name: string
  }

export interface ModelTool {
  name: string
  description: string
  inputSchema: JsonObject
}

export interface ModelEnvelope {
  provider: string
  model: string
  system?: string
  tools: ModelTool[]
  fingerprint: string
}

export interface ModelRequest {
  model: string
  messages: ModelMessage[]
  tools: ModelTool[]
  signal?: AbortSignal
}

export interface ModelUsage {
  inputTokens?: number
  cachedInputTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  contextTokens?: number
  calculatedCostUsd?: number
}

export interface ModelResponse {
  text: string
  reasoning?: string
  toolCalls: ToolCall[]
  usage?: ModelUsage
}

export type ModelStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'finish'; reason?: string }

export interface ModelProvider {
  id: string
  complete(request: ModelRequest): Promise<ModelResponse>
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>
}

export interface BillingBalance {
  currency: string
  total: string
  granted?: string
  toppedUp?: string
}

export interface BillingProvider {
  id: string
  balances(): Promise<readonly BillingBalance[]>
}

export interface ToolExecutionContext {
  cwd: string
  sessionId?: string
  runId?: string
  toolCallId?: string
  signal?: AbortSignal
  /** Attach UI-only structured metadata without adding it to model-facing tool output. */
  present?(presentation: ToolPresentation): void
}

export interface ToolPresentation {
  type: string
  data: JsonObject
}

export type PermissionRisk = 'read' | 'write' | 'execute' | 'network'

export interface PermissionRuleCandidate {
  key: string
  label: string
  description?: string
}

export interface PermissionRequest {
  capability: string
  description: string
  risk: PermissionRisk
  metadata?: JsonObject
  remember?: readonly PermissionRuleCandidate[]
}

export interface PermissionContext {
  cwd: string
  sessionId?: string
  runId?: string
  toolCallId?: string
}

export interface PermissionReceipt {
  decision: 'allow' | 'deny'
  policyId?: string
  ruleId?: string
}

export interface PermissionResponse {
  decision: 'allow' | 'deny'
  remember?: 'session' | 'project'
  ruleKey?: string
}

export interface PermissionRule {
  id: string
  key: string
  label: string
  decision: 'allow'
  scope: 'session' | 'project'
  projectRoot: string
  sessionId?: string
  createdAt: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
  permission?: (input: JsonObject) => PermissionRequest
  execute(input: JsonObject, context: ToolExecutionContext): Awaitable<unknown>
}

export interface PromptContext {
  cwd: string
  model: string
}

export interface PromptSection {
  id: string
  order?: number
  /** Runtime context is snapshotted at the conversation tail instead of mutating the system prefix. */
  placement?: 'system' | 'context'
  render(context: PromptContext): Awaitable<string | undefined>
}

export interface PromptAssembly {
  system: string
  contexts: Array<{ id: string; text: string }>
}

export interface ThemeTokens {
  fontFamily: string
  fontSize: number
  colors: {
    background: string
    foreground: string
    muted: string
    accent: string
    success: string
    warning: string
    danger: string
    /** Background highlight color for inline code (backtick spans). When set,
     *  inline code renders as theme-background text on this highlight color. */
    inlineCode?: string
  }
  spacing: {
    compact: number
    normal: number
    relaxed: number
  }
  syntax?: Partial<Record<
    'comment' | 'keyword' | 'string' | 'number' | 'function' | 'type' |
    'variable' | 'operator' | 'punctuation' | 'constant' | 'property',
    string
  >>
}

export interface Theme {
  id: string
  label: string
  tokens: ThemeTokens
}

export type AgentRunStatus = 'complete' | 'cancelled' | 'failed' | 'limit-reached'

export interface AgentRunMetadata {
  cwd: string
  provider: string
  model: string
  conversationId?: string
}

export type AgentEvent =
  | { type: 'start'; input: string }
  | { type: 'assistant'; text: string; reasoning?: string; usage?: ModelUsage }
  | { type: 'assistant-start'; messageId: string; cache?: CachePrefixDiagnostics }
  | { type: 'assistant-delta'; messageId: string; delta: string }
  | { type: 'assistant-reasoning-delta'; messageId: string; delta: string }
  | { type: 'assistant-finish'; messageId: string; text: string; reasoning?: string; usage?: ModelUsage }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'tool-result'; call: ToolCall; output: unknown; presentation?: ToolPresentation }
  | { type: 'finish'; text: string; steps: number;
      status: Extract<AgentRunStatus, 'complete' | 'limit-reached'>; usage?: ModelUsage }

export interface CachePrefixDiagnostics {
  status: 'cold' | 'stable' | 'changed'
  reason?: 'new-conversation' | 'provider' | 'model' | 'system' | 'tools' | 'checkpoint' | 'history'
  stableMessages: number
  totalMessages: number
  envelopeFingerprint: string
}

export interface AgentRunOptions {
  cwd: string
  model?: string
  provider?: string
  conversationId?: string
  runId?: string
  signal?: AbortSignal
}

/** Stable metadata shared with replaceable agent lifecycle policies. */
export interface AgentLifecycleRunContext extends AgentRunMetadata {
  runId: string
  input: string
  signal?: AbortSignal
}

export interface AgentLifecycleStepContext extends AgentLifecycleRunContext {
  step: number
  /** Usage accumulated during this run before the requested model step. */
  usage: ModelUsage
}

export interface AgentLifecycleModelContext extends AgentLifecycleRunContext {
  step: number
  /** Usage reported by the model response that just finished. */
  responseUsage?: ModelUsage
  /** Usage accumulated across the run, including the response that just finished. */
  usage: ModelUsage
}

export interface AgentLifecycleFinishContext extends AgentLifecycleRunContext {
  steps: number
  status: AgentRunStatus
  usage: ModelUsage
}

/** A plugin-owned policy around an agent run. Returning a reason stops before a model step. */
export interface AgentLifecycleHook {
  id: string
  priority?: number
  beforeRun?(context: AgentLifecycleRunContext): Awaitable<void>
  beforeStep?(context: AgentLifecycleStepContext): Awaitable<string | undefined>
  afterModel?(context: AgentLifecycleModelContext): Awaitable<void>
  afterRun?(context: AgentLifecycleFinishContext): Awaitable<void>
}

export interface AgentRuntime {
  run(input: string, options: AgentRunOptions): AsyncGenerator<AgentEvent, string>
}

export interface OutputWriter {
  write(chunk: string): void
}

export interface CommandEnvironment {
  cwd: string
  sessionId?: string
  stdin: AsyncIterable<string | Uint8Array>
  stdout: OutputWriter
  stderr: OutputWriter
}

export interface CommandDefinition {
  name: string
  description: string
  usage?: string
  default?: boolean
  priority?: number
  run(args: string[], environment: CommandEnvironment): Awaitable<number | void>
}

export interface UiRenderer {
  id: string
  render(events: AsyncIterable<AgentEvent>, output: OutputWriter): Promise<string>
}

export type PermissionDecision = 'allow' | 'deny' | 'abstain'

export interface PermissionPolicy {
  id: string
  priority?: number
  decide(request: PermissionRequest, context: PermissionContext): Awaitable<PermissionDecision | PermissionReceipt>
}

export interface ProjectContextConfig {
  root?: string
  invocationCwd?: string
  configFiles?: readonly string[]
}

export interface Conversation {
  id: string
  title: string
  projectRoot: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  parentId?: string
}

export type ConversationRecord =
  | { seq: number; type: 'user'; messageId: string; text: string; createdAt: string }
  | { seq: number; type: 'context'; messageId: string; source: string; text: string; createdAt: string }
  | { seq: number; type: 'assistant'; messageId: string; text: string; reasoning?: string;
      toolCalls?: ToolCall[]; usage?: ModelUsage; createdAt: string }
  | { seq: number; type: 'tool'; messageId: string; toolCallId: string; name: string;
      content: string; presentation?: ToolPresentation; createdAt: string }
  | { seq: number; type: 'tool-prune'; sourceSeq: number; messageId: string; toolCallId: string; name: string;
      content: string; presentation?: ToolPresentation; createdAt: string }
  | { seq: number; type: 'checkpoint'; messageId: string; summary: string; sourceSeqs: number[]; createdAt: string }
  | { seq: number; type: 'envelope'; envelope: ModelEnvelope; createdAt: string }
  | { seq: number; type: 'run'; runId: string; usage?: ModelUsage; steps?: number;
      status: AgentRunStatus; createdAt: string }

export type NewConversationRecord = ConversationRecord extends infer Record
  ? Record extends ConversationRecord ? Omit<Record, 'seq'> : never
  : never

export interface CreateConversation {
  title?: string
  projectRoot: string
  provider: string
  model: string
  parentId?: string
}

export interface ConversationStore {
  id: string
  priority?: number
  durable?: boolean
  create(input: CreateConversation): Promise<Conversation>
  get(id: string): Promise<Conversation | undefined>
  list(): Promise<readonly Conversation[]>
  read(id: string): AsyncIterable<ConversationRecord>
  append(id: string, expectedSeq: number, records: readonly NewConversationRecord[]): Promise<number>
  update(id: string, patch: Partial<Pick<Conversation, 'title' | 'provider' | 'model'>>): Promise<Conversation>
  remove(id: string): Promise<void>
  fork(id: string, throughSeq?: number): Promise<Conversation>
}

export interface AuditEvent {
  version?: 1
  id: string
  type: 'run.start' | 'run.finish' | 'model.start' | 'model.finish' | 'model.error' |
    'permission.request' | 'permission.decision' | 'tool.start' | 'tool.finish' | 'tool.error'
  timestamp: string
  projectRoot: string
  projectId?: string
  runId?: string
  conversationId?: string
  toolCallId?: string
  requestId?: string
  data?: JsonObject
}

export interface AuditSink {
  id: string
  priority?: number
  record(event: AuditEvent): Awaitable<void>
  flush?(): Awaitable<void>
}

export interface AuditRedactor {
  id: string
  priority?: number
  redact(event: AuditEvent): Awaitable<AuditEvent | undefined>
}

export interface WorkspaceEntry {
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface WorkspaceWalkOptions {
  path?: string
  maxEntries?: number
  ignoredDirectories?: readonly string[]
}

export interface WorkspaceRoot {
  id: string
  label: string
  /** Absolute provider location. Interfaces may hide this when disclosure is undesirable. */
  path: string
  /** Virtual path prefix: `.` for primary, otherwise an address such as `@api`. */
  prefix: string
  primary: boolean
  access: 'read-only' | 'read-write'
  available: boolean
}

export interface WorkspaceProvider {
  id: string
  priority?: number
  resolveRead(relative: string, context: ToolExecutionContext): Promise<string>
  resolveWrite(relative: string, context: ToolExecutionContext): Promise<string>
  walk(options: WorkspaceWalkOptions, context: ToolExecutionContext): AsyncIterable<WorkspaceEntry>
  roots?(context: ToolExecutionContext): Awaitable<readonly WorkspaceRoot[]>
  displayPath?(absolute: string, context: ToolExecutionContext): Promise<string>
}

export interface TuiOverlay {
  id: string
  title: string
  lines: readonly string[]
  tone?: TuiTone
}

export interface TuiState {
  cwd: string
  width: number
  height: number
  provider: string
  model: string
  models: readonly string[]
  theme: string
  contextWindow: number
  usage: ModelUsage
  latestUsage?: ModelUsage
  cachePrefix?: CachePrefixDiagnostics
  input: string
  cursor: number
  slashSelection: number
  viewports: Readonly<Record<string, TuiViewportState>>
  busy: boolean
  status: string
  events: readonly AgentEvent[]
  startedAt: number
  runStartedAt?: number
  activityFrame?: number
  expandedReasoning?: Readonly<Record<string, boolean>>
  hoveredReasoning?: string
  conversationId?: string
  conversationTitle?: string
  conversationPersistence?: 'ephemeral' | 'durable'
  notice?: string
  error?: string
  approval?: PermissionRequest
  permissionSelection?: number
  overlay?: TuiOverlay
  /** One-shot transcript event target requested by an interactive UI contribution. */
  revealEventIndex?: number
}

export type TuiTone = keyof ThemeTokens['colors']

export interface TuiViewportState {
  top: number
  follow: boolean
  unseen: number
}

export interface TuiViewportMetrics {
  id: string
  top: number
  height: number
  total: number
  maxTop: number
}

export interface RichTextStyle {
  foreground?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

export interface RichTextSpan {
  text: string
  style?: RichTextStyle
  link?: string
}

export interface RichTextLine {
  spans: readonly RichTextSpan[]
}

export interface TuiRenderContext {
  state: Readonly<TuiState>
  theme: Theme
  width: number
  height: number
  color: boolean
  /** Lightweight layout pass. Code highlighters are skipped because they must
   *  preserve the source's logical line structure. */
  phase?: 'measure' | 'display'
  style(text: string, tone?: TuiTone, bold?: boolean): string
  fit(text: string, width?: number): string
  wrap(text: string, width?: number): string[]
  renderRich(lines: readonly RichTextLine[], width?: number): string[]
}

export interface TuiComponent {
  id: string
  slot: string
  priority?: number
  /** Optional live width request for layout-managed side regions such as the sidebar. */
  preferredWidth?(state: Readonly<TuiState>): number | undefined
  render(context: TuiRenderContext): readonly string[]
}

/** A stackable contribution rendered in place of an empty transcript. */
export interface TuiEmptyStateSection {
  id: string
  priority?: number
  render(context: TuiRenderContext): readonly string[] | undefined
}

/** A structured, optionally interactive row contributed to the sidebar. */
export interface TuiSidebarRow {
  id?: string
  text: string
  tone?: TuiTone
  bold?: boolean
  activate?(actions: TuiActions): Awaitable<void>
}

export interface TuiSidebarSectionView {
  rows: readonly TuiSidebarRow[]
  /** A smaller alternative used by the compositor on narrower terminals. */
  compactRows?: readonly TuiSidebarRow[]
}

/** A hot-swappable sidebar data source. Rendering is owned by a separate compositor plugin. */
export interface TuiSidebarSection {
  id: string
  title: string
  priority?: number
  order?: number
  render(context: TuiRenderContext): TuiSidebarSectionView | undefined
}

export interface TuiEventRenderer {
  id: string
  priority?: number
  /** Replace is the default. Prepend/append decorate the winning replacement renderer. */
  mode?: 'replace' | 'prepend' | 'append'
  render(event: AgentEvent, context: TuiRenderContext): readonly string[] | undefined
}

export interface TuiStatusItem {
  id: string
  priority?: number
  align?: 'left' | 'right'
  render(context: TuiRenderContext): string | undefined
}

export interface TuiCodeHighlighter {
  id: string
  priority?: number
  highlight(code: string, language: string | undefined, context: TuiRenderContext):
    readonly RichTextLine[] | undefined
}

export interface TuiKeyEvent {
  name: string
  sequence: string
  text?: string
  mouse?: { button: 'wheel-up' | 'wheel-down' | 'left' | 'left-drag' | 'left-release' | 'move'; x: number; y: number }
}

export interface TuiActions {
  readonly state: Readonly<TuiState>
  setInput(value: string, cursor?: number): void
  submit(): Promise<void>
  exit(): void
  clear(): void
  cycleModel(offset?: number): void
  setModel(model: string): void
  notify(message: string): void
  showOverlay(overlay: TuiOverlay): void
  closeOverlay(): void
  moveSlashSelection(offset: number): void
  acceptSlashSuggestion(): boolean
  scrollViewport(id: string, lines: number): void
  pageViewport(id: string, pages: number): void
  followViewport(id: string): void
  /** Expand or collapse the latest reasoning block, or a specific assistant message. */
  toggleReasoning(messageId?: string): void
  /** Update the reasoning disclosure currently under the pointer. */
  setHoveredReasoning?(messageId?: string): void
  /** Scroll the transcript to the first line rendered for an agent event. */
  revealEvent(index: number): void
  selectPermissionCandidate(offset: number): void
  cancel(): boolean
  newConversation(title?: string): Promise<void>
  openConversation(id: string): Promise<void>
  forkConversation(throughSeq?: number): Promise<void>
  renameConversation(title: string): Promise<void>
  answerPermission(response: PermissionResponse | Exclude<PermissionDecision, 'abstain'>): void
}

/** Lifecycle work contributed by plugins around an interactive TUI session. */
export interface TuiSessionHook {
  id: string
  priority?: number
  start(actions: TuiActions): Awaitable<void>
  stop?(actions: TuiActions): Awaitable<void>
}

export interface TuiKeybinding {
  id: string
  keys: readonly string[]
  description: string
  priority?: number
  handle(event: TuiKeyEvent, actions: TuiActions): Awaitable<boolean | void>
}

export interface TuiSlashCompletion {
  value: string
  label?: string
  description?: string
}

export interface TuiSlashCompletionContext {
  args: readonly string[]
  query: string
  state: Readonly<TuiState>
}

export interface TuiSlashSuggestion {
  command: string
  value: string
  label: string
  description: string
}

export interface TuiSlashCommand {
  id: string
  name: string
  aliases?: readonly string[]
  description: string
  usage?: string
  priority?: number
  complete?(context: TuiSlashCompletionContext): readonly TuiSlashCompletion[]
  run(args: readonly string[], actions: TuiActions): Awaitable<void>
}

export interface TuiLaunchOptions {
  provider?: string
  model?: string
  initialPrompt?: string
  conversationId?: string
}

export interface TuiShell {
  id: string
  priority?: number
  run(environment: CommandEnvironment, options: TuiLaunchOptions): Promise<number>
}
