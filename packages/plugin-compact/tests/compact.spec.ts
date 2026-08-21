import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  ConversationService,
  ModelService,
  PromptService,
  ToolService,
  TuiService,
  conversationSurface,
  type ConversationRecord,
  type ModelRequest,
  type TuiActions,
  type TuiState,
} from '@deep-tui/sdk'
import compactPlugin, { buildCompactionTranscript, compactConversation } from '../src/index.js'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of iterable) output.push(item)
  return output
}

async function mountCompactContext() {
  const ctx = new Context()
  await ctx.plugin(ConversationService)
  await ctx.plugin(ModelService)
  await ctx.plugin(PromptService)
  await ctx.plugin(ToolService)
  await ctx.plugin(TuiService)
  let request: ModelRequest | undefined
  const provider = await ctx.plugin({
    name: 'fake-compact-model',
    inject: ['models', 'prompts', 'tools'],
    apply(inner) {
      inner.prompts.register({ id: 'stable', render: () => 'Stable system prompt.' })
      inner.tools.register({
        name: 'read_file', description: 'Read a file.', inputSchema: { required: ['path'], type: 'object' },
        execute: () => '',
      })
      inner.models.register({
        id: 'fake',
        async complete(next) {
          request = next
          return { text: 'Compact summary.', toolCalls: [] }
        },
      })
    },
  })
  const plugin = await ctx.plugin(compactPlugin, { retainRecentRecords: 0 })
  return {
    ctx,
    plugin,
    provider,
    get request() { return request },
    dispose: () => ctx.fiber.dispose(),
  }
}

function makeActions(conversationId?: string) {
  const notices: string[] = []
  const opened: string[] = []
  const state: TuiState = {
    cwd: '.',
    width: 80,
    height: 24,
    provider: 'fake',
    model: 'm',
    models: ['m'],
    theme: 'default',
    contextWindow: 0,
    usage: {},
    input: '/compact',
    cursor: 8,
    slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } },
    busy: false,
    status: 'ready',
    events: [],
    startedAt: 0,
    ...(conversationId ? { conversationId } : {}),
  }
  const actions: TuiActions = {
    state,
    setInput() {},
    async submit() {},
    exit() {},
    cancel: () => false,
    clear() {},
    cycleModel() {},
    setModel() {},
    notify(message) { notices.push(message) },
    showOverlay(overlay) { state.overlay = overlay },
    closeOverlay() { delete state.overlay },
    moveSlashSelection() {},
    acceptSlashSuggestion: () => false,
    answerPermission() {},
    scrollViewport() {},
    pageViewport() {},
    followViewport() {},
    toggleReasoning() {},
    revealEvent() {},
    selectPermissionCandidate() {},
    async newConversation() {},
    async openConversation(id) {
      opened.push(id)
      state.conversationId = id
    },
    async forkConversation() {},
    async renameConversation() {},
  }
  return { actions, state, notices, opened }
}

