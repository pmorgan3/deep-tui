import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type {
  ToolExecutionContext,
  WorkspaceEntry,
  WorkspaceProvider,
  WorkspaceRoot,
  WorkspaceWalkOptions,
} from '@deep-tui/sdk'

export interface WorkspaceIgnoreConfig {
  /** Ignore filenames loaded in every traversed directory. */
  files?: string[]
  /** Also load .git/info/exclude at each workspace root. Defaults to true. */
  includeGitInfoExclude?: boolean
  /** Extra underlying entries scanned for each requested visible entry. */
  scanFactor?: number
  /** Absolute upper bound for a single underlying traversal. */
  maxScanEntries?: number
}

export interface IgnoreRule {
  source: string
  line: number
  negated: boolean
  expression: RegExp
}

function portable(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globSource(pattern: string): string {
  let output = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          output += '(?:.*/)?'
        } else {
          output += '.*'
        }
      } else {
        output += '[^/]*'
      }
    } else if (character === '?') {
      output += '[^/]'
    } else if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) output += '\\['
      else {
        let body = pattern.slice(index + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        else if (body.startsWith('^')) body = `\\${body}`
        output += `[${body.replace(/\\/g, '\\\\')}]`
        index = end
      }
    } else if (character === '\\' && pattern[index + 1]) {
      index += 1
      output += escapeRegex(pattern[index] ?? '')
    } else {
      output += escapeRegex(character ?? '')
    }
  }
  return output
}

function unescapedTrailingSpaces(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === ' ') {
    let slashes = 0
    for (let index = end - 2; index >= 0 && value[index] === '\\'; index -= 1) slashes += 1
    if (slashes % 2 === 1) break
    end -= 1
  }
  return value.slice(0, end).replace(/\\ /g, ' ')
}

/** Parse one gitignore-style source relative to its containing directory. */
export function parseIgnoreFile(source: string, base = '', name = '.gitignore'): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const [index, raw] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    let pattern = unescapedTrailingSpaces(raw)
    if (!pattern || pattern.startsWith('#')) continue
    const escapedMarker = pattern.startsWith('\\#') || pattern.startsWith('\\!')
    if (escapedMarker) pattern = pattern.slice(1)
    let negated = false
    if (!escapedMarker && pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    }
    if (!pattern) continue
    const directoryOnly = pattern.endsWith('/')
    if (directoryOnly) pattern = pattern.slice(0, -1)
    const anchored = pattern.startsWith('/')
    if (anchored) pattern = pattern.slice(1)
    if (!pattern) continue
    const normalizedBase = portable(base).replace(/^\.$/, '').replace(/\/$/, '')
    const basePrefix = normalizedBase ? `${escapeRegex(normalizedBase)}/` : ''
    const hasSlash = pattern.includes('/')
    const prefix = anchored || hasSlash
      ? `^${basePrefix}`
      : `^${basePrefix}(?:.*/)?`
    rules.push({
      source: name,
      line: index + 1,
      negated,
      expression: new RegExp(`${prefix}${globSource(pattern)}(?:/.*)?$`),
    })
  }
  return rules
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

class RootRules {
  private readonly loaded = new Set<string>()
  private readonly rules: IgnoreRule[] = []

  constructor(
    private readonly root: WorkspaceRoot,
    private readonly files: readonly string[],
    private readonly gitInfo: boolean,
  ) {}

  async initialize(): Promise<void> {
    if (this.gitInfo) await this.loadFile('.git/info/exclude', '', '.git/info/exclude')
    await this.loadDirectory('')
  }

  async loadThrough(directory: string): Promise<void> {
    const normalized = portable(directory).replace(/^\.$/, '').replace(/^\/+|\/+$/g, '')
    await this.loadDirectory('')
    if (!normalized) return
    const parts = normalized.split('/')
    for (let count = 1; count <= parts.length; count += 1) {
      await this.loadDirectory(parts.slice(0, count).join('/'))
    }
  }

  ignored(relative: string): boolean {
    const candidate = portable(relative).replace(/^\/+/, '')
    let ignored = false
    for (const rule of this.rules) {
      if (rule.expression.test(candidate)) ignored = !rule.negated
    }
    return ignored
  }

  private async loadDirectory(directory: string): Promise<void> {
    const key = portable(directory).replace(/^\.$/, '')
    if (this.loaded.has(key)) return
    this.loaded.add(key)
    for (const file of this.files) {
      await this.loadFile(key ? `${key}/${file}` : file, key, key ? `${this.root.prefix}/${key}/${file}` : `${this.root.prefix}/${file}`)
    }
  }

