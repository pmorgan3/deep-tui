import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from 'cordis'
import type {
  Conversation, ConversationRecord, ConversationStore, CreateConversation, NewConversationRecord, TuiActions,
} from '@flect/sdk'

interface IndexFile { version: 1; conversations: Conversation[] }

export interface FilesystemSessionConfig {
  directory?: string
  maxSessions?: number
  maxRecordBytes?: number
  retentionDays?: number
  persistToolOutputs?: boolean
  staleLockMs?: number
}

export class FileConversationStore implements ConversationStore {
  readonly id = 'flect.files'
  readonly priority = 100
  readonly durable = true
  private queue = Promise.resolve()

  constructor(private readonly directory: string, private readonly config: FilesystemSessionConfig = {}) {}

  private file(id: string): string { return path.join(this.directory, `${id}.jsonl`) }
  private async serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true })
    const filename = path.join(this.directory, `${name}.lock`)
    let handle
    try {
      handle = await open(filename, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      const age = Date.now() - (await stat(filename)).mtimeMs
      throw new Error(age > (this.config.staleLockMs ?? 300_000)
        ? `stale session lock detected at ${filename}; remove it after confirming no Flect process is using it`
        : `conversation store is locked by another process: ${filename}`)
    }
    try { return await work() } finally { await handle.close(); await unlink(filename).catch(() => undefined) }
  }
  private async index(): Promise<IndexFile> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, 'index.json'), 'utf8')) as IndexFile
      if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) throw new Error('session index has an unsupported schema')
      return parsed
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        let logs: string[] = []
        try { logs = (await readdir(this.directory)).filter(file => file.endsWith('.jsonl')) } catch {}
        if (logs.length) throw new Error('session index is missing; run "flect sessions repair"')
        return { version: 1, conversations: [] }
      }
      throw error
    }
  }
  private async writeIndex(index: IndexFile): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, 'index.json')
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }
  async create(input: CreateConversation): Promise<Conversation> {
    return this.serialize(() => this.withLock('index', async () => {
      const index = await this.index()
      if (index.conversations.length >= (this.config.maxSessions ?? 1_000)) throw new Error('session limit reached')
      const now = new Date().toISOString()
      const conversation: Conversation = {
        id: randomUUID(), title: input.title?.trim() || 'New conversation', projectRoot: input.projectRoot,
        provider: input.provider, model: input.model, createdAt: now, updatedAt: now,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      }
      await mkdir(this.directory, { recursive: true })
      await writeFile(this.file(conversation.id), `${JSON.stringify({ version: 1, conversation })}\n`, { encoding: 'utf8', mode: 0o600 })
      index.conversations.push(conversation)
      await this.writeIndex(index)
      return conversation
    }))
  }
  async get(id: string): Promise<Conversation | undefined> { return (await this.index()).conversations.find(item => item.id === id) }
  async list(): Promise<readonly Conversation[]> {
    const cutoff = this.config.retentionDays === undefined ? undefined : Date.now() - this.config.retentionDays * 86_400_000
    return (await this.index()).conversations
      .filter(item => cutoff === undefined || Date.parse(item.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async *read(id: string): AsyncIterable<ConversationRecord> {
    const source = await readFile(this.file(id), 'utf8')
    if (Buffer.byteLength(source) > (this.config.maxRecordBytes ?? 50_000_000)) throw new Error(`conversation "${id}" exceeds its storage limit`)
    const complete = source.endsWith('\n')
    const lines = source.split('\n')
    const header = JSON.parse(lines[0] ?? '') as { version?: unknown; conversation?: Conversation }
    if (header.version !== 1 || header.conversation?.id !== id) throw new Error(`conversation "${id}" has invalid metadata`)
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try { yield JSON.parse(line) as ConversationRecord } catch (error) {
        if (!complete && index === lines.length - 1) return
        throw new Error(`conversation "${id}" has corrupt JSON at line ${index + 1}`, { cause: error })
      }
    }
  }
  async append(id: string, expectedSeq: number, records: readonly NewConversationRecord[]): Promise<number> {
    return this.serialize(() => this.withLock(id, () => this.withLock('index', async () => {
      const current = [...await collect(this.read(id))]
      if (current.length !== expectedSeq) throw new Error(`conversation changed; expected sequence ${expectedSeq}, got ${current.length}`)
      const normalized = this.config.persistToolOutputs === false
        ? records.map(record => record.type === 'tool' || record.type === 'tool-prune'
          ? { ...record, content: '[tool output omitted by session policy]' }
          : record)
        : records
      const appended = normalized.map((record, index) => ({ ...record, seq: expectedSeq + index + 1 } as ConversationRecord))
      if (appended.some(record => Buffer.byteLength(JSON.stringify(record)) > (this.config.maxRecordBytes ?? 50_000_000))) {
        throw new Error('conversation record exceeds its storage limit')
      }
      if (appended.length) await appendFile(this.file(id), `${appended.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
      const index = await this.index()
      const position = index.conversations.findIndex(item => item.id === id)
      if (position < 0) throw new Error(`conversation "${id}" was not found`)
      const existing = index.conversations[position]
      if (existing) index.conversations[position] = { ...existing, updatedAt: new Date().toISOString() }
      await this.writeIndex(index)
      return expectedSeq + appended.length
    })))
  }
  async update(id: string, patch: Partial<Pick<Conversation, 'title' | 'provider' | 'model'>>): Promise<Conversation> {
    return this.serialize(() => this.withLock(id, () => this.withLock('index', async () => {
      const index = await this.index()
      const position = index.conversations.findIndex(item => item.id === id)
      const current = index.conversations[position]
      if (!current) throw new Error(`conversation "${id}" was not found`)
      const updated = { ...current, ...patch, updatedAt: new Date().toISOString() }
      index.conversations[position] = updated
      const records = [...await collect(this.read(id))]
      const target = this.file(id)
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, conversation: updated })}\n${records.map(record => JSON.stringify(record)).join('\n')}${records.length ? '\n' : ''}`, 'utf8')
      await rename(temporary, target)
      await this.writeIndex(index)
      return updated
    })))
  }
  async remove(id: string): Promise<void> {
    await this.serialize(() => this.withLock(id, () => this.withLock('index', async () => {
      const index = await this.index()
      index.conversations = index.conversations.filter(item => item.id !== id)
      await unlink(this.file(id)).catch(error => {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      })
      await this.writeIndex(index)
    })))
  }
  async fork(id: string, throughSeq = Number.POSITIVE_INFINITY): Promise<Conversation> {
    const source = await this.get(id)
    if (!source) throw new Error(`conversation "${id}" was not found`)
    const records = [...await collect(this.read(id))].filter(record => record.seq <= throughSeq)
    const fork = await this.create({ title: `${source.title} (fork)`, projectRoot: source.projectRoot, provider: source.provider, model: source.model, parentId: source.id })
    await this.append(fork.id, 0, records.map(({ seq: _seq, ...record }) => record) as NewConversationRecord[])
    return fork
  }

  async repair(): Promise<number> {
    return this.serialize(() => this.withLock('index', async () => {
      await mkdir(this.directory, { recursive: true })
      const conversations: Conversation[] = []
      for (const file of (await readdir(this.directory)).filter(item => item.endsWith('.jsonl')).sort()) {
        const id = file.slice(0, -'.jsonl'.length)
        const source = await readFile(path.join(this.directory, file), 'utf8')
        const first = source.split(/\r?\n/, 1)[0]
        let header: { version?: unknown; conversation?: Conversation }
        try { header = JSON.parse(first ?? '') as typeof header } catch (error) {
          throw new Error(`cannot repair corrupt session metadata in ${file}`, { cause: error })
        }
        if (header.version !== 1 || !header.conversation || header.conversation.id !== id) {
          throw new Error(`cannot repair invalid session metadata in ${file}`)
        }
        let updatedAt = header.conversation.updatedAt
        for await (const record of this.read(id)) {
          if (record.createdAt > updatedAt) updatedAt = record.createdAt
        }
        conversations.push({ ...header.conversation, updatedAt })
      }
      await this.writeIndex({ version: 1, conversations })
      return conversations.length
    }))
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of iterable) output.push(item)
  return output
}

export const name = 'filesystem-sessions'
export const inject = ['commands', 'conversations', 'project', 'tui']

export function apply(ctx: Context, config: FilesystemSessionConfig = {}): void {
  const directory = config.directory
    ? path.isAbsolute(config.directory) ? config.directory : path.resolve(ctx.project.root, config.directory)
    : ctx.project.statePath('sessions')
  const store = new FileConversationStore(directory, config)
  ctx.conversations.registerStore(store)
  let recentConversations: Conversation[] = []
  const pickers = new WeakMap<TuiActions, { items: Conversation[]; index: number }>()
  const showPicker = (actions: TuiActions) => {
    const picker = pickers.get(actions)
    if (!picker) return
    const start = Math.min(Math.max(0, picker.index - 7), Math.max(0, picker.items.length - 15))
    const visible = picker.items.slice(start, start + 15)
    actions.showOverlay({
      id: 'session-picker', title: 'Conversations', lines: picker.items.length
        ? [...visible.map((item, index) => `${start + index === picker.index ? '›' : ' '} ${item.title} · ${item.model} · ${item.updatedAt}`), '', `${picker.index + 1}/${picker.items.length} · ↑↓ preview · enter resume · esc cancel`]
        : ['No saved conversations.'],
    })
  }
  const refresh = () => { void ctx.conversations.list().then(items => { recentConversations = [...items] }) }
  refresh()
  ctx.effect(() => ctx.conversations.subscribe(refresh), 'session completion cache')
  ctx.tui.registerSlashCommand({
    id: 'flect.sessions.new', name: 'new', description: 'Start a new conversation.', usage: '/new [title]',
    run: (args, actions) => {
      const title = args.join(' ').trim()
      return title ? actions.newConversation(title) : actions.newConversation()
    },
  })
  ctx.tui.registerSlashCommand({
    id: 'flect.sessions.list', name: 'sessions', description: 'List durable conversations.',
    async run(_args, actions) {
      const conversations = await ctx.conversations.list()
      const items = [...conversations]
      const selected = Math.max(0, items.findIndex(item => item.id === actions.state.conversationId))
      pickers.set(actions, { items, index: selected })
      showPicker(actions)
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sessions.picker-up', keys: ['up'], description: 'Select the previous conversation.', priority: 20,
    handle(_event, actions) { const picker = pickers.get(actions); if (actions.state.overlay?.id !== 'session-picker' || !picker?.items.length) return false; picker.index = (picker.index - 1 + picker.items.length) % picker.items.length; showPicker(actions); return true },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sessions.picker-down', keys: ['down'], description: 'Select the next conversation.', priority: 20,
    handle(_event, actions) { const picker = pickers.get(actions); if (actions.state.overlay?.id !== 'session-picker' || !picker?.items.length) return false; picker.index = (picker.index + 1) % picker.items.length; showPicker(actions); return true },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sessions.picker-accept', keys: ['enter'], description: 'Resume the selected conversation.', priority: 20,
    async handle(_event, actions) { const picker = pickers.get(actions); const selected = picker?.items[picker.index]; if (actions.state.overlay?.id !== 'session-picker' || !selected) return false; pickers.delete(actions); actions.closeOverlay(); await actions.openConversation(selected.id); return true },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sessions.picker-cancel', keys: ['escape'], description: 'Cancel conversation selection.', priority: 20,
    handle(_event, actions) { if (actions.state.overlay?.id !== 'session-picker') return false; pickers.delete(actions); actions.closeOverlay(); return true },
  })
  ctx.tui.registerSlashCommand({
    id: 'flect.sessions.resume', name: 'resume', description: 'Resume a durable conversation.', usage: '/resume <id>',
    complete({ query }) { return recentConversations.filter(item => item.id.startsWith(query) || item.title.toLowerCase().includes(query.toLowerCase())).map(item => ({ value: item.id, label: item.title, description: `${item.id} · ${item.model}` })) },
    async run(args, actions) { if (!args[0]) throw new Error('/resume requires an id'); await actions.openConversation(args[0]) },
  })
  ctx.tui.registerSlashCommand({ id: 'flect.sessions.fork', name: 'fork', description: 'Fork the active conversation.', usage: '/fork [sequence]',
    run: (args, actions) => { const sequence = args[0] === undefined ? undefined : Number(args[0]); if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0)) throw new Error('fork sequence must be a non-negative integer'); return actions.forkConversation(sequence) } })
  ctx.tui.registerSlashCommand({ id: 'flect.sessions.rename', name: 'rename', description: 'Rename the active conversation.', usage: '/rename <title>',
    run: (args, actions) => { const title = args.join(' ').trim(); if (!title) throw new Error('/rename requires a title'); return actions.renameConversation(title) } })
  ctx.tui.registerSlashCommand({ id: 'flect.sessions.current', name: 'session', description: 'Show the active conversation.',
    run(_args, actions) { actions.showOverlay({ id: 'session', title: 'Conversation', lines: [
      actions.state.conversationTitle ?? 'Ephemeral', actions.state.conversationId ?? 'No durable ID',
      `${actions.state.provider}/${actions.state.model} · ${actions.state.conversationPersistence ?? 'ephemeral'}`,
      '', `Input tokens  ${(actions.state.usage.inputTokens ?? 0).toLocaleString('en-US')}`,
      `Output tokens ${(actions.state.usage.outputTokens ?? 0).toLocaleString('en-US')}`,
      `Tariff cost  $${(actions.state.usage.calculatedCostUsd ?? 0).toFixed(6)}`,
    ] }) } })
  ctx.commands.register({
    name: 'sessions', description: 'List durable conversations.',
    async run(args, environment) {
      const action = args[0] ?? 'list'
      if (action === 'list') {
        for (const item of await ctx.conversations.list()) environment.stdout.write(`${item.id}\t${item.updatedAt}\t${item.title}\n`)
        return
      }
      if (action === 'show' || action === 'export') {
        const id = args[1]
        if (!id) throw new Error(`sessions ${action} requires an id`)
        const conversation = await ctx.conversations.get(id)
        if (!conversation) throw new Error(`conversation "${id}" was not found`)
        if (action === 'show') { environment.stdout.write(`${JSON.stringify(conversation, null, 2)}\n`); return }
        const records = [...await collect(ctx.conversations.read(id))]
        if (args.includes('--markdown')) {
          environment.stdout.write(`# ${conversation.title}\n\n`)
          for (const record of records) {
            if (record.type === 'user') environment.stdout.write(`## User\n\n${record.text}\n\n`)
            else if (record.type === 'assistant') environment.stdout.write(`## Assistant\n\n${record.text}\n\n`)
            else if (record.type === 'tool') environment.stdout.write(`> Tool ${record.name}: stored output omitted from Markdown export\n\n`)
          }
        } else {
          environment.stderr.write('Warning: canonical export includes stored tool outputs; review it before sharing.\n')
          environment.stdout.write(`${JSON.stringify({ version: 1, conversation, records }, null, 2)}\n`)
        }
        return
      }
      if (action === 'delete') {
        const id = args[1]
        if (!id) throw new Error('sessions delete requires an id')
        if (!args.includes('--yes')) throw new Error('sessions delete requires --yes')
        await ctx.conversations.remove(id)
        environment.stdout.write(`Deleted ${id}\n`)
        return
      }
      if (action === 'repair') {
        environment.stdout.write(`Rebuilt ${await store.repair()} session index entries.\n`)
        return
      }
      throw new Error('usage: sessions list|show <id>|export <id> [--markdown]|delete <id> --yes|repair')
    },
  })
}

export default { name, inject, apply }
