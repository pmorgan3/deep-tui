import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ToolService, WorkspaceService } from '@flect/sdk'
import localWorkspace from '../../plugin-workspace-local/src/index.js'
import gitPlugin, { parsePorcelainStatus } from '../src/index.js'

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

describe('git tools', () => {
  it('parses branch tracking and rename records', () => {
    expect(parsePorcelainStatus('## main...origin/main [ahead 2, behind 1]\0R  new name.ts\0old name.ts\0?? loose.txt\0')).toEqual({
      branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, clean: false,
      entries: [
        { path: 'new name.ts', originalPath: 'old name.ts', index: 'R', worktree: ' ' },
        { path: 'loose.txt', index: '?', worktree: '?' },
      ],
    })
  })

  it('returns bounded structured status, diff, log, and show output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-git-'))
    directories.push(root)
    await execute('git', ['init', '-q', root])
    await writeFile(path.join(root, 'tracked.txt'), 'one\n', 'utf8')
    await execute('git', ['-C', root, 'add', 'tracked.txt'])
    await execute('git', ['-C', root, '-c', 'user.name=Flect Test', '-c', 'user.email=flect@example.test', 'commit', '-q', '-m', 'initial'])
    await writeFile(path.join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8')
    await writeFile(path.join(root, 'untracked.txt'), 'loose\n', 'utf8')

    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(ToolService), ctx.plugin(WorkspaceService)])
    const workspace = await ctx.plugin(localWorkspace)
    const plugin = await ctx.plugin(gitPlugin)
    try {
      const executionContext = { cwd: root }
      const status = await ctx.tools.get('git_status')?.execute({}, executionContext) as { clean: boolean; entries: Array<{ path: string }> }
      expect(status.clean).toBe(false)
      expect(status.entries.map(entry => entry.path)).toEqual(expect.arrayContaining(['tracked.txt', 'untracked.txt']))
      expect(ctx.tools.get('git_status')?.permission?.({})).toMatchObject({ capability: 'fs.read', risk: 'read' })

      const presented: unknown[] = []
      const diff = await ctx.tools.get('git_diff')?.execute({ paths: ['tracked.txt'] }, {
        cwd: root, present(value) { presented.push(value) },
      }) as { diff: string; truncated: boolean }
      expect(diff.diff).toContain('+two')
      expect(diff.truncated).toBe(false)
      expect(presented).toMatchObject([{ type: 'diff' }])

      const log = await ctx.tools.get('git_log')?.execute({ maxCount: 1 }, executionContext) as { commits: Array<{ subject: string }> }
      expect(log.commits).toMatchObject([{ subject: 'initial' }])
      const shown = await ctx.tools.get('git_show')?.execute({ ref: 'HEAD', path: 'tracked.txt' }, executionContext) as { content: string }
      expect(shown.content).toContain('initial')
      await expect(ctx.tools.get('git_show')?.execute({ ref: '--help' }, executionContext)).rejects.toThrow('cannot begin with a dash')
    } finally {
      await plugin.dispose(); await workspace.dispose(); await Promise.all(services.map(service => service.dispose()))
    }
  })
})
