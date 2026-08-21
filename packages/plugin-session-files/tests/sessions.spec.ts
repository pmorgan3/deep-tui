import { appendFile, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ProjectService, type ModelMessage, type ModelRequest } from '@deep-tui/sdk'
import runtime from '../../runtime/src/index.js'
import { DefaultAgentService } from '../../plugin-agent/src/index.js'
import sessionPlugin, { FileConversationStore } from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of iterable) output.push(item)
  return output
}

describe('filesystem conversation store', () => {
  it('persists tool presentation metadata separately from model-facing content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-sessions-presentation-'))
    directories.push(directory)
    const store = new FileConversationStore(directory)
    const conversation = await store.create({ projectRoot: directory, provider: 'test', model: 'flash' })
    await store.append(conversation.id, 0, [{
      type: 'tool', messageId: 't1', toolCallId: 'call-1', name: 'write_file', content: '{"path":"a.txt"}',
      presentation: { type: 'diff', data: { diff: '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n' } },
      createdAt: new Date().toISOString(),
    }])
    expect(await collect(store.read(conversation.id))).toMatchObject([{
      type: 'tool', content: '{"path":"a.txt"}',
      presentation: { type: 'diff', data: { diff: expect.stringContaining('+hello') } },
    }])
  })

  it('survives restart, enforces optimistic sequence, and forks independently', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-sessions-'))
    directories.push(directory)
    let store = new FileConversationStore(directory)
    const conversation = await store.create({ projectRoot: directory, provider: 'test', model: 'flash', title: 'First' })
    const sequence = await store.append(conversation.id, 0, [
      { type: 'user', messageId: 'u1', text: 'hello', createdAt: new Date().toISOString() },
      { type: 'assistant', messageId: 'a1', text: 'world', reasoning: 'hidden',
        usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3, calculatedCostUsd: 0.0001 },
        createdAt: new Date().toISOString() },
    ])
    expect(sequence).toBe(2)
    await expect(store.append(conversation.id, 0, [])).rejects.toThrow('expected sequence 0, got 2')

    store = new FileConversationStore(directory)
    expect(await store.get(conversation.id)).toMatchObject({ title: 'First' })
    expect(await collect(store.read(conversation.id))).toMatchObject([
      { seq: 1, type: 'user', text: 'hello' },
      { seq: 2, type: 'assistant', text: 'world', reasoning: 'hidden',
        usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3, calculatedCostUsd: 0.0001 } },
    ])
    const fork = await store.fork(conversation.id, 1)
    await store.append(fork.id, 1, [{ type: 'user', messageId: 'u2', text: 'fork only', createdAt: new Date().toISOString() }])
    expect(await collect(store.read(conversation.id))).toHaveLength(2)
    expect(await collect(store.read(fork.id))).toHaveLength(2)
  })

  it('ignores only a truncated tail and repairs a missing index from valid logs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-sessions-repair-'))
    directories.push(directory)
    const store = new FileConversationStore(directory)
    const conversation = await store.create({ projectRoot: directory, provider: 'test', model: 'flash' })
    await store.append(conversation.id, 0, [{ type: 'user', messageId: 'u1', text: 'safe', createdAt: new Date().toISOString() }])
    await appendFile(path.join(directory, `${conversation.id}.jsonl`), '{"seq":2', 'utf8')
    expect(await collect(store.read(conversation.id))).toHaveLength(1)
    await unlink(path.join(directory, 'index.json'))
    await expect(store.list()).rejects.toThrow('sessions repair')
    expect(await store.repair()).toBe(1)
    expect(await store.list()).toHaveLength(1)
  })

  it('diagnoses stale cross-process locks without authorizing a write', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-sessions-lock-'))
    directories.push(directory)
    const store = new FileConversationStore(directory, { staleLockMs: 10 })
    const conversation = await store.create({ projectRoot: directory, provider: 'test', model: 'flash' })
    const lock = path.join(directory, `${conversation.id}.lock`)
    await writeFile(lock, '{}', 'utf8')
    const old = new Date(Date.now() - 1_000)
    await utimes(lock, old, old)
    await expect(store.append(conversation.id, 0, [])).rejects.toThrow('stale session lock')
    expect((await readFile(path.join(directory, `${conversation.id}.jsonl`), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('replays canonical history into a fresh agent composition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-sessions-history-'))
    directories.push(root)
    const first = await agentComposition(root, 'answer A')
    const conversation = await first.ctx.conversations.create({ projectRoot: root, provider: 'fake', model: 'm', title: 'History' })
    await drain(first.ctx.agent.run('prompt A', { cwd: root, conversationId: conversation.id }))
    await first.close()

    const second = await agentComposition(root, 'answer B')
    await drain(second.ctx.agent.run('prompt B', { cwd: root, conversationId: conversation.id }))
    expect(second.requests).toHaveLength(1)
    expect(second.requests[0]?.messages).toEqual<ModelMessage[]>([
      { role: 'user', content: 'prompt A' },
      { role: 'assistant', content: 'answer A' },
      { role: 'user', content: 'prompt B' },
    ])
    await second.close()
  })
})

async function drain(generator: AsyncGenerator<unknown, string>): Promise<string> {
  while (true) { const next = await generator.next(); if (next.done) return next.value }
}

async function agentComposition(root: string, answer: string) {
  const ctx = new Context()
  await ctx.plugin(ProjectService, { root })
  await ctx.plugin(runtime)
  await ctx.plugin(sessionPlugin)
  const requests: ModelRequest[] = []
  await ctx.plugin({ name: 'fake-model', inject: ['models'], apply(inner) { inner.models.register({
    id: 'fake', async complete(request) { requests.push(request); return { text: answer, toolCalls: [] } },
  }) } })
  await ctx.plugin(DefaultAgentService, { provider: 'fake', model: 'm' })
  return { ctx, requests, close: () => ctx.fiber.dispose() }
}
