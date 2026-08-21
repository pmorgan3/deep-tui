import type { Context } from 'cordis'
import { fallbackConversationTitle, type AgentRunMetadata } from '@deep-tui/sdk'

export interface SessionTitleConfig {
  provider?: string
  model?: string
  maxLength?: number
  maxPromptChars?: number
  systemPrompt?: string
}

const defaultSystemPrompt = [
  'Create a concise title for this coding session.',
  'Use 3 to 7 words and describe the concrete task.',
  'Return only the title with no quotation marks, markdown, label, or ending punctuation.',
].join(' ')

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

export function normalizeGeneratedTitle(value: string, maxLength = 60): string | undefined {
  let title = value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
  title = title.replace(/^#{1,6}\s*/, '').replace(/^title\s*:\s*/i, '').trim()
  if ((title.startsWith('"') && title.endsWith('"'))
    || (title.startsWith("'") && title.endsWith("'"))
    || (title.startsWith('`') && title.endsWith('`'))) {
    title = title.slice(1, -1).trim()
  }
  title = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  title = title.replace(/[.!?;:,]+$/, '').trim()
  const bounded = [...title].slice(0, maxLength).join('').trimEnd()
  return bounded || undefined
}

export async function generateSessionTitle(
  ctx: Context,
  input: string,
  metadata: AgentRunMetadata,
  config: SessionTitleConfig = {},
): Promise<string | undefined> {
  if (!metadata.conversationId) return undefined
  const maxLength = boundedInteger(config.maxLength, 60, 16, 120, 'session title maxLength')
  const maxPromptChars = boundedInteger(config.maxPromptChars, 4_000, 256, 20_000, 'session title maxPromptChars')
  const conversation = await ctx.conversations.get(metadata.conversationId)
  if (!conversation) return undefined
  const fallback = fallbackConversationTitle(input)
  if (conversation.title !== 'New conversation' && conversation.title !== fallback) return undefined

  const response = await ctx.models.complete(config.provider ?? 'deepseek', {
    model: config.model ?? 'flash',
    messages: [
      { role: 'system', content: config.systemPrompt?.trim() || defaultSystemPrompt },
      { role: 'user', content: [...input].slice(0, maxPromptChars).join('') },
    ],
    tools: [],
  })
  const title = normalizeGeneratedTitle(response.text, maxLength)
  if (!title || title === conversation.title) return title

  const current = await ctx.conversations.get(conversation.id)
  if (!current || current.title !== conversation.title) return undefined
  const updated = await ctx.conversations.update(conversation.id, { title })
  ctx.emit('harness/conversation/title', updated.id, updated.title)
  return updated.title
}

export const name = 'session-title'
export const inject = ['conversations', 'models']

export function apply(ctx: Context, config: SessionTitleConfig = {}): void {
  // Validate configuration during composition rather than on the first run.
  boundedInteger(config.maxLength, 60, 16, 120, 'session title maxLength')
  boundedInteger(config.maxPromptChars, 4_000, 256, 20_000, 'session title maxPromptChars')
  ctx.on('harness/agent/start', (input, metadata) => {
    void generateSessionTitle(ctx, input, metadata, config).catch(() => undefined)
  })
}

export default { name, inject, apply }
