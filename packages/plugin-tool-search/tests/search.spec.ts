import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ToolService, WorkspaceService } from '@flect/sdk'
import workspace from '../../plugin-workspace-local/src/index.js'
import search from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

describe('search tools', () => {
  it('finds bounded Unicode/CRLF matches and skips ignored/binary files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-search-'))
    directories.push(root)
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, 'src', 'a.ts'), 'héllo hello\r\nhello\n', 'utf8')
    await writeFile(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(root, '.git', 'ignored.ts'), 'hello', 'utf8')
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(ToolService), ctx.plugin(WorkspaceService)])
    const workspacePlugin = await ctx.plugin(workspace)
    const searchPlugin = await ctx.plugin(search, { maxResults: 10 })

    const found = await ctx.tools.get('find_files')?.execute({ pattern: '**/*.ts' }, { cwd: root }) as { files: string[] }
    expect(found.files).toEqual(['src/a.ts'])
    const result = await ctx.tools.get('search_text')?.execute({ query: 'hello', pattern: '**/*' }, { cwd: root }) as { matches: Array<{ line: number; column: number }> }
    expect(result.matches).toMatchObject([{ line: 1, column: 7 }, { line: 2, column: 1 }])
    await expect(ctx.tools.get('search_text')?.execute({ query: '(a+)+$', regex: true }, { cwd: root })).rejects.toThrow('unsafe nested repetition')

    await searchPlugin.dispose(); await workspacePlugin.dispose(); await Promise.all(services.map(service => service.dispose()))
  })
})
