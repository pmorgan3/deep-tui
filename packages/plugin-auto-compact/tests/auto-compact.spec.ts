import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  AgentLifecycleService,
  ConversationService,
  ModelService,
  PromptService,
  ToolService,
  TuiService,
  conversationSurface,
  type ConversationRecord,
} from '@flect/sdk'
import autoCompactPlugin, { decideAutoCompact } from '../src/index.js'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of iterable) output.push(item)
  return output
}

describe('automatic compaction', () => {
  it('uses fresh reported context and ignores usage hidden behind a checkpoint', () => {
    const records: ConversationRecord[] = [
      { seq: 1, type: 'user', messageId: 'u1', text: 'x', createdAt: 'now' },
      { seq: 2, type: 'assistant', messageId: 'a1', text: 'y', usage: { contextTokens: 900 }, createdAt: 'now' },
    ]
    const options = { enabled: true, contextWindow: 1_000, threshold: 0.8, minimumRecords: 2, minimumTokens: 0, charsPerToken: 4 }
    expect(decideAutoCompact(records, 'next', options)).toMatchObject({ compact: true, usedTokens: 900, reason: 'threshold' })
    records.push({ seq: 3, type: 'checkpoint', messageId: 'c1', summary: 'small', sourceSeqs: [1, 2], createdAt: 'now' })
    expect(decideAutoCompact(records, 'next', options)).toMatchObject({ compact: false, reason: 'small-history' })
  })

  it('appends a checkpoint in preflight before the next agent reads history', async () => {
    const ctx = new Context()
    const services = await Promise.all([
      ctx.plugin(AgentLifecycleService), ctx.plugin(ConversationService), ctx.plugin(ModelService),
      ctx.plugin(PromptService), ctx.plugin(ToolService), ctx.plugin(TuiService),
    ])
    const provider = await ctx.plugin({
      name: 'auto-compact-test-provider', inject: ['models'], apply(inner) {
        inner.models.register({ id: 'fake', async complete() { return { text: 'A compact checkpoint.', toolCalls: [] } } })
      },
    })
    const plugin = await ctx.plugin(autoCompactPlugin, {
      contextWindow: 1_000, threshold: 0.8, minimumRecords: 2, minimumTokens: 0, retainRecentRecords: 0,
    })
    try {
      const conversation = await ctx.conversations.create({ projectRoot: '.', provider: 'fake', model: 'm' })
      await ctx.conversations.append(conversation.id, 0, [
        { type: 'user', messageId: 'u1', text: 'old request', createdAt: 'now' },
        { type: 'assistant', messageId: 'a1', text: 'old answer', usage: { contextTokens: 900 }, createdAt: 'now' },
      ])
      const run = { runId: 'run-1', input: 'continue', cwd: '.', provider: 'fake', model: 'm', conversationId: conversation.id }
      await ctx.agentHooks.start(run)
      const records = await collect(ctx.conversations.read(conversation.id))
      expect(records.at(-2)).toMatchObject({ type: 'envelope' })
      expect(records.at(-1)).toMatchObject({ type: 'checkpoint', summary: 'A compact checkpoint.' })
      expect(conversationSurface(records)).toMatchObject([{ type: 'checkpoint' }])
      await ctx.agentHooks.finish({ ...run, steps: 0, status: 'complete', usage: {} })

      const second = { ...run, runId: 'run-2' }
      await ctx.agentHooks.start(second)
      expect(await collect(ctx.conversations.read(conversation.id))).toHaveLength(records.length)
      await ctx.agentHooks.finish({ ...second, steps: 0, status: 'complete', usage: {} })
    } finally {
      await plugin.dispose(); await provider.dispose(); await Promise.all(services.map(service => service.dispose()))
    }
  })
})
