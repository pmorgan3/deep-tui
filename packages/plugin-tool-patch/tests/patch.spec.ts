import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ToolService, WorkspaceService, type ToolPresentation } from '@flect/sdk'
import workspace from '../../plugin-workspace-local/src/index.js'
import patchPlugin from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

describe('apply_patch tool', () => {
  it('creates and modifies exact-context files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-patch-'))
    directories.push(root)
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'a.txt'), 'old\n', 'utf8')
    const { ctx, close } = await composition()
    const tool = ctx.tools.get('apply_patch')
    expect(tool?.permission?.({ patch: '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n' })).toMatchObject({
      capability: 'fs.write', description: 'Write files in the configured workspace folders',
      remember: [{ key: 'workspace.write', label: 'write configured workspace folders' }],
    })
    let presentation: ToolPresentation | undefined
    await tool?.execute({ patch: '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n' }, {
      cwd: root, present: value => { presentation = value },
    })
    expect(presentation).toMatchObject({
      type: 'diff', data: { files: ['src/a.txt'] },
    })
    expect(presentation?.data.diff).toContain('-old\n+new')
    await tool?.execute({ patch: '--- /dev/null\n+++ b/src/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n' }, { cwd: root })
    expect(await readFile(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(path.join(root, 'src', 'new.txt'), 'utf8')).toBe('hello\nworld\n')
    await close()
  })

  it('changes nothing when a later file has a context mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-patch-atomic-'))
    directories.push(root)
    await writeFile(path.join(root, 'a.txt'), 'old\n', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'actual\n', 'utf8')
    const { ctx, close } = await composition()
    const source = '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-wrong\n+changed\n'
    await expect(ctx.tools.get('apply_patch')?.execute({ patch: source }, { cwd: root })).rejects.toThrow('context mismatch')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('actual\n')
    await close()
  })

  it('keeps deletion and rename opt-in', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-patch-move-'))
    directories.push(root)
    await writeFile(path.join(root, 'old.txt'), 'old\n', 'utf8')
    const { ctx, close } = await composition({ allowRenames: true })
    const source = '--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n'
    await ctx.tools.get('apply_patch')?.execute({ patch: source }, { cwd: root })
    await expect(readFile(path.join(root, 'old.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new\n')
    await close()
  })

  it('preserves CRLF line endings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-patch-crlf-'))
    directories.push(root)
    await writeFile(path.join(root, 'a.txt'), 'one\r\ntwo\r\n', 'utf8')
    const { ctx, close } = await composition()
    await ctx.tools.get('apply_patch')?.execute({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -2,1 +2,1 @@\n-two\n+changed\n' }, { cwd: root })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\r\nchanged\r\n')
    await close()
  })

  it('preserves an explicit missing newline at EOF', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-patch-eof-'))
    directories.push(root)
    const { ctx, close } = await composition()
    await ctx.tools.get('apply_patch')?.execute({ patch: '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+no newline\n\\ No newline at end of file\n' }, { cwd: root })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('no newline')
    await close()
  })
})

async function composition(config: Parameters<typeof patchPlugin.apply>[1] = {}) {
  const ctx = new Context()
  const services = await Promise.all([ctx.plugin(ToolService), ctx.plugin(WorkspaceService)])
  const workspacePlugin = await ctx.plugin(workspace)
  const plugin = await ctx.plugin(patchPlugin, config)
  return { ctx, close: async () => { await plugin.dispose(); await workspacePlugin.dispose(); await Promise.all(services.map(service => service.dispose())) } }
}
