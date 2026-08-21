import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import { assertRecord, type JsonObject } from '@flect/sdk'

export interface ProcessToolConfig {
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  envAllowlist?: string[]
  killGraceMs?: number
}

function argv(input: JsonObject): string[] {
  if (!Array.isArray(input.argv) || !input.argv.length || typeof input.argv[0] !== 'string' || !input.argv[0]
    || !input.argv.every(value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value))) {
    throw new TypeError('argv must be a non-empty array of strings')
  }
  return input.argv as string[]
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export const name = 'process-tool'
export const inject = ['tools', 'workspace']

export function apply(ctx: Context, config: ProcessToolConfig = {}): void {
  ctx.tools.register({
    name: 'run_command', description: 'Run an argv command without a shell inside the workspace.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['argv'], properties: {
      argv: { type: 'array', minItems: 1, items: { type: 'string' } }, cwd: { type: 'string' },
      stdin: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 }, env: { type: 'object' },
    } },
    permission(input) {
      assertRecord(input, 'tool input')
      const values = argv(input)
      const executable = path.basename(values[0] ?? 'command')
      const subcommand = values[1] && !values[1].startsWith('-') ? values[1] : undefined
      const invocation = createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)
      return { capability: 'process.exec', risk: 'execute', description: `Run ${values.join(' ')}`,
        metadata: { argv: values, cwd: input.cwd }, remember: [
          { key: `process.exec:${executable}:argv:${invocation}`, label: `this exact ${executable} invocation (${invocation})` },
          ...(subcommand ? [{ key: `process.exec:${executable}:${subcommand}`, label: `all ${executable} ${subcommand} invocations` }] : []),
        ] }
    },
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const values = argv(input)
      const cwd = await ctx.workspace.resolveRead(typeof input.cwd === 'string' ? input.cwd : '.', execution)
      if (!(await stat(cwd)).isDirectory()) throw new Error('command cwd must be a directory')
      const selectedRoot = (await ctx.workspace.roots(execution))
        .filter(root => root.available && contains(root.path, cwd))
        .sort((left, right) => right.path.length - left.path.length)[0]
      if (selectedRoot?.access === 'read-only') {
        throw new Error(`cannot run a command in read-only workspace folder: ${selectedRoot.prefix}`)
      }
      const timeoutMs = Math.min(
        typeof input.timeoutMs === 'number' ? input.timeoutMs : config.timeoutMs ?? 30_000,
        config.maxTimeoutMs ?? 300_000,
      )
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer')
      const maxBytes = config.maxOutputBytes ?? 1_000_000
      const env: NodeJS.ProcessEnv = {}
      for (const key of config.envAllowlist ?? ['PATH', 'LANG', 'LC_ALL', 'TERM']) if (process.env[key] !== undefined) env[key] = process.env[key]
      if (input.env !== undefined) {
        assertRecord(input.env, 'env')
        for (const [key, value] of Object.entries(input.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /(authorization|token|secret|password|cookie|api_?key)/i.test(key)) {
            throw new Error(`environment override is not allowed: ${key}`)
          }
          if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`environment value ${key} must be a string without NUL bytes`)
          env[key] = value
        }
      }
      return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = spawn(values[0] as string, values.slice(1), { cwd, env, shell: false, detached: process.platform !== 'win32' })
        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let stdoutTruncated = false
        let stderrTruncated = false
        let timedOut = false
        let settled = false
        const append = (current: Buffer, chunk: Buffer, mark: () => void) => {
          const combined = Buffer.concat([current, chunk])
          if (combined.length <= maxBytes) return combined
          mark()
          return combined.subarray(0, maxBytes)
        }
        child.stdout.on('data', chunk => { stdout = append(stdout, Buffer.from(chunk), () => { stdoutTruncated = true }) })
        child.stderr.on('data', chunk => { stderr = append(stderr, Buffer.from(chunk), () => { stderrTruncated = true }) })
        child.on('error', error => { if (!settled) { settled = true; reject(error) } })
        const signal = (name: NodeJS.Signals) => {
          if (child.pid && process.platform !== 'win32') {
            try { process.kill(-child.pid, name) } catch {}
          } else child.kill(name)
        }
        let forceTimer: NodeJS.Timeout | undefined
        const terminate = () => {
          signal('SIGTERM')
          forceTimer ??= setTimeout(() => signal('SIGKILL'), config.killGraceMs ?? 1_000)
        }
        const timer = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
        const abort = () => terminate()
        execution.signal?.addEventListener('abort', abort, { once: true })
        if (typeof input.stdin === 'string') child.stdin.end(input.stdin)
        else child.stdin.end()
        child.on('close', (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (forceTimer) clearTimeout(forceTimer)
          execution.signal?.removeEventListener('abort', abort)
          if (execution.signal?.aborted) { reject(execution.signal.reason); return }
          resolve({
            code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
            stdoutTruncated, stderrTruncated, timedOut, elapsedMs: Date.now() - started,
          })
        })
      })
    },
  })
}

export default { name, inject, apply }
