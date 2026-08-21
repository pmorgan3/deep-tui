import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import runtime from '../../runtime/src/index.js'
import { ProjectService } from '@deep-tui/sdk'
import permissionRules from '../src/index.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function composition(root: string, config: Parameters<typeof permissionRules.apply>[1] = {}) {
  const ctx = new Context()
  const project = await ctx.plugin(ProjectService, { root })
  const services = await ctx.plugin(runtime)
  const rules = await ctx.plugin(permissionRules, config)
  return { ctx, close: async () => { await rules.dispose(); await services.dispose(); await project.dispose() } }
}

describe('remembered permissions', () => {
  it('allows workspace reads by default without creating a remembered rule', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-permissions-read-'))
    temporaryDirectories.push(root)
    const automatic = await composition(root)
    await expect(automatic.ctx.permissions.authorize({
      capability: 'fs.read', risk: 'read', description: 'Read files in this workspace',
      remember: [{ key: 'workspace.read', label: 'read files in this workspace' }],
    }, { cwd: root })).resolves.toMatchObject({ decision: 'allow', policyId: 'deep-tui.permission.rules' })
    expect(automatic.ctx.permissionRules.list()).toEqual([])
    await automatic.close()

    const guarded = await composition(root, { allowRead: false })
    await expect(guarded.ctx.permissions.authorize({
      capability: 'fs.read', risk: 'read', description: 'Read files in this workspace',
      remember: [{ key: 'workspace.read', label: 'read files in this workspace' }],
    }, { cwd: root })).rejects.toThrow('permission denied')
    await guarded.close()
  })

  it('persists project grants, isolates projects, and revokes immediately', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-permissions-'))
    const other = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-permissions-other-'))
    temporaryDirectories.push(root, other)
    const first = await composition(root)
    const rule = first.ctx.permissionRules.add({ key: 'process.exec:git:status', label: 'git status', scope: 'project', projectRoot: root })
    await first.ctx.permissionRules.persist()
    await first.close()

    const stored = await readFile(path.join(root, '.deep-tui', 'permissions.json'), 'utf8')
    expect(stored).toContain('process.exec:git:status')
    expect(stored).not.toContain(root)

    const resumed = await composition(root)
    await expect(resumed.ctx.permissions.authorize({
      capability: 'process.exec', risk: 'execute', description: 'git status',
      remember: [{ key: 'process.exec:git:status', label: 'git status' }],
    }, { cwd: root })).resolves.toMatchObject({ decision: 'allow', ruleId: rule.id })
    resumed.ctx.permissionRules.remove(rule.id)
    await resumed.ctx.permissionRules.persist()
    await expect(resumed.ctx.permissions.authorize({
      capability: 'process.exec', risk: 'execute', description: 'git status',
      remember: [{ key: 'process.exec:git:status', label: 'git status' }],
    }, { cwd: root })).rejects.toThrow('permission denied')
    await resumed.close()

    const isolated = await composition(other)
    await expect(isolated.ctx.permissions.authorize({
      capability: 'process.exec', risk: 'execute', description: 'git status',
      remember: [{ key: 'process.exec:git:status', label: 'git status' }],
    }, { cwd: other })).rejects.toThrow('permission denied')
    await isolated.close()
  })

  it('fails closed on corrupt persistent state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-permissions-corrupt-'))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, '.deep-tui'), { recursive: true })
    await writeFile(path.join(root, '.deep-tui', 'permissions.json'), '{not json', 'utf8')
    const ctx = new Context()
    const project = await ctx.plugin(ProjectService, { root })
    const services = await ctx.plugin(runtime)
    await expect(ctx.plugin(permissionRules)).rejects.toThrow('could not load permission rules')
    await services.dispose()
    await project.dispose()
  })
})
