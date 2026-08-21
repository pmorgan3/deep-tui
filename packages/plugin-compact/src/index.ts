import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import type {
  Conversation,
  ConversationRecord,
  ConversationSurfaceRecord,
  ModelEnvelope,
  ModelMessage,
  ModelTool,
  NewConversationRecord,
} from '@flect/sdk'
import {
  conversationSurface,
  createModelEnvelope,
  formatCheckpoint,
  formatRuntimeContext,
} from '@flect/sdk'

export interface CompactConfig {
  /** Provider used to generate the summary. Defaults to the active TUI provider. */
  provider?: string
  /** Model used to generate the summary. Defaults to the active TUI model. */
  model?: string
  /** Replace the summarization instructions. */
  systemPrompt?: string
  /** Upper bound used to select a whole-record prefix for the summarizer. */
  maxTranscriptChars?: number
  /** Tool results above this bound are replaced by retained head and tail content. */
  maxRecordChars?: number
  /** Upper bound for the generated checkpoint summary. */
  maxSummaryChars?: number
  /** Recent model-facing records retained verbatim after the checkpoint. */
  retainRecentRecords?: number
}

export interface CompactOptions extends CompactConfig {
  /** Optional focus instruction appended to the summarization request. */
  focus?: string
  /** Optional replacement title for the active conversation. */
  title?: string
}

export interface CompactResult {
  conversation: Conversation
  summary: string
}

const defaultSystemPrompt = [
  'Summarize this coding conversation for a future assistant that will continue the work.',
  'Preserve the user\'s goals, decisions, constraints, file paths, errors, and unfinished work.',
  'Keep tool outputs only where they materially affect the next steps.',
  'Use concise markdown with bullet points.',
  'Do not ask questions or include commentary about the summary itself.',
  'Return only the summary.',
].join(' ')

const defaultMaxTranscriptChars = 60_000
const defaultMaxRecordChars = 8_000
const defaultMaxSummaryChars = 12_000
const defaultRetainRecentRecords = 8
const toolPruneMarker = '\n\n[tool result middle pruned during compaction]\n\n'

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n[content truncated]`
}

function stringifyArguments(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Build a bounded, human-readable transcript from canonical conversation records. */
export function buildCompactionTranscript(
  records: readonly ConversationRecord[],
  maxRecordChars = defaultMaxRecordChars,
): string {
  const sections: string[] = []
  for (const record of records) {
    if (record.type === 'user') {
      sections.push(`## User\n${truncate(record.text, maxRecordChars)}`)
    } else if (record.type === 'assistant') {
      const toolCalls = record.toolCalls?.length
        ? `\n\n${record.toolCalls.map(call =>
            `Tool call: ${call.name}(${truncate(stringifyArguments(call.arguments), maxRecordChars)})`).join('\n')}`
        : ''
      sections.push(`## Assistant\n${truncate(record.text, maxRecordChars)}${toolCalls}`)
    } else if (record.type === 'context') {
      sections.push(`## Runtime context: ${record.source}\n${truncate(record.text, maxRecordChars)}`)
    } else if (record.type === 'checkpoint') {
      sections.push(`## Earlier checkpoint\n${truncate(record.summary, maxRecordChars)}`)
    } else if (record.type === 'tool' || record.type === 'tool-prune') {
      sections.push(`## Tool result: ${record.name}\n${truncate(record.content, maxRecordChars)}`)
    }
  }
  return sections.join('\n\n')
}

