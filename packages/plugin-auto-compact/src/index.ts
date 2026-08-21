import type { Context } from 'cordis'
import { compactConversation, type CompactConfig } from '@flect/plugin-compact'
import {
  conversationSurface,
  type AgentLifecycleRunContext,
  type ConversationRecord,
  type ConversationSurfaceRecord,
} from '@flect/sdk'

export interface AutoCompactConfig extends CompactConfig {
  enabled?: boolean
  /** Fraction of the model context window that triggers compaction. */
  threshold?: number
  /** Default window used when contextWindows has no model-specific entry. */
  contextWindow?: number
  contextWindows?: Record<string, number>
  /** Do not compact smaller model-facing histories. */
  minimumRecords?: number
  /** Do not compact below this many used or estimated tokens. */
  minimumTokens?: number
  /** Character/token ratio used only when provider usage is unavailable. */
  estimatedCharsPerToken?: number
  /** Continue the user request if automatic summarization fails. */
  failOpen?: boolean
}

export interface AutoCompactDecision {
  compact: boolean
  reason: 'disabled' | 'ephemeral' | 'small-history' | 'below-minimum' | 'below-threshold' | 'threshold'
  usedTokens: number
  contextWindow: number
  ratio: number
  records: number
}

interface AutoCompactStatus extends AutoCompactDecision {
  conversationId?: string
  compactedAt?: string
  error?: string
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

function finite(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be a number from ${minimum} through ${maximum}`)
  }
  return resolved
}

function recordCharacters(record: ConversationSurfaceRecord): number {
  if (record.type === 'user' || record.type === 'context') return record.text.length
  if (record.type === 'checkpoint') return record.summary.length
  if (record.type === 'tool' || record.type === 'tool-prune') return record.content.length
  return record.text.length + (record.reasoning?.length ?? 0) + JSON.stringify(record.toolCalls ?? []).length
}

function latestReportedContext(records: readonly ConversationRecord[]): number | undefined {
  const checkpoint = [...records].reverse().find(record => record.type === 'checkpoint')?.seq ?? 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (!record || record.seq <= checkpoint) break
    if (record.type === 'assistant') {
      const value = record.usage?.contextTokens ?? record.usage?.inputTokens
      if (value !== undefined) return Math.max(0, value)
    }
  }
  return undefined
}

export function decideAutoCompact(
  records: readonly ConversationRecord[],
  input: string,
  options: { enabled: boolean; contextWindow: number; threshold: number; minimumRecords: number; minimumTokens: number; charsPerToken: number },
): AutoCompactDecision {
  const surface = conversationSurface(records)
  const reported = latestReportedContext(records)
  const estimated = Math.ceil((surface.reduce((sum, record) => sum + recordCharacters(record), 0) + input.length) / options.charsPerToken)
  const usedTokens = Math.max(reported ?? 0, estimated)
  const ratio = options.contextWindow > 0 ? usedTokens / options.contextWindow : 0
  const base = { usedTokens, contextWindow: options.contextWindow, ratio, records: surface.length }
  if (!options.enabled) return { ...base, compact: false, reason: 'disabled' }
  if (surface.length < options.minimumRecords) return { ...base, compact: false, reason: 'small-history' }
  if (usedTokens < options.minimumTokens) return { ...base, compact: false, reason: 'below-minimum' }
  if (ratio < options.threshold) return { ...base, compact: false, reason: 'below-threshold' }
  return { ...base, compact: true, reason: 'threshold' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const name = 'automatic-compaction'
export const inject = ['agentHooks', 'conversations', 'models', 'prompts', 'tools', 'tui']

export function apply(ctx: Context, config: AutoCompactConfig = {}): void {
  const threshold = finite(config.threshold, 0.8, 0.1, 0.99, 'auto compact threshold')
  const contextWindow = integer(config.contextWindow, 1_000_000, 1_000, Number.MAX_SAFE_INTEGER, 'auto compact contextWindow')
  const contextWindows: Record<string, number> = { default: contextWindow, ...config.contextWindows }
  for (const [model, value] of Object.entries(contextWindows)) {
    integer(value, contextWindow, 1_000, Number.MAX_SAFE_INTEGER, `auto compact contextWindows.${model}`)
  }
  const minimumRecords = integer(config.minimumRecords, 12, 2, 100_000, 'auto compact minimumRecords')
  const minimumTokens = integer(config.minimumTokens, 8_000, 0, Number.MAX_SAFE_INTEGER, 'auto compact minimumTokens')
  const charsPerToken = finite(config.estimatedCharsPerToken, 4, 1, 20, 'auto compact estimatedCharsPerToken')
  let enabled = config.enabled !== false
  let status: AutoCompactStatus | undefined

  const evaluate = async (run: AgentLifecycleRunContext): Promise<void> => {
    if (!run.conversationId) {
      status = { compact: false, reason: 'ephemeral', usedTokens: 0, contextWindow: contextWindows[run.model] ?? contextWindows.default ?? contextWindow, ratio: 0, records: 0 }
      return
    }
    const records: ConversationRecord[] = []
    for await (const record of ctx.conversations.read(run.conversationId)) records.push(record)
    const window = contextWindows[run.model] ?? contextWindows.default ?? contextWindow
    const decision = decideAutoCompact(records, run.input, {
      enabled, contextWindow: window, threshold, minimumRecords, minimumTokens, charsPerToken,
    })
    status = { ...decision, conversationId: run.conversationId }
    if (!decision.compact) return
    try {
      await compactConversation(ctx, run.conversationId, {
        provider: config.provider ?? run.provider,
        model: config.model ?? run.model,
        ...(config.systemPrompt?.trim() ? { systemPrompt: config.systemPrompt } : {}),
        ...(config.maxTranscriptChars === undefined ? {} : { maxTranscriptChars: config.maxTranscriptChars }),
        ...(config.maxRecordChars === undefined ? {} : { maxRecordChars: config.maxRecordChars }),
        ...(config.maxSummaryChars === undefined ? {} : { maxSummaryChars: config.maxSummaryChars }),
        ...(config.retainRecentRecords === undefined ? {} : { retainRecentRecords: config.retainRecentRecords }),
      })
      status = { ...decision, conversationId: run.conversationId, compactedAt: new Date().toISOString() }
      ctx.tui.invalidate()
    } catch (error) {
      status = { ...decision, conversationId: run.conversationId, error: errorMessage(error) }
      ctx.tui.invalidate()
      if (config.failOpen === false) throw error
    }
  }

  ctx.agentHooks.register({
    id: 'flect.auto-compact.policy',
    priority: 1_000,
    beforeRun: evaluate,
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.auto-compact.command', name: 'autocompact', description: 'Inspect or toggle automatic context compaction.',
    usage: '/autocompact [status|on|off]',
    complete({ query }) {
      return ['status', 'on', 'off'].filter(value => value.startsWith(query.toLowerCase())).map(value => ({ value }))
    },
    run(args, actions) {
      const action = args[0]?.toLowerCase() ?? 'status'
      if (args.length > 1 || !['status', 'on', 'off'].includes(action)) throw new Error('usage: /autocompact [status|on|off]')
      if (action === 'on' || action === 'off') {
        enabled = action === 'on'
        actions.notify(`automatic compaction ${action}`)
        return
      }
      const lines = [
        enabled ? 'Enabled.' : 'Disabled for this Flect process.',
        `Trigger threshold: ${(threshold * 100).toFixed(0)}%`,
        `Minimum history: ${minimumRecords.toLocaleString('en-US')} records · ${minimumTokens.toLocaleString('en-US')} tokens`,
      ]
      if (status) lines.push(
        '',
        `Last check: ${status.reason} · ${status.records} records`,
        `Context: ${status.usedTokens.toLocaleString('en-US')}/${status.contextWindow.toLocaleString('en-US')} · ${(status.ratio * 100).toFixed(1)}%`,
        ...(status.compactedAt ? [`Compacted: ${status.compactedAt}`] : []),
        ...(status.error ? [`Error: ${status.error}`] : []),
      )
      actions.showOverlay({ id: 'flect.auto-compact.status', title: 'Automatic compaction', tone: status?.error ? 'warning' : 'accent', lines })
    },
  })
}

export default { name, inject, apply }
