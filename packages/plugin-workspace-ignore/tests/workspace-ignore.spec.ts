import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { WorkspaceService } from '@flect/sdk'
import localWorkspace from '../../plugin-workspace-local/src/index.js'
import ignorePlugin, { parseIgnoreFile } from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function paths(ctx: Context, cwd: string): Promise<string[]> {
  const output: string[] = []
  for await (const entry of ctx.workspace.walk({ maxEntries: 100 }, { cwd })) output.push(entry.path)
  return output
}

describe('workspace ignore', () => {
  it('parses anchored, recursive, directory, and negated rules', () => {
    const rules = parseIgnoreFile('/root.txt\n*.log\nbuild/\n!important.log\n\\!literal\n', 'src')
    const ignored = (candidate: string) => {
      let result = false
      for (const rule of rules) if (rule.expression.test(candidate)) result = !rule.negated
      return result
    }
    expect(ignored('src/root.txt')).toBe(true)
    expect(ignored('src/nested/root.txt')).toBe(false)
    expect(ignored('src/nested/debug.log')).toBe(true)
    expect(ignored('src/build/output.js')).toBe(true)
    expect(ignored('src/important.log')).toBe(false)
    expect(ignored('src/!literal')).toBe(true)
  })

  it('combines root, nested, ignore, and git-info rules without changing path resolution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-ignore-'))
    directories.push(root)
    await mkdir(path.join(root, 'src', 'generated'), { recursive: true })
    await mkdir(path.join(root, 'build'), { recursive: true })
    await mkdir(path.join(root, '.git', 'info'), { recursive: true })
    await writeFile(path.join(root, '.gitignore'), '*.log\nbuild/\n!important.log\n', 'utf8')
    await writeFile(path.join(root, '.ignore'), 'scratch.txt\n', 'utf8')
    await writeFile(path.join(root, '.git', 'info', 'exclude'), 'local.env\n', 'utf8')
    await writeFile(path.join(root, 'src', '.gitignore'), 'generated/*\n!generated/keep.ts\n', 'utf8')
    for (const file of [
      'debug.log', 'important.log', 'scratch.txt', 'local.env', 'visible.ts',
      'build/out.js', 'src/generated/drop.ts', 'src/generated/keep.ts',
    ]) await writeFile(path.join(root, file), file, 'utf8')

    const ctx = new Context()
    const service = await ctx.plugin(WorkspaceService)
    const local = await ctx.plugin(localWorkspace)
    const plugin = await ctx.plugin(ignorePlugin)
    try {
      const visible = await paths(ctx, root)
      expect(visible).toContain('visible.ts')
      expect(visible).toContain('important.log')
      expect(visible).toContain('src/generated/keep.ts')
      expect(visible).not.toContain('debug.log')
      expect(visible).not.toContain('scratch.txt')
      expect(visible).not.toContain('local.env')
      expect(visible).not.toContain('build')
      expect(visible).not.toContain('src/generated/drop.ts')
      expect(await ctx.workspace.resolveRead('debug.log', { cwd: root })).toBe(path.join(root, 'debug.log'))
    } finally {
      await plugin.dispose(); await local.dispose(); await service.dispose()
    }
  })
})
