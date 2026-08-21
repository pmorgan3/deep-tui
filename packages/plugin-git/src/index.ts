import { spawn } from 'node:child_process'
import type { Context } from 'cordis'
import { assertRecord, type JsonObject, type ToolExecutionContext } from '@deep-tui/sdk'

export interface GitPluginConfig {
  gitBinary?: string
  timeoutMs?: number
  maxOutputBytes?: number
  maxErrorBytes?: number
}

interface GitOutput {
  stdout: string
  stderr: string
  truncated: boolean
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${key} must be a non-empty bounded string without control characters`)
  }
  return value
}

function paths(input: JsonObject): string[] {
  const value = input.paths
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item || item.length > 4_096 || item.includes('\0'))) {
    throw new TypeError('paths must contain at most 100 non-empty bounded strings')
  }
  return value as string[]
}

function safeRef(input: JsonObject, fallback?: string): string | undefined {
  const value = optionalString(input, 'ref') ?? fallback
  if (value?.startsWith('-')) throw new TypeError('ref cannot begin with a dash')
  return value
}

async function repositoryCwd(ctx: Context, input: JsonObject, execution: ToolExecutionContext): Promise<string> {
  return ctx.workspace.resolveRead(optionalString(input, 'cwd') ?? '.', execution)
}

async function runGit(
  binary: string,
  cwd: string,
  args: readonly string[],
  config: Required<Pick<GitPluginConfig, 'timeoutMs' | 'maxOutputBytes' | 'maxErrorBytes'>>,
  signal?: AbortSignal,
): Promise<GitOutput> {
  return new Promise<GitOutput>((resolve, reject) => {
    const child = spawn(binary, ['-c', 'color.ui=false', '-c', 'core.pager=cat', ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let settled = false
    const stop = () => child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (settled) return
      stop()
      reject(new Error(`git command exceeded ${config.timeoutMs}ms`))
      settled = true
    }, config.timeoutMs)
    const abort = () => {
      if (settled) return
      stop()
      reject(signal?.reason ?? new Error('git command cancelled'))
      settled = true
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= config.maxOutputBytes) { truncated = true; return }
      const retained = chunk.subarray(0, config.maxOutputBytes - stdoutBytes)
      stdout.push(retained)
      stdoutBytes += retained.length
      if (retained.length < chunk.length) truncated = true
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= config.maxErrorBytes) return
      const retained = chunk.subarray(0, config.maxErrorBytes - stderrBytes)
      stderr.push(retained)
      stderrBytes += retained.length
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const out = Buffer.concat(stdout).toString('utf8')
      const error = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        reject(new Error(error || `git exited with code ${code ?? 'unknown'}`))
        return
      }
      resolve({ stdout: out, stderr: error, truncated })
    })
  })
}

export interface GitStatusEntry {
  path: string
  index: string
  worktree: string
  originalPath?: string
}

export function parsePorcelainStatus(source: string): {
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  entries: GitStatusEntry[]
  clean: boolean
} {
  const records = source.split('\0').filter(Boolean)
  const header = records[0]?.startsWith('## ') ? records.shift()?.slice(3) : undefined
  let branch = header
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  if (header) {
    const tracking = header.match(/^(.*?)\.\.\.([^ ]+)(?: \[(.*)])?$/)
    if (tracking) {
      branch = tracking[1]
      upstream = tracking[2]
      for (const item of tracking[3]?.split(', ') ?? []) {
        const count = Number(item.split(' ')[1])
        if (item.startsWith('ahead ') && Number.isFinite(count)) ahead = count
        if (item.startsWith('behind ') && Number.isFinite(count)) behind = count
      }
    }
  }
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const entry: GitStatusEntry = { path: record.slice(3), index: code[0] ?? ' ', worktree: code[1] ?? ' ' }
    const originalPath = records[index + 1]
    if (/[RC]/.test(code) && originalPath) {
      entry.originalPath = originalPath
      index += 1
    }
    entries.push(entry)
  }
  return {
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    entries,
    clean: entries.length === 0,
  }
}

export const name = 'git-tools'
export const inject = ['tools', 'workspace']

export function apply(ctx: Context, config: GitPluginConfig = {}): void {
  const limits = {
    timeoutMs: boundedInteger(config.timeoutMs, 10_000, 100, 300_000, 'git timeoutMs'),
    maxOutputBytes: boundedInteger(config.maxOutputBytes, 2_000_000, 1_000, 50_000_000, 'git maxOutputBytes'),
    maxErrorBytes: boundedInteger(config.maxErrorBytes, 16_000, 1_000, 1_000_000, 'git maxErrorBytes'),
  }
  const binary = config.gitBinary?.trim() || 'git'
  const permission = (input: JsonObject) => ({
    capability: 'fs.read', risk: 'read' as const, description: 'Inspect Git metadata in this workspace',
    metadata: { cwd: input.cwd, paths: input.paths, ref: input.ref },
    remember: [{ key: 'workspace.read', label: 'read configured workspace folders' }],
  })

  ctx.tools.register({
    name: 'git_status',
    description: 'Return structured Git branch and working-tree status without changing the repository.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      cwd: { type: 'string', description: 'Workspace-relative repository directory.' },
      paths: { type: 'array', maxItems: 100, items: { type: 'string' } },
    } },
    permission,
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const selectedPaths = paths(input)
      const cwd = await repositoryCwd(ctx, input, execution)
      const result = await runGit(binary, cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal', '--', ...selectedPaths], limits, execution.signal)
      return parsePorcelainStatus(result.stdout)
    },
  })

  ctx.tools.register({
    name: 'git_diff',
    description: 'Return a bounded Git diff for the working tree, index, or a requested ref.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      cwd: { type: 'string' }, ref: { type: 'string' }, cached: { type: 'boolean' },
      context: { type: 'integer', minimum: 0, maximum: 20 },
      paths: { type: 'array', maxItems: 100, items: { type: 'string' } },
    } },
    permission,
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const context = input.context === undefined ? 3 : input.context
      if (!Number.isInteger(context) || (context as number) < 0 || (context as number) > 20) throw new TypeError('context must be an integer from 0 through 20')
      const ref = safeRef(input)
      const selectedPaths = paths(input)
      const cwd = await repositoryCwd(ctx, input, execution)
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--color=never', `--unified=${context}`]
      if (input.cached === true) args.push('--cached')
      if (ref) args.push(ref)
      args.push('--', ...selectedPaths)
      const result = await runGit(binary, cwd, args, limits, execution.signal)
      execution.present?.({ type: 'diff', data: { diff: result.stdout, files: selectedPaths } })
      return { diff: result.stdout, truncated: result.truncated }
    },
  })

  ctx.tools.register({
    name: 'git_log',
    description: 'Return structured recent Git commits, optionally limited to one workspace path.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      cwd: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' },
      maxCount: { type: 'integer', minimum: 1, maximum: 100 },
    } },
    permission,
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const maximum = input.maxCount ?? 20
      if (!Number.isInteger(maximum) || (maximum as number) < 1 || (maximum as number) > 100) throw new TypeError('maxCount must be an integer from 1 through 100')
      const ref = safeRef(input)
      const selectedPath = optionalString(input, 'path')
      const cwd = await repositoryCwd(ctx, input, execution)
      const args = ['log', '--no-color', `--max-count=${maximum}`, '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e']
      if (ref) args.push(ref)
      if (selectedPath) args.push('--', selectedPath)
      const result = await runGit(binary, cwd, args, limits, execution.signal)
      const commits = result.stdout.split('\x1e').flatMap(record => {
        const trimmed = record.replace(/^\s+|\s+$/g, '')
        if (!trimmed) return []
        const [hash, parents, author, authoredAt, subject] = trimmed.split('\x1f')
        return hash && author && authoredAt && subject !== undefined ? [{
          hash, parents: parents ? parents.split(' ') : [], author, authoredAt, subject,
        }] : []
      })
      return { commits, truncated: result.truncated }
    },
  })

  ctx.tools.register({
    name: 'git_show',
    description: 'Show one Git object or commit as a bounded, non-interactive patch.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      cwd: { type: 'string' }, ref: { type: 'string' }, path: { type: 'string' },
    } },
    permission,
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const ref = safeRef(input, 'HEAD') as string
      const selectedPath = optionalString(input, 'path')
      const cwd = await repositoryCwd(ctx, input, execution)
      const args = ['show', '--no-ext-diff', '--no-textconv', '--color=never', '--format=fuller', '--stat', '--patch', ref]
      if (selectedPath) args.push('--', selectedPath)
      const result = await runGit(binary, cwd, args, limits, execution.signal)
      return { content: result.stdout, truncated: result.truncated }
    },
  })
}

export default { name, inject, apply }