describe('compact transcript builder', () => {
  it('includes user, assistant, tool calls, and tool results with truncation', () => {
    const records: ConversationRecord[] = [
      { seq: 1, type: 'user', messageId: 'u1', text: 'Fix the parser bug', createdAt: 'now' },
      { seq: 2, type: 'assistant', messageId: 'a1', text: 'Found it.', createdAt: 'now',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/parser.ts' } }] },
      { seq: 3, type: 'tool', messageId: 't1', toolCallId: 'c1', name: 'read_file',
        content: 'export function parse() {}', createdAt: 'now' },
    ]

    const transcript = buildCompactionTranscript(records, 5)
    expect(transcript).toContain('## User')
    expect(transcript).toContain('Fix t')
    expect(transcript).toContain('[content truncated]')
    expect(transcript).toContain('Tool call: read_file')
    expect(transcript).toContain('## Tool result: read_file')
    expect(transcript).toContain('expor')
  })
})

describe('compact slash plugin', () => {
  it('replays the warm prefix and appends an in-place checkpoint while preserving raw history', async () => {
    const mounted = await mountCompactContext()
    try {
      const { ctx } = mounted
      const source = await ctx.conversations.create({
        title: 'Debug session',
        projectRoot: '.',
        provider: 'fake',
        model: 'm',
      })
      await ctx.conversations.append(source.id, 0, [
        { type: 'user', messageId: 'u1', text: 'Fix the parser bug', createdAt: new Date().toISOString() },
        { type: 'assistant', messageId: 'a1', text: 'Found it.', createdAt: new Date().toISOString(),
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/parser.ts' } }] },
        { type: 'tool', messageId: 't1', toolCallId: 'c1', name: 'read_file',
          content: 'export function parse() {}', createdAt: new Date().toISOString() },
      ])

      const { actions, state, opened, notices } = makeActions(source.id)
      state.input = '/compact focus on parser edge cases'
      state.cursor = state.input.length

      expect(ctx.tui.slashCommand('compact')?.aliases).toContain('summarize')
      await ctx.tui.executeSlash('/compact focus on parser edge cases', actions)

      expect(opened).toHaveLength(1)
      expect(opened[0]).toBe(source.id)
      expect(state.overlay).toBeUndefined()
      expect(notices).toContain('compacted Debug session')
      expect(mounted.request?.messages[0]).toEqual({ role: 'system', content: 'Stable system prompt.' })
      expect(mounted.request?.messages[1]?.content).toContain('Fix the parser bug')
      expect(mounted.request?.messages.at(-1)?.content).toContain('Compaction focus')
      expect(mounted.request?.messages.at(-1)?.content).toContain('parser edge cases')
      expect(mounted.request?.tools).toEqual([{
        name: 'read_file', description: 'Read a file.', inputSchema: { required: ['path'], type: 'object' },
      }])

      const compactedId = opened[0]
      expect(compactedId).toBeDefined()
      const compacted = await ctx.conversations.get(compactedId ?? '')
      expect(compacted).toMatchObject({
        title: 'Debug session',
        provider: 'fake',
        model: 'm',
      })

      const compactedRecords = await collect(ctx.conversations.read(compactedId ?? ''))
      expect(compactedRecords).toHaveLength(5)
      expect(compactedRecords.at(-2)).toMatchObject({ type: 'envelope' })
      expect(compactedRecords.at(-1)).toMatchObject({
        type: 'checkpoint', summary: 'Compact summary.', sourceSeqs: [1, 2, 3],
      })
      expect(conversationSurface(compactedRecords)).toMatchObject([{ type: 'checkpoint', summary: 'Compact summary.' }])
    } finally {
      await mounted.dispose()
    }
  })

  it('can be used programmatically and rejects empty conversations', async () => {
    const mounted = await mountCompactContext()
    try {
      const { ctx } = mounted
      const source = await ctx.conversations.create({
        title: 'Empty session',
        projectRoot: '.',
        provider: 'fake',
        model: 'm',
      })
      await expect(compactConversation(ctx, source.id, { provider: 'fake', model: 'm' }))
        .rejects.toThrow('no messages to compact')
    } finally {
      await mounted.dispose()
    }
  })

  it('prunes oversized tool results with head and tail retention before checkpointing', async () => {
    const mounted = await mountCompactContext()
    try {
      const source = await mounted.ctx.conversations.create({
        title: 'Large tool output', projectRoot: '.', provider: 'fake', model: 'm',
      })
      const large = `HEAD-${'x'.repeat(1_200)}-TAIL`
      await mounted.ctx.conversations.append(source.id, 0, [
        { type: 'user', messageId: 'u1', text: 'Inspect it', createdAt: 'now' },
        { type: 'assistant', messageId: 'a1', text: '', createdAt: 'now',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'large.txt' } }] },
        { type: 'tool', messageId: 't1', toolCallId: 'c1', name: 'read_file', content: large, createdAt: 'now' },
        { type: 'assistant', messageId: 'a2', text: 'Inspected.', createdAt: 'now' },
      ])

      await compactConversation(mounted.ctx, source.id, {
        provider: 'fake', model: 'm', maxRecordChars: 500, retainRecentRecords: 0,
      })

      const records = await collect(mounted.ctx.conversations.read(source.id))
      const prune = records.find(record => record.type === 'tool-prune')
      expect(prune).toMatchObject({ type: 'tool-prune', sourceSeq: 3, name: 'read_file' })
      expect(prune?.type === 'tool-prune' ? [...prune.content].length : 0).toBeLessThanOrEqual(500)
      expect(prune?.type === 'tool-prune' ? prune.content : '').toContain('HEAD-')
      expect(prune?.type === 'tool-prune' ? prune.content : '').toContain('-TAIL')
      expect(prune?.type === 'tool-prune' ? prune.content : '').toContain('middle pruned')
      const requestTool = mounted.request?.messages.find(message => message.role === 'tool')
      expect(requestTool?.content).toContain('middle pruned')
      expect(conversationSurface(records)).toMatchObject([{ type: 'checkpoint' }])
    } finally {
      await mounted.dispose()
    }
  })
})