/** Trim model formatting from a generated summary and enforce a size bound. */
export function normalizeCompactSummary(
  value: string,
  maxSummaryChars = defaultMaxSummaryChars,
): string | undefined {
  let summary = value.trim()
  summary = summary.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```$/, '').trim()
  summary = summary.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ').trim()
  const bounded = [...summary].slice(0, maxSummaryChars).join('').trim()
  return bounded || undefined
}

async function collectRecords(iterable: AsyncIterable<ConversationRecord>): Promise<ConversationRecord[]> {
  const output: ConversationRecord[] = []
  for await (const record of iterable) output.push(record)
  return output
}

function recordToModelMessage(record: ConversationSurfaceRecord): ModelMessage {
  if (record.type === 'user') return { role: 'user', content: record.text }
  if (record.type === 'context') return { role: 'user', content: formatRuntimeContext(record.source, record.text) }
  if (record.type === 'checkpoint') return { role: 'user', content: formatCheckpoint(record.summary) }
  if (record.type === 'assistant') return {
    role: 'assistant', content: record.text,
    ...(record.reasoning ? { reasoning: record.reasoning } : {}),
    ...(record.toolCalls?.length ? { toolCalls: record.toolCalls } : {}),
  }
  return { role: 'tool', content: record.content, toolCallId: record.toolCallId, name: record.name }
}

function recordSize(record: ConversationSurfaceRecord): number {
  return [...recordToModelMessage(record).content].length
}

function pruneToolContent(content: string, limit: number): string {
  const codepoints = [...content]
  if (codepoints.length <= limit) return content
  const available = Math.max(0, limit - [...toolPruneMarker].length)
  const head = Math.floor(available * 0.8)
  const tail = available - head
  return `${codepoints.slice(0, head).join('')}${toolPruneMarker}${tail ? codepoints.slice(-tail).join('') : ''}`
}

async function pruneOversizedToolResults(
  ctx: Context,
  conversationId: string,
  records: ConversationRecord[],
  sequence: number,
  maxRecordChars: number,
): Promise<{ records: ConversationRecord[]; sequence: number }> {
  const replacements: NewConversationRecord[] = conversationSurface(records).flatMap(record => {
    if ((record.type !== 'tool' && record.type !== 'tool-prune') || [...record.content].length <= maxRecordChars) return []
    return [{
      type: 'tool-prune' as const,
      sourceSeq: record.seq,
      messageId: randomUUID(),
      toolCallId: record.toolCallId,
      name: record.name,
      content: pruneToolContent(record.content, maxRecordChars),
      ...(record.presentation ? { presentation: record.presentation } : {}),
      createdAt: new Date().toISOString(),
    }]
  })
  if (!replacements.length) return { records, sequence }
  const nextSequence = await ctx.conversations.append(conversationId, sequence, replacements)
  return { records: await collectRecords(ctx.conversations.read(conversationId)), sequence: nextSequence }
}

function selectCompactionPrefix(
  surface: readonly ConversationSurfaceRecord[],
  maxTranscriptChars: number,
  retainRecentRecords: number,
): ConversationSurfaceRecord[] {
  if (!surface.length) return []
  const retained = Math.min(retainRecentRecords, Math.floor(surface.length / 2))
  const maximum = Math.max(1, surface.length - retained)
  let count = 0
  let characters = 0
  while (count < maximum) {
    const size = recordSize(surface[count] as ConversationSurfaceRecord)
    if (count > 0 && characters + size > maxTranscriptChars) break
    characters += size
    count += 1
  }
  // Never split an assistant tool call from the immediately following results.
  while (count > 0 && count < surface.length) {
    const last = surface[count - 1]
    const next = surface[count]
    if (last?.type === 'assistant' && last.toolCalls?.length
      && (next?.type === 'tool' || next?.type === 'tool-prune')) count -= 1
    else break
  }
  return surface.slice(0, Math.max(1, count))
}

function latestEnvelope(records: readonly ConversationRecord[]): ModelEnvelope | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.type === 'envelope') return record.envelope
  }
  return undefined
}

async function currentEnvelope(
  ctx: Context,
  source: Conversation,
  records: readonly ConversationRecord[],
  provider: string,
  model: string,
): Promise<ModelEnvelope> {
  const persisted = latestEnvelope(records)
  if (persisted) return persisted
  const assembly = await ctx.prompts.assemble({ cwd: source.projectRoot, model })
  const tools: ModelTool[] = ctx.tools.definitions().map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  }))
  return createModelEnvelope(provider, model, assembly.system, tools)
}

/** Summarize an old conversation prefix and append an in-place surface checkpoint. */
export async function compactConversation(
  ctx: Context,
  sourceId: string,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const maxRecordChars = boundedInteger(
    options.maxRecordChars, defaultMaxRecordChars, 500, 100_000, 'compact maxRecordChars')
  const maxTranscriptChars = boundedInteger(
    options.maxTranscriptChars, defaultMaxTranscriptChars, 1_000, 1_000_000, 'compact maxTranscriptChars')
  const maxSummaryChars = boundedInteger(
    options.maxSummaryChars, defaultMaxSummaryChars, 500, 100_000, 'compact maxSummaryChars')
  const retainRecentRecords = boundedInteger(
    options.retainRecentRecords, defaultRetainRecentRecords, 0, 10_000, 'compact retainRecentRecords')

  const source = await ctx.conversations.get(sourceId)
  if (!source) throw new Error(`conversation "${sourceId}" was not found`)

  let records = await collectRecords(ctx.conversations.read(sourceId))
  let sequence = records.at(-1)?.seq ?? 0
  if (!conversationSurface(records).length) throw new Error('conversation has no messages to compact')

  const persistedEnvelope = latestEnvelope(records)
  const provider = options.provider ?? persistedEnvelope?.provider ?? source.provider
  const model = options.model ?? persistedEnvelope?.model ?? source.model
  const pruned = await pruneOversizedToolResults(ctx, sourceId, records, sequence, maxRecordChars)
  records = pruned.records
  sequence = pruned.sequence
  const envelope = await currentEnvelope(ctx, source, records, provider, model)
  const selected = selectCompactionPrefix(conversationSurface(records), maxTranscriptChars, retainRecentRecords)
  if (!selected.length) throw new Error('conversation has no messages to compact')
  const focus = options.focus?.trim()
  const instruction = options.systemPrompt?.trim() || defaultSystemPrompt
  const response = await ctx.models.complete(provider, {
    model,
    messages: [
      ...(envelope.system ? [{ role: 'system' as const, content: envelope.system }] : []),
      ...selected.map(recordToModelMessage),
      {
        role: 'user',
        content: `${instruction}${focus ? `\n\nCompaction focus:\n${focus}` : ''}`,
      },
    ],
    tools: envelope.tools,
  })

  if (response.toolCalls.length) throw new Error('the compaction model returned tool calls instead of a summary')

  const summary = normalizeCompactSummary(response.text, maxSummaryChars)
  if (!summary) throw new Error('the compaction model returned an empty summary')

  const appended: NewConversationRecord[] = [
    ...(!persistedEnvelope ? [{ type: 'envelope' as const, envelope, createdAt: new Date().toISOString() }] : []),
    {
      type: 'checkpoint',
      messageId: randomUUID(),
      summary,
      sourceSeqs: selected.map(record => record.seq),
      createdAt: new Date().toISOString(),
    },
  ]
  await ctx.conversations.append(sourceId, sequence, appended)
  const conversation = options.title?.trim()
    ? await ctx.conversations.update(sourceId, { title: options.title.trim() })
    : await ctx.conversations.get(sourceId) as Conversation

  return { conversation, summary }
}

export const name = 'compact-command'
export const inject = ['conversations', 'models', 'prompts', 'tools', 'tui']

export function apply(ctx: Context, config: CompactConfig = {}): void {
  // Validate configuration during composition rather than on the first /compact.
  boundedInteger(config.maxRecordChars, defaultMaxRecordChars, 500, 100_000, 'compact maxRecordChars')
  boundedInteger(config.maxTranscriptChars, defaultMaxTranscriptChars, 1_000, 1_000_000, 'compact maxTranscriptChars')
  boundedInteger(config.maxSummaryChars, defaultMaxSummaryChars, 500, 100_000, 'compact maxSummaryChars')
  boundedInteger(config.retainRecentRecords, defaultRetainRecentRecords, 0, 10_000, 'compact retainRecentRecords')

  ctx.tui.registerSlashCommand({
    id: 'flect.compact.command',
    name: 'compact',
    aliases: ['summarize'],
    description: 'Summarize this conversation and start a compacted continuation.',
    usage: '/compact [focus]',
    async run(args, actions) {
      if (actions.state.busy) throw new Error('wait for the current run before compacting')
      const sourceId = actions.state.conversationId
      if (!sourceId) {
        actions.notify('nothing to compact yet; send a prompt first')
        return
      }

      const focus = args.join(' ').trim()
      actions.showOverlay({
        id: 'flect.compact.loading',
        title: 'Compacting conversation',
        lines: [
          'Replaying the warm prefix and preparing an in-place checkpoint',
          '',
          'Original records remain preserved in the append-only session log.',
        ],
      })

      try {
        const result = await compactConversation(ctx, sourceId, {
          provider: config.provider ?? actions.state.provider,
          model: config.model ?? actions.state.model,
          ...(config.systemPrompt?.trim() ? { systemPrompt: config.systemPrompt } : {}),
          ...(config.maxTranscriptChars === undefined
            ? {}
            : { maxTranscriptChars: config.maxTranscriptChars }),
          ...(config.maxRecordChars === undefined ? {} : { maxRecordChars: config.maxRecordChars }),
          ...(config.maxSummaryChars === undefined ? {} : { maxSummaryChars: config.maxSummaryChars }),
          ...(config.retainRecentRecords === undefined ? {} : { retainRecentRecords: config.retainRecentRecords }),
          ...(focus ? { focus } : {}),
        })
        actions.closeOverlay()
        await actions.openConversation(result.conversation.id)
        actions.notify(`compacted ${result.conversation.title}`)
      } catch (error) {
        actions.closeOverlay()
        throw error
      }
    },
  })
}

export default { name, inject, apply }
