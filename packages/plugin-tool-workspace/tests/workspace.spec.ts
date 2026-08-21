import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolService, WorkspaceService, type ToolPresentation } from '@deep-tui/sdk'
import localWorkspace from '../../plugin-workspace-local/src/index.js'
import workspaceTools from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('workspace tools', () => {
  it('writes inside the workspace and rejects traversal', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-workspace-'))
    temporaryDirectories.push(cwd)
    await mkdir(path.join(cwd, 'src'))

    const ctx = new Context()
    const toolsService = await ctx.plugin(ToolService)
    const workspaceService = await ctx.plugin(WorkspaceService)
    const localPlugin = await ctx.plugin(localWorkspace)
    const toolsPlugin = await ctx.plugin(workspaceTools)
    const write = ctx.tools.get('write_file')
    const read = ctx.tools.get('read_file')
    expect(write).toBeDefined()
    expect(read).toBeDefined()
    expect(read?.permission?.({ path: 'src/empty.txt' })).toMatchObject({
      capability: 'fs.read', description: 'Read files in the configured workspace folders',
      remember: [{ key: 'workspace.read', label: 'read configured workspace folders' }],
    })
    expect(write?.permission?.({ path: 'src/empty.txt', content: '' })).toMatchObject({
      capability: 'fs.write', description: 'Write files in the configured workspace folders',
      remember: [{ key: 'workspace.write', label: 'write configured workspace folders' }],
    })

    let presentation: ToolPresentation | undefined
    await write?.execute({ path: 'src/empty.txt', content: '' }, { cwd, present: value => { presentation = value } })
    expect(await readFile(path.join(cwd, 'src/empty.txt'), 'utf8')).toBe('')
    expect(presentation).toMatchObject({ type: 'diff', data: { files: ['src/empty.txt'] } })
    presentation = undefined
    expect(await read?.execute({ path: 'src/empty.txt' }, { cwd, present: value => { presentation = value } })).toBe('')
    expect(presentation).toMatchObject({ type: 'read-file', data: { path: 'src/empty.txt' } })
    presentation = undefined
    await write?.execute({ path: 'src/empty.txt', content: 'new\n' }, { cwd, present: value => { presentation = value } })
    expect(presentation?.data.diff).toContain('+new')
    await expect(read?.execute({ path: '../outside.txt' }, { cwd })).rejects.toThrow('escapes workspace')

    await toolsPlugin.dispose()
    await localPlugin.dispose()
    await workspaceService.dispose()
    await toolsService.dispose()
  })
})
