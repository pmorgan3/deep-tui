import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type {
  ToolExecutionContext,
  TuiActions,
  WorkspaceEntry,
  WorkspaceProvider,
  WorkspaceRoot,
  WorkspaceWalkOptions,
} from '@deep-tui/sdk'
import {
  isWithinRoot,
  portablePath,
  resolveLocalRead,
  resolveLocalWrite,
  walkLocalWorkspace,
} from '@deep-tui/plugin-workspace-local'

export interface ConfiguredFolder {
  alias: string
  path: string
  access?: 'read-only' | 'read-write'
}

export interface MultiRootWorkspaceConfig {
  folders?: ConfiguredFolder[]
  persist?: boolean
  stateFile?: string
  maxEntries?: number
  ignoredDirectories?: string[]
}

interface MountedFolder extends WorkspaceRoot {
  configured: boolean
}

interface StoredFolders {
  version: 1
  folders: ConfiguredFolder[]
}

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function validateAlias(value: string): string {
  const alias = value.trim()
  if (!aliasPattern.test(alias) || alias.toLowerCase() === 'primary') {
    throw new Error('folder alias must be 1-64 letters, numbers, dots, underscores, or hyphens and cannot be "primary"')
  }
  return alias
}

function defaultAlias(filename: string): string {
  const candidate = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64)
  return validateAlias(candidate || 'folder')
}

function stateFilename(ctx: Context, config: MultiRootWorkspaceConfig): string {
  if (!config.stateFile) return ctx.project.statePath('folders.json')
  return path.isAbsolute(config.stateFile)
    ? config.stateFile
    : path.resolve(ctx.project.root, config.stateFile)
}

async function folder(pathname: string, alias: string, access: WorkspaceRoot['access'], configured: boolean): Promise<MountedFolder> {
  const absolute = path.resolve(pathname)
  try {
    const canonical = await realpath(absolute)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error(`workspace folder is not a directory: ${pathname}`)
    return {
      id: alias.toLowerCase(), label: alias, path: canonical, prefix: `@${alias}`,
      primary: false, access, available: true, configured,
    }
  } catch (error) {
    if (!missing(error)) throw error
    return {
      id: alias.toLowerCase(), label: alias, path: absolute, prefix: `@${alias}`,
      primary: false, access, available: false, configured,
    }
  }
}

class FolderManager {
  private readonly additional = new Map<string, MountedFolder>()
  private readonly dynamic = new Set<string>()
  private primary!: MountedFolder

  constructor(private readonly ctx: Context, private readonly config: MultiRootWorkspaceConfig) {}

