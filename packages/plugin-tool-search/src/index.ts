import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import { assertRecord, type JsonObject } from '@flect/sdk'

export interface SearchToolsConfig {
  maxResults?: number
  maxFileBytes?: number
  maxDurationMs?: number
  ignoredDirectories?: string[]
}

function string(input: JsonObject, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

export const name = 'search-tools'
export const inject = ['tools', 'workspace']

export function apply(ctx: Context, config: SearchToolsConfig = {}): void {
  const maxResults = config.maxResults ?? 500
  const maxFileBytes = config.maxFileBytes ?? 1_000_000
  ctx.tools.register({
    name: 'find_files', description: 'Find workspace files by a Node glob pattern.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      pattern: { type: 'string', description: 'Glob pattern; defaults to **/*.' },
      path: { type: 'string', description: 'Directory to search; defaults to workspace root.' },
    } },
    permission: input => ({ capability: 'fs.read', risk: 'read', description: 'Read files in this workspace',
      metadata: { pattern: input.pattern, path: input.path },
      remember: [{ key: 'workspace.read', label: 'read files in this workspace' }] }),
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const pattern = typeof input.pattern === 'string' ? input.pattern : '**/*'
      const results: string[] = []
      for await (const entry of ctx.workspace.walk({
        path: typeof input.path === 'string' ? input.path : '.', maxEntries: maxResults * 10,
        ...(config.ignoredDirectories ? { ignoredDirectories: config.ignoredDirectories } : {}),
      }, execution)) {
        if (entry.type === 'file' && path.matchesGlob(entry.path, pattern)) results.push(entry.path)
        if (results.length >= maxResults) break
      }
      return { files: results, truncated: results.length >= maxResults }
    },
  })
  ctx.tools.register({
    name: 'search_text', description: 'Search UTF-8 workspace files for text or a regular expression.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string' }, regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' },
      pattern: { type: 'string', description: 'File glob; defaults to **/*.' }, path: { type: 'string' },
    } },
    permission: input => ({ capability: 'fs.read', risk: 'read', description: 'Read files in this workspace',
      metadata: { query: input.query, regex: input.regex, pattern: input.pattern, path: input.path },
      remember: [{ key: 'workspace.read', label: 'read files in this workspace' }] }),
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const query = string(input, 'query')
      if (query.length > 2_000) throw new Error('search query is too long')
      if (input.regex === true && /(?:\([^)]*[+*][^)]*\))[+*{]/.test(query)) throw new Error('search regular expression contains unsafe nested repetition')
      const flags = input.caseSensitive === true ? 'g' : 'gi'
      const expression = input.regex === true ? new RegExp(query, flags) : undefined
      const needle = input.caseSensitive === true ? query : query.toLowerCase()
      const matches: Array<{ path: string; line: number; column: number; preview: string }> = []
      const started = Date.now()
      for await (const entry of ctx.workspace.walk({
        path: typeof input.path === 'string' ? input.path : '.', maxEntries: maxResults * 20,
        ...(config.ignoredDirectories ? { ignoredDirectories: config.ignoredDirectories } : {}),
      }, execution)) {
        if (execution.signal?.aborted) throw execution.signal.reason
        if (Date.now() - started > (config.maxDurationMs ?? 10_000)) throw new Error('search exceeded its time limit')
        if (entry.type !== 'file' || (entry.size ?? 0) > maxFileBytes || !path.matchesGlob(entry.path, typeof input.pattern === 'string' ? input.pattern : '**/*')) continue
        const filename = await ctx.workspace.resolveRead(entry.path, execution)
        const buffer = await readFile(filename)
        if (buffer.includes(0)) continue
        const lines = buffer.toString('utf8').split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? ''
          if (expression) {
            expression.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = expression.exec(line))) {
              matches.push({ path: entry.path, line: index + 1, column: match.index + 1, preview: line.slice(0, 500) })
              if (matches.length >= maxResults) return { matches, truncated: true }
              if (!match[0]) expression.lastIndex += 1
            }
          } else {
            const haystack = input.caseSensitive === true ? line : line.toLowerCase()
            let column = haystack.indexOf(needle)
            while (column >= 0) {
              matches.push({ path: entry.path, line: index + 1, column: column + 1, preview: line.slice(0, 500) })
              if (matches.length >= maxResults) return { matches, truncated: true }
              column = haystack.indexOf(needle, column + Math.max(1, needle.length))
            }
          }
        }
      }
      return { matches, truncated: false }
    },
  })
}

export default { name, inject, apply }