  private async loadFile(relative: string, base: string, sourceName: string): Promise<void> {
    try {
      const source = await readFile(path.join(this.root.path, ...portable(relative).split('/')), 'utf8')
      this.rules.push(...parseIgnoreFile(source, base, sourceName))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

interface LocatedEntry {
  root: WorkspaceRoot
  relative: string
}

function locate(entry: string, roots: readonly WorkspaceRoot[]): LocatedEntry | undefined {
  const normalized = portable(entry)
  const mounted = roots
    .filter(root => !root.primary)
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find(root => normalized === root.prefix || normalized.startsWith(`${root.prefix}/`))
  if (mounted) return {
    root: mounted,
    relative: normalized === mounted.prefix ? '' : normalized.slice(mounted.prefix.length + 1),
  }
  const primary = roots.find(root => root.primary)
  return primary ? { root: primary, relative: normalized } : undefined
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

export function createIgnoringWorkspaceProvider(
  ctx: Context,
  config: WorkspaceIgnoreConfig = {},
): WorkspaceProvider {
  const id = 'deep-tui.ignore-workspace'
  const files = config.files ?? ['.gitignore', '.ignore']
  if (!files.length || files.some(file => !file || file.includes('/') || file.includes('\\') || file === '.' || file === '..')) {
    throw new TypeError('workspace ignore files must be non-empty filenames without path separators')
  }
  const scanFactor = integer(config.scanFactor, 20, 1, 1_000, 'workspace ignore scanFactor')
  const maximumScan = integer(config.maxScanEntries, 100_000, 1, 10_000_000, 'workspace ignore maxScanEntries')
  const delegate = (): WorkspaceProvider => {
    const provider = ctx.workspace.list()
      .filter(item => item.id !== id)
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0]
    if (!provider) throw new Error('workspace ignore requires another workspace provider')
    return provider
  }
  return {
    id,
    priority: 10_000,
    resolveRead: (relative, execution) => delegate().resolveRead(relative, execution),
    resolveWrite: (relative, execution) => delegate().resolveWrite(relative, execution),
    async roots(execution) {
      const underlying = delegate()
      return await underlying.roots?.(execution) ?? [{
        id: 'primary', label: path.basename(execution.cwd) || execution.cwd,
        path: path.resolve(execution.cwd), prefix: '.', primary: true,
        access: 'read-write' as const, available: true,
      }]
    },
    displayPath: (absolute, execution) => delegate().displayPath?.(absolute, execution)
      ?? Promise.resolve(path.relative(path.resolve(execution.cwd), path.resolve(absolute)) || '.'),
    async *walk(options: WorkspaceWalkOptions, execution: ToolExecutionContext): AsyncIterable<WorkspaceEntry> {
      const underlying = delegate()
      const roots = await underlying.roots?.(execution) ?? [{
        id: 'primary', label: path.basename(execution.cwd), path: path.resolve(execution.cwd), prefix: '.',
        primary: true, access: 'read-write' as const, available: true,
      }]
      const rootRules = new Map<string, RootRules>()
      for (const root of roots.filter(root => root.available)) {
        const rules = new RootRules(root, files, config.includeGitInfoExclude !== false)
        await rules.initialize()
        rootRules.set(root.id, rules)
      }
      const requested = Math.max(0, options.maxEntries ?? 1_000)
      const scanLimit = Math.min(maximumScan, Math.max(requested, requested * scanFactor))
      let visible = 0
      for await (const entry of underlying.walk({ ...options, maxEntries: scanLimit }, execution)) {
        const located = locate(entry.path, roots)
        if (!located || !located.relative) {
          if (visible < requested) { yield entry; visible += 1 }
          if (visible >= requested) return
          continue
        }
        const rules = rootRules.get(located.root.id)
        if (rules) {
          const parent = entry.type === 'directory' ? located.relative : path.posix.dirname(located.relative)
          await rules.loadThrough(parent)
          if (rules.ignored(located.relative)) continue
        }
        yield entry
        visible += 1
        if (visible >= requested) return
      }
    },
  }
}

export const name = 'workspace-ignore'
export const inject = ['workspace']

export function apply(ctx: Context, config: WorkspaceIgnoreConfig = {}): void {
  ctx.workspace.register(createIgnoringWorkspaceProvider(ctx, config))
}

export default { name, inject, apply }
