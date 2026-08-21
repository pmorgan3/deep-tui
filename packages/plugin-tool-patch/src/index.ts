import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import { assertRecord, type JsonObject } from '@flect/sdk'

export interface Hunk { oldStart: number; lines: string[]; noNewlineAtEnd?: boolean }
export interface FilePatch { oldPath: string; newPath: string; hunks: Hunk[] }

export interface PatchToolConfig {
  maxPatchBytes?: number
  maxFiles?: number
  maxHunks?: number
  maxResultBytes?: number
  allowDeletes?: boolean
  allowRenames?: boolean
}

function cleanPath(value: string): string {
  const cleaned = value.replace(/^[ab]\//, '')
  if (!cleaned || path.isAbsolute(cleaned) || cleaned.split(/[\\/]/).includes('..')) throw new Error(`invalid patch path: ${value}`)
  return cleaned
}

export function parsePatch(source: string): FilePatch[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const files: FilePatch[] = []
  let current: FilePatch | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('--- ')) {
      const oldPath = line.slice(4).split(/\s/, 1)[0] ?? ''
      const next = lines[++index]
      if (!next?.startsWith('+++ ')) throw new Error('patch is missing +++ header')
      const newPath = next.slice(4).split(/\s/, 1)[0] ?? ''
      current = {
        oldPath: oldPath === '/dev/null' ? oldPath : cleanPath(oldPath),
        newPath: newPath === '/dev/null' ? newPath : cleanPath(newPath),
        hunks: [],
      }
      files.push(current)
    } else if (line.startsWith('@@ ')) {
      if (!current) throw new Error('hunk appears before a file header')
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/)
      if (!match?.[1]) throw new Error(`invalid hunk header: ${line}`)
      const hunk: Hunk = { oldStart: Number(match[1]), lines: [] }
      while (index + 1 < lines.length && !lines[index + 1]?.startsWith('@@ ') && !lines[index + 1]?.startsWith('--- ')) {
        const body = lines[++index] ?? ''
        if (!body && index === lines.length - 1) break
        if (body.startsWith('\\ No newline')) {
          if (hunk.lines.at(-1)?.[0] !== '-') hunk.noNewlineAtEnd = true
          continue
        }
        if (![' ', '+', '-'].includes(body[0] ?? '')) throw new Error(`invalid hunk line: ${body}`)
        hunk.lines.push(body)
      }
      current.hunks.push(hunk)
    }
  }
  if (!files.length || files.some(file => !file.hunks.length)) throw new Error('patch contains no applicable hunks')
  const targets = files.map(file => file.newPath === '/dev/null' ? file.oldPath : file.newPath)
  if (new Set(targets).size !== targets.length) throw new Error('patch contains duplicate targets')
  return files
}

export function applyFilePatch(original: string, patch: FilePatch): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const source = original.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let cursor = 0
  for (const hunk of patch.hunks) {
    const start = Math.max(0, hunk.oldStart - 1)
    if (start < cursor) throw new Error(`overlapping hunks for ${patch.newPath}`)
    output.push(...source.slice(cursor, start))
    cursor = start
    for (const line of hunk.lines) {
      const marker = line[0]
      const value = line.slice(1)
      if (marker === ' ' || marker === '-') {
        if (source[cursor] !== value) throw new Error(`patch context mismatch in ${patch.newPath} at line ${cursor + 1}`)
        if (marker === ' ') output.push(value)
        cursor += 1
      } else if (marker === '+') output.push(value)
    }
  }
  output.push(...source.slice(cursor))
  const result = output.join(eol)
  return patch.hunks.at(-1)?.noNewlineAtEnd && result.endsWith(eol) ? result.slice(0, -eol.length) : result
}

function patchValue(input: JsonObject): string {
  const value = input.patch
  if (typeof value !== 'string' || !value) throw new TypeError('patch must be a non-empty string')
  return value
}

export const name = 'patch-tool'
export const inject = ['tools', 'workspace']

