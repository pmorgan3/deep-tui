import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Context } from 'cordis'
import type { AuditEvent, AuditSink } from '@deep-tui/sdk'

export interface JsonlAuditConfig {
  directory?: string
  maxFileBytes?: number
  retentionDays?: number
  hashChain?: boolean
}

interface StoredAuditEvent {
  version: 1
  event: AuditEvent
  previousHash?: string
  hash?: string
}

function digest(event: AuditEvent, previousHash: string | undefined): string {
  return createHash('sha256').update(`${previousHash ?? ''}\n${JSON.stringify(event)}`).digest('hex')
}

export class JsonlAuditSink implements AuditSink {
  readonly id = 'deep-tui.audit.jsonl'
  readonly priority = 0
  private queue = Promise.resolve()
  private readonly tails = new Map<string, string | undefined>()

  constructor(private readonly directory: string, private readonly config: JsonlAuditConfig = {}) {}

  record(event: AuditEvent): Promise<void> {
    const task = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const filename = await this.filename(event.timestamp.slice(0, 10), Buffer.byteLength(JSON.stringify(event)) + 256)
      let previousHash: string | undefined
      if (this.config.hashChain !== false) {
        if (this.tails.has(filename)) previousHash = this.tails.get(filename)
        else previousHash = await tailHash(filename)
      }
      const hash = this.config.hashChain === false ? undefined : digest(event, previousHash)
      const stored: StoredAuditEvent = {
        version: 1, event,
        ...(previousHash ? { previousHash } : {}),
        ...(hash ? { hash } : {}),
      }
      await appendFile(filename, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 })
      if (hash) this.tails.set(filename, hash)
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  async flush(): Promise<void> { await this.queue }

  async prune(now = Date.now()): Promise<number> {
    const retention = this.config.retentionDays
    if (retention === undefined) return 0
    let removed = 0
    let files: string[] = []
    try { files = await readdir(this.directory) } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 0
      throw error
    }
    for (const file of files.filter(item => item.endsWith('.jsonl'))) {
      const info = await stat(path.join(this.directory, file))
      if (info.mtimeMs < now - retention * 86_400_000) {
        await unlink(path.join(this.directory, file))
        removed += 1
      }
    }
    return removed
  }

  private async filename(day: string, incomingBytes: number): Promise<string> {
    const limit = this.config.maxFileBytes ?? 10_000_000
    for (let index = 0; ; index += 1) {
      const candidate = path.join(this.directory, `${day}${index ? `.${index}` : ''}.jsonl`)
      try { if ((await stat(candidate)).size + incomingBytes > limit) continue } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      }
      return candidate
    }
  }
}

async function tailHash(filename: string): Promise<string | undefined> {
  try {
    const lines = (await readFile(filename, 'utf8')).split('\n').filter(Boolean)
    if (!lines.length) return undefined
    return (JSON.parse(lines.at(-1) ?? '') as StoredAuditEvent).hash
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function readAuditEvents(directory: string, limit = 100): Promise<AuditEvent[]> {
  let files: string[]
  try {
    files = (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort((left, right) => {
      const day = right.slice(0, 10).localeCompare(left.slice(0, 10))
      if (day) return day
      const rotation = (value: string) => Number(value.match(/^\d{4}-\d{2}-\d{2}\.(\d+)\.jsonl$/)?.[1] ?? 0)
      return rotation(right) - rotation(left)
    })
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const events: AuditEvent[] = []
  for (const file of files) {
    const source = await readFile(path.join(directory, file), 'utf8')
    const complete = source.endsWith('\n')
    const parsed: StoredAuditEvent[] = []
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        const stored = JSON.parse(line) as StoredAuditEvent
        if (stored.version !== 1 || !stored.event) throw new Error('unsupported audit schema')
        parsed.push(stored)
      } catch (error) {
        if (!complete && index === lines.length - 1) break
        throw new Error(`corrupt audit JSON in ${file} at line ${index + 1}`, { cause: error })
      }
    }
    let previous: string | undefined
    for (const stored of parsed) {
      if (stored.hash) {
        if (stored.previousHash !== previous || stored.hash !== digest(stored.event, previous)) {
          throw new Error(`audit hash chain verification failed in ${file}`)
        }
        previous = stored.hash
      }
    }
    for (const stored of parsed.reverse()) {
      events.push(stored.event)
      if (events.length >= limit) return events
    }
  }
  return events
}

export const name = 'jsonl-audit'
export const inject = ['audit', 'commands', 'project', 'tui']
export function apply(ctx: Context, config: JsonlAuditConfig = {}): void {
  const directory = config.directory
    ? path.isAbsolute(config.directory) ? config.directory : path.resolve(ctx.project.root, config.directory)
    : ctx.project.statePath('audit')
  const sink = new JsonlAuditSink(directory, config)
  ctx.audit.registerSink(sink)
  ctx.effect(() => () => ctx.audit.flush(), 'audit flush')
  ctx.tui.registerSessionHook({ id: 'deep-tui.audit.flush', priority: -100, start() {}, stop: () => ctx.audit.flush() })
  ctx.tui.registerSlashCommand({
    id: 'deep-tui.audit.show', name: 'audit', description: 'Show recent redacted model, permission, and tool events.',
    async run(args, actions) {
      const events = await readAuditEvents(directory, 200)
      if (args[0] === 'show') {
        const event = events.find(item => item.id === args[1])
        if (!event) throw new Error(`audit event "${args[1] ?? ''}" was not found`)
        actions.showOverlay({ id: 'audit-detail', title: event.type, lines: JSON.stringify(event, null, 2).split('\n') })
        return
      }
      const prefix = args[0] === 'tools' ? 'tool.' : args[0] === 'permissions' ? 'permission.' : undefined
      const filtered = events.filter(event => (!prefix || event.type.startsWith(prefix))
        && (!actions.state.conversationId || !event.conversationId || event.conversationId === actions.state.conversationId)).slice(0, 30)
      actions.showOverlay({ id: 'audit', title: 'Audit history', lines: filtered.length
        ? [...filtered.map(event => `${event.id} · ${event.timestamp} · ${event.type}${event.data?.ruleId ? ` · rule ${String(event.data.ruleId)}` : ''}`), '', 'Use /audit show <event-id> for details.']
        : ['No audit events yet.'] })
    },
  })
  ctx.commands.register({
    name: 'audit', description: 'Inspect redacted audit events.',
    async run(args, environment) {
      const action = args[0] ?? 'list'
      if (action === 'prune') {
        if (!args.includes('--yes')) throw new Error('audit prune requires --yes')
        environment.stdout.write(`Pruned ${await sink.prune()} audit files.\n`)
        return
      }
      const events = await readAuditEvents(directory, Number(args.find(value => /^\d+$/.test(value))) || 100)
      if (action === 'show') {
        const event = events.find(item => item.id === args[1])
        if (!event) throw new Error(`audit event "${args[1] ?? ''}" was not found`)
        environment.stdout.write(`${JSON.stringify(event, null, 2)}\n`)
        return
      }
      if (!['list', 'export'].includes(action)) throw new Error('usage: audit list [limit]|show <id>|export [limit]|prune --yes')
      for (const event of events) environment.stdout.write(`${JSON.stringify(event)}\n`)
    },
  })
}
export default { name, inject, apply }