  async initialize(): Promise<void> {
    const root = await realpath(this.ctx.project.root)
    this.primary = {
      id: 'primary', label: path.basename(root) || root, path: root, prefix: '.',
      primary: true, access: 'read-write', available: true, configured: true,
    }
    for (const item of this.config.folders ?? []) await this.mount(item, true)
    if (this.config.persist !== false) {
      try {
        const parsed = JSON.parse(await readFile(stateFilename(this.ctx, this.config), 'utf8')) as Partial<StoredFolders>
        if (parsed.version !== 1 || !Array.isArray(parsed.folders)) throw new Error('folder state must use schema version 1')
        for (const item of parsed.folders) {
          if (!item || typeof item.alias !== 'string' || typeof item.path !== 'string') {
            throw new Error('folder state contains an invalid folder')
          }
          if (!this.additional.has(item.alias.toLowerCase())) await this.mount(item, false)
        }
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }

  roots(): MountedFolder[] { return [this.primary, ...this.additional.values()] }

  async refresh(): Promise<MountedFolder[]> {
    const refreshed = new Map<string, MountedFolder>()
    for (const [id, current] of this.additional) {
      refreshed.set(id, await folder(current.path, current.label, current.access, current.configured))
    }
    const available = [this.primary, ...refreshed.values()].filter(root => root.available)
    for (let left = 0; left < available.length; left += 1) {
      for (let right = left + 1; right < available.length; right += 1) {
        const first = available[left]
        const second = available[right]
        if (first && second && (isWithinRoot(first.path, second.path) || isWithinRoot(second.path, first.path))) {
          throw new Error(`workspace folder ${second.prefix} overlaps ${first.prefix}: ${second.path}`)
        }
      }
    }
    this.additional.clear()
    for (const [id, root] of refreshed) this.additional.set(id, root)
    this.ctx.workspace.invalidate()
    return this.roots()
  }

  async add(pathname: string, requestedAlias?: string, access: WorkspaceRoot['access'] = 'read-write'): Promise<MountedFolder> {
    const absolute = path.resolve(this.ctx.project.root, pathname)
    const canonical = await realpath(absolute)
    if (!(await stat(canonical)).isDirectory()) throw new Error(`workspace folder is not a directory: ${pathname}`)
    const alias = validateAlias(requestedAlias ?? defaultAlias(canonical))
    const id = alias.toLowerCase()
    if (this.additional.has(id)) throw new Error(`workspace folder alias already exists: ${alias}`)
    this.assertNoOverlap(canonical)
    const mounted = await folder(canonical, alias, access, false)
    this.additional.set(id, mounted)
    this.dynamic.add(id)
    try {
      await this.persist()
    } catch (error) {
      this.additional.delete(id)
      this.dynamic.delete(id)
      throw error
    }
    this.ctx.workspace.invalidate()
    return mounted
  }

  async remove(alias: string): Promise<MountedFolder> {
    const id = alias.replace(/^@/, '').toLowerCase()
    const mounted = this.additional.get(id)
    if (!mounted) throw new Error(`workspace folder was not found: ${alias}`)
    if (mounted.configured || !this.dynamic.has(id)) throw new Error(`configured workspace folder cannot be removed at runtime: ${mounted.label}`)
    this.additional.delete(id)
    this.dynamic.delete(id)
    try {
      await this.persist()
    } catch (error) {
      this.additional.set(id, mounted)
      this.dynamic.add(id)
      throw error
    }
    this.ctx.workspace.invalidate()
    return mounted
  }

  private async mount(item: ConfiguredFolder, configured: boolean): Promise<void> {
    const alias = validateAlias(item.alias)
    const id = alias.toLowerCase()
    if (this.additional.has(id)) throw new Error(`duplicate workspace folder alias: ${alias}`)
    if (item.access !== undefined && item.access !== 'read-only' && item.access !== 'read-write') {
      throw new Error(`invalid access for workspace folder ${alias}`)
    }
    const absolute = path.resolve(this.ctx.project.root, item.path)
    const mounted = await folder(absolute, alias, item.access ?? 'read-write', configured)
    this.assertNoOverlap(mounted.path)
    this.additional.set(id, mounted)
    if (!configured) this.dynamic.add(id)
  }

  private assertNoOverlap(candidate: string): void {
    for (const root of this.roots()) {
      if (isWithinRoot(root.path, candidate) || isWithinRoot(candidate, root.path)) {
        throw new Error(`workspace folder overlaps ${root.prefix}: ${candidate}`)
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.config.persist === false) return
    const target = stateFilename(this.ctx, this.config)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    const folders = [...this.dynamic].flatMap(id => {
      const item = this.additional.get(id)
      return item ? [{ alias: item.label, path: item.path, access: item.access }] : []
    })
    await writeFile(temporary, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }
}

interface Address {
  root: MountedFolder
  relative: string
}

function address(manager: FolderManager, requested: string): Address {
  const normalized = requested.replace(/\\/g, '/') || '.'
  if (!normalized.startsWith('@')) return { root: manager.roots()[0] as MountedFolder, relative: normalized }
  const match = normalized.match(/^@([^/]+)(?:\/(.*))?$/)
  if (!match?.[1]) throw new Error(`invalid mounted workspace path: ${requested}`)
  const root = manager.roots().find(candidate => !candidate.primary && candidate.id === match[1]?.toLowerCase())
  if (!root) throw new Error(`unknown workspace folder alias: @${match[1]}`)
  return { root, relative: match[2] || '.' }
}

function requireAvailable(root: MountedFolder): void {
  if (!root.available) throw new Error(`workspace folder is unavailable: ${root.prefix} (${root.path})`)
}

async function* interleavedWalk(
  manager: FolderManager,
  options: WorkspaceWalkOptions,
  config: MultiRootWorkspaceConfig,
): AsyncIterable<WorkspaceEntry> {
  const requested = options.path ?? '.'
  if (requested !== '.' && requested !== '') {
    const selected = address(manager, requested)
    requireAvailable(selected.root)
    for await (const entry of walkLocalWorkspace(selected.root.path, { ...options, path: selected.relative }, config)) {
      yield {
        ...entry,
        path: selected.root.primary ? entry.path : `${selected.root.prefix}/${entry.path}`,
      }
    }
    return
  }

  const roots = manager.roots().filter(root => root.available)
  const limit = Math.max(0, options.maxEntries ?? config.maxEntries ?? 1_000)
  let count = 0
  for (const root of roots.filter(root => !root.primary)) {
    if (count >= limit) return
    yield { path: root.prefix, type: 'directory' }
    count += 1
  }
  const iterators = roots.map(root => ({
    root,
    iterator: walkLocalWorkspace(root.path, { ...options, path: '.', maxEntries: limit }, config)[Symbol.asyncIterator](),
  }))
  while (iterators.length && count < limit) {
    for (let index = 0; index < iterators.length && count < limit;) {
      const current = iterators[index]
      if (!current) break
      const next = await current.iterator.next()
      if (next.done) {
        iterators.splice(index, 1)
        continue
      }
      yield {
        ...next.value,
        path: current.root.primary ? next.value.path : `${current.root.prefix}/${next.value.path}`,
      }
      count += 1
      index += 1
    }
  }
}

function provider(manager: FolderManager, config: MultiRootWorkspaceConfig): WorkspaceProvider {
  return {
    id: 'deep-tui.multi-root-workspace', priority: 500,
    async resolveRead(requested, _context) {
      const selected = address(manager, requested)
      requireAvailable(selected.root)
      return resolveLocalRead(selected.root.path, selected.relative)
    },
    async resolveWrite(requested, _context) {
      const selected = address(manager, requested)
      requireAvailable(selected.root)
      if (selected.root.access !== 'read-write') throw new Error(`workspace folder is read-only: ${selected.root.prefix}`)
      return resolveLocalWrite(selected.root.path, selected.relative)
    },
    walk: options => interleavedWalk(manager, options, config),
    roots: () => manager.roots(),
    async displayPath(absolute: string, _context: ToolExecutionContext) {
      const resolved = path.resolve(absolute)
      const root = manager.roots().find(candidate => candidate.available && isWithinRoot(candidate.path, resolved))
      if (!root) throw new Error(`path is outside configured workspace folders: ${absolute}`)
      const relative = portablePath(path.relative(root.path, resolved))
      return root.primary ? relative || '.' : `${root.prefix}${relative ? `/${relative}` : ''}`
    },
  }
}

function rootLines(roots: readonly WorkspaceRoot[]): string[] {
  return roots.map(root => {
    const state = root.available ? (root.access === 'read-only' ? 'read-only' : 'read-write') : 'unavailable'
    return `${root.prefix.padEnd(16)} ${state.padEnd(12)} ${root.path}`
  })
}

function ensureIdle(actions: TuiActions): void {
  if (actions.state.busy) throw new Error('wait for the current agent run before changing workspace folders')
}

export const name = 'multi-root-workspace'
export const inject = ['commands', 'project', 'prompts', 'tui', 'workspace']

export async function apply(ctx: Context, config: MultiRootWorkspaceConfig = {}): Promise<void> {
  const manager = new FolderManager(ctx, config)
  await manager.initialize()
  ctx.workspace.register(provider(manager, config))

  ctx.prompts.register({
    id: 'deep-tui.workspace.multi-root.prompt', order: 10, placement: 'context',
    render() {
      const additional = manager.roots().filter(root => !root.primary && root.available)
      if (!additional.length) return [
        'No additional workspace folders are currently mounted.',
        'Unprefixed paths refer to the primary workspace.',
      ].join('\n')
      return [
        'Additional workspace folders are mounted in a virtual path namespace.',
        ...additional.map(root => `- ${root.prefix}/ maps to ${root.path} (${root.access})`),
        'Unprefixed paths refer to the primary workspace. Use @alias/path for additional folders in every file, search, patch, and command tool.',
      ].join('\n')
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'deep-tui.workspace.folders.command', name: 'folders', aliases: ['folder'],
    description: 'List, add, or remove workspace folders.',
    usage: '/folders [add <path> [alias] [--read-only]|remove <alias>|status]',
    complete({ args, query }) {
      if (!args.length || (args.length === 1 && args[0] === query)) {
        return ['add ', 'remove ', 'status'].filter(value => value.startsWith(query.toLowerCase()))
          .map(value => ({ value, label: value.trim(), description: `${value.trim()} workspace folders.` }))
      }
      if (args[0] === 'remove') return manager.roots().filter(root => !root.primary && !root.configured)
        .filter(root => root.label.toLowerCase().startsWith(query.toLowerCase()))
        .map(root => ({ value: root.label, label: root.prefix, description: root.path }))
      return []
    },
    async run(args, actions) {
      const action = args[0]?.toLowerCase() ?? 'status'
      if (action === 'add') {
        ensureIdle(actions)
        const pathname = args[1]
        if (!pathname) throw new Error('usage: /folders add <path> [alias] [--read-only]')
        const readOnly = args.includes('--read-only')
        const alias = args.slice(2).find(value => value !== '--read-only')
        const mounted = await manager.add(pathname, alias, readOnly ? 'read-only' : 'read-write')
        actions.notify(`mounted ${mounted.prefix} · ${mounted.access}`)
        return
      }
      if (action === 'remove') {
        ensureIdle(actions)
        if (!args[1] || args.length > 2) throw new Error('usage: /folders remove <alias>')
        const removed = await manager.remove(args[1])
        actions.notify(`removed ${removed.prefix}`)
        return
      }
      if (action !== 'status' || args.length > 1) throw new Error('usage: /folders [add <path> [alias] [--read-only]|remove <alias>|status]')
      const roots = await manager.refresh()
      actions.showOverlay({
        id: 'workspace-folders', title: 'Workspace folders',
        lines: [...rootLines(roots), '', 'Use @alias/path to address an additional folder.', 'Use /folders add or /folders remove to change this project.'],
      })
    },
  })

  ctx.commands.register({
    name: 'folders', description: 'List, add, or remove workspace folders.',
    async run(args, environment) {
      const action = args[0]?.toLowerCase() ?? 'list'
      if (action === 'add') {
        const pathname = args[1]
        if (!pathname) throw new Error('usage: deep-tui folders add <path> [alias] [--read-only]')
        const mounted = await manager.add(
          pathname,
          args.slice(2).find(value => value !== '--read-only'),
          args.includes('--read-only') ? 'read-only' : 'read-write',
        )
        environment.stdout.write(`Mounted ${mounted.prefix} ${mounted.path}\n`)
        return
      }
      if (action === 'remove') {
        if (!args[1] || args.length > 2) throw new Error('usage: deep-tui folders remove <alias>')
        const removed = await manager.remove(args[1])
        environment.stdout.write(`Removed ${removed.prefix}\n`)
        return
      }
      if (action !== 'list' && action !== 'status') throw new Error('usage: deep-tui folders <list|add|remove>')
      environment.stdout.write(`${rootLines(await manager.refresh()).join('\n')}\n`)
    },
  })
}

export default { name, inject, apply }