async function pathExists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export function apply(ctx: Context, config: PatchToolConfig = {}): void {
  ctx.tools.register({
    name: 'apply_patch', description: 'Apply an exact-context unified diff inside the workspace.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['patch'], properties: { patch: { type: 'string' } } },
    permission(input) {
      assertRecord(input, 'tool input')
      const targets = parsePatch(patchValue(input)).map(file => file.newPath === '/dev/null' ? file.oldPath : file.newPath)
      return { capability: 'fs.write', risk: 'write', description: 'Write files in the configured workspace folders',
        metadata: { paths: targets },
        remember: [{ key: 'workspace.write', label: 'write configured workspace folders' }] }
    },
    async execute(input, execution) {
      assertRecord(input, 'tool input')
      const value = patchValue(input)
      if (Buffer.byteLength(value) > (config.maxPatchBytes ?? 2_000_000)) throw new Error('patch exceeds its byte limit')
      const patches = parsePatch(value)
      if (patches.length > (config.maxFiles ?? 100)) throw new Error('patch exceeds its file limit')
      const hunks = patches.reduce((total, patch) => total + patch.hunks.length, 0)
      if (hunks > (config.maxHunks ?? 1_000)) throw new Error('patch exceeds its hunk limit')
      const staged: Array<{
        target: string; temporary?: string; backup: string; sourceBackup?: string; renamedFrom?: string
        displayPath: string; bytes: number; delete: boolean; existed: boolean
      }> = []
      try {
        for (const patch of patches) {
          const deleting = patch.newPath === '/dev/null'
          const renaming = !deleting && patch.oldPath !== '/dev/null' && patch.oldPath !== patch.newPath
          if (deleting && !config.allowDeletes) throw new Error('file deletion is disabled')
          if (renaming && !config.allowRenames) throw new Error('file rename is disabled')
          const targetPath = deleting ? patch.oldPath : patch.newPath
          const target = await ctx.workspace.resolveWrite(targetPath, execution)
          let original = ''
          let mode: number | undefined
          let source: string | undefined
          if (patch.oldPath !== '/dev/null') {
            source = await ctx.workspace.resolveRead(patch.oldPath, execution)
            const buffer = await readFile(source)
            if (buffer.includes(0)) throw new Error(`binary patch target is not supported: ${patch.oldPath}`)
            original = buffer.toString('utf8')
            mode = (await stat(source)).mode
          }
          const result = applyFilePatch(original, patch)
          const bytes = Buffer.byteLength(result)
          if (bytes > (config.maxResultBytes ?? 5_000_000)) throw new Error(`patched file exceeds its byte limit: ${targetPath}`)
          const existed = await pathExists(target)
          if (renaming && existed) throw new Error(`rename target already exists: ${targetPath}`)
          await mkdir(path.dirname(target), { recursive: true })
          const suffix = `${process.pid}.${Date.now()}.${staged.length}`
          const temporary = deleting ? undefined : `${target}.${suffix}.tmp`
          if (temporary) await writeFile(temporary, result, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
          staged.push({
            target, ...(temporary ? { temporary } : {}), backup: `${target}.${suffix}.bak`, bytes,
            displayPath: targetPath,
            delete: deleting, existed,
            ...(renaming && source ? { renamedFrom: source, sourceBackup: `${source}.${suffix}.bak` } : {}),
          })
        }
      } catch (error) {
        await Promise.all(staged.flatMap(file => file.temporary ? [unlink(file.temporary).catch(() => undefined)] : []))
        throw error
      }
      const committed: typeof staged = []
      try {
        for (const file of staged) {
          if (file.renamedFrom && file.sourceBackup) await rename(file.renamedFrom, file.sourceBackup)
          else if (file.existed) await rename(file.target, file.backup)
          if (file.temporary) await rename(file.temporary, file.target)
          committed.push(file)
        }
      } catch (error) {
        for (const file of [...committed, staged[committed.length]].filter((item): item is typeof staged[number] => Boolean(item)).reverse()) {
          if (await pathExists(file.target)) await unlink(file.target).catch(() => undefined)
          if (file.renamedFrom && file.sourceBackup && await pathExists(file.sourceBackup)) {
            await rename(file.sourceBackup, file.renamedFrom).catch(() => undefined)
          } else if (await pathExists(file.backup)) await rename(file.backup, file.target).catch(() => undefined)
        }
        await Promise.all(staged.flatMap(file => file.temporary ? [unlink(file.temporary).catch(() => undefined)] : []))
        throw error
      }
      await Promise.all(staged.filter(file => file.existed).map(file => unlink(file.backup)))
      await Promise.all(staged.flatMap(file => file.sourceBackup ? [unlink(file.sourceBackup)] : []))
      execution.present?.({
        type: 'diff',
        data: {
          diff: value,
          files: staged.map(file => file.displayPath),
        },
      })
      return {
        files: staged.map(file => ({ path: file.displayPath, bytes: file.bytes, deleted: file.delete })),
        hunks,
        changedLines: patches.reduce((total, patch) => total + patch.hunks.flatMap(hunk => hunk.lines).filter(line => line[0] === '+' || line[0] === '-').length, 0),
      }
    },
  })
}

export default { name, inject, apply }
