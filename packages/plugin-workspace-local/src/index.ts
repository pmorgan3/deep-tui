import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type {
  ToolExecutionContext,
  WorkspaceEntry,
  WorkspaceProvider,
  WorkspaceWalkOptions,
} from '@flect/sdk'

export interface LocalWorkspaceConfig {
  maxEntries?: number
  ignoredDirectories?: string[]
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function lexicalPath(root: string, requested: string): string {
  if (path.isAbsolute(requested)) throw new Error(`path escapes workspace: ${requested}`)
  const candidate = path.resolve(root, requested)
  if (!isWithinRoot(path.resolve(root), candidate)) throw new Error(`path escapes workspace: ${requested}`)
  return candidate
}

export async function resolveLocalRead(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root)
  const candidate = await realpath(lexicalPath(rootReal, requested))
  if (!isWithinRoot(rootReal, candidate)) throw new Error(`path escapes workspace through a symlink: ${requested}`)
  return candidate
}

async function nearestExisting(candidate: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function resolveLocalWrite(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root)
  const candidate = lexicalPath(rootReal, requested)
  const existing = await nearestExisting(path.dirname(candidate))
  const existingReal = await realpath(existing)
  if (!isWithinRoot(rootReal, existingReal)) {
    throw new Error(`path escapes workspace through a symlink: ${requested}`)
  }
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`path escapes workspace through a symlink: ${requested}`)
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await mkdir(path.dirname(candidate), { recursive: true })
  const parentReal = await realpath(path.dirname(candidate))
  if (!isWithinRoot(rootReal, parentReal)) {
    throw new Error(`path escapes workspace through a symlink: ${requested}`)
  }
  return path.join(parentReal, path.basename(candidate))
}

export function portablePath(value: string): string {
  return value.split(path.sep).join('/')
}

export async function* walkLocalWorkspace(
  root: string,
  options: WorkspaceWalkOptions,
  defaults: LocalWorkspaceConfig = {},
): AsyncIterable<WorkspaceEntry> {
  const rootReal = await realpath(root)
  const start = await resolveLocalRead(rootReal, options.path ?? '.')
  if (!(await stat(start)).isDirectory()) throw new Error(`${options.path ?? '.'} is not a directory`)
  const queue = [start]
  const skips = new Set(options.ignoredDirectories ?? defaults.ignoredDirectories ?? ['.git', 'node_modules', 'dist'])
  const limit = Math.max(0, options.maxEntries ?? defaults.maxEntries ?? 1_000)
  let count = 0
  while (queue.length && count < limit) {
    const directory = queue.shift()
    if (!directory) break
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && skips.has(entry.name))) continue
      const absolute = path.join(directory, entry.name)
      const relative = portablePath(path.relative(rootReal, absolute))
      const info = entry.isFile() ? await stat(absolute) : undefined
      yield { path: relative, type: entry.isDirectory() ? 'directory' : 'file', ...(info ? { size: info.size } : {}) }
      count += 1
      if (entry.isDirectory()) queue.push(absolute)
      if (count >= limit) break
    }
  }
}

export function createLocalWorkspaceProvider(config: LocalWorkspaceConfig = {}): WorkspaceProvider {
  return {
    id: 'flect.local-workspace', priority: -100,
    resolveRead: (relative, context) => resolveLocalRead(context.cwd, relative),
    resolveWrite: (relative, context) => resolveLocalWrite(context.cwd, relative),
    walk: (options, context) => walkLocalWorkspace(context.cwd, options, config),
    async roots(context: ToolExecutionContext) {
      const root = await realpath(context.cwd)
      return [{
        id: 'primary', label: path.basename(root) || root, path: root, prefix: '.',
        primary: true, access: 'read-write' as const, available: true,
      }]
    },
    async displayPath(absolute, context) {
      const root = await realpath(context.cwd)
      const resolved = path.resolve(absolute)
      if (!isWithinRoot(root, resolved)) throw new Error(`path is outside the workspace: ${absolute}`)
      return portablePath(path.relative(root, resolved)) || '.'
    },
  }
}

export const name = 'local-workspace'
export const inject = ['workspace']

export function apply(ctx: Context, config: LocalWorkspaceConfig = {}): void {
  ctx.workspace.register(createLocalWorkspaceProvider(config))
}

export default { name, inject, apply }
