import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { assertRecord, createUnifiedDiff, type JsonObject } from '@flect/sdk'

export interface WorkspaceToolsConfig {
  maxReadBytes?: number
  maxEntries?: number
  read?: boolean
  write?: boolean
  ignoredDirectories?: string[]
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value) throw new TypeError(`${key} must be a non-empty string`)
  return value
}

export const name = 'workspace-tools'
export const inject = ['tools', 'workspace']

export function apply(ctx: Context, config: WorkspaceToolsConfig = {}): void {
  const maxReadBytes = config.maxReadBytes ?? 1_000_000
  const maxEntries = config.maxEntries ?? 1_000
  const ignoredDirectories = config.ignoredDirectories ?? ['.git', 'node_modules', 'dist']

  if (config.read !== false) {
    ctx.tools.register({
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the configured workspace folders.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: { path: { type: 'string', description: 'Workspace path; additional folders use @alias/path.' } },
      },
      permission: input => ({
        capability: 'fs.read', risk: 'read', description: 'Read files in the configured workspace folders',
        metadata: { path: input.path },
        remember: [{ key: 'workspace.read', label: 'read configured workspace folders' }],
      }),
      async execute(input, execution) {
        assertRecord(input, 'tool input')
        const requested = requireString(input, 'path')
        const filename = await ctx.workspace.resolveRead(requested, execution)
        const info = await stat(filename)
        if (!info.isFile()) throw new Error(`${requested} is not a file`)
        if (info.size > maxReadBytes) throw new Error(`${requested} is ${info.size} bytes; limit is ${maxReadBytes}`)
        const content = await readFile(filename, 'utf8')
        execution.present?.({ type: 'read-file', data: { path: requested } })
        return content
      },
    })

    ctx.tools.register({
      name: 'list_files',
      description: 'List files and directories across the configured workspace folders.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', description: 'Directory path; defaults to all workspace folders.' } },
      },
      permission: input => ({
        capability: 'fs.read', risk: 'read', description: 'Read files in the configured workspace folders',
        metadata: { path: input.path },
        remember: [{ key: 'workspace.read', label: 'read configured workspace folders' }],
      }),
      async execute(input, execution) {
        assertRecord(input, 'tool input')
        const files: string[] = []
        for await (const entry of ctx.workspace.walk({
          path: typeof input.path === 'string' ? input.path : '.',
          maxEntries,
          ignoredDirectories,
        }, execution)) {
          files.push(entry.type === 'directory' ? `${entry.path}/` : entry.path)
        }
        return files
      },
    })
  }

  if (config.write !== false) {
    ctx.tools.register({
      name: 'write_file',
      description: 'Write a complete UTF-8 text file inside a writable workspace folder.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Workspace path; additional folders use @alias/path.' },
          content: { type: 'string', description: 'Complete replacement content.' },
        },
      },
      permission: input => ({
        capability: 'fs.write', risk: 'write', description: 'Write files in the configured workspace folders',
        metadata: { path: input.path },
        remember: [{ key: 'workspace.write', label: 'write configured workspace folders' }],
      }),
      async execute(input, execution) {
        assertRecord(input, 'tool input')
        const requested = requireString(input, 'path')
        const content = input.content
        if (typeof content !== 'string') throw new TypeError('content must be a string')
        const filename = await ctx.workspace.resolveWrite(requested, execution)
        let before: string | undefined
        let textFile = true
        try {
          const existing = await readFile(filename)
          if (existing.includes(0)) textFile = false
          else before = existing.toString('utf8')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        await writeFile(filename, content, 'utf8')
        if (textFile && !content.includes('\0') && before !== content) {
          execution.present?.({
            type: 'diff', data: { diff: createUnifiedDiff(requested, before, content), files: [requested] },
          })
        }
        return { path: requested, bytes: Buffer.byteLength(content) }
      },
    })
  }
}

export default { name, inject, apply }
