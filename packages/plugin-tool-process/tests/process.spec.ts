import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ToolService, WorkspaceService } from '@flect/sdk'
import workspace from '../../plugin-workspace-local/src/index.js'
import processPlugin from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

describe('run_command tool', () => {
  it('preserves argv without a shell, bounds output, and passes safe env overrides', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-process-'))
    directories.push(root)
    const { ctx, close } = await composition({ maxOutputBytes: 20 })
    const result = await ctx.tools.get('run_command')?.execute({
      argv: ['/bin/sh', '-c', 'printf "%s|%s" "$1" "$FLECT_TEST"; printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" >&2', 'flect-test', 'a;echo unsafe'],
      env: { FLECT_TEST: 'works' },
    }, { cwd: root }) as { code: number; stdout: string; stderrTruncated: boolean; elapsedMs: number }
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('a;echo unsafe')
    expect(result.stderrTruncated).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    await expect(ctx.tools.get('run_command')?.execute({ argv: [process.execPath, '-e', '0'], env: { API_KEY: 'nope' } }, { cwd: root })).rejects.toThrow('not allowed')
    await close()
  })

  it('force-stops commands that ignore the timeout signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'flect-process-timeout-'))
    directories.push(root)
    const { ctx, close } = await composition({ timeoutMs: 30, killGraceMs: 20 })
    const result = await ctx.tools.get('run_command')?.execute({
      argv: [process.execPath, '-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
    }, { cwd: root }) as { timedOut: boolean; signal: string }
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    await close()
  })
})

async function composition(config: Parameters<typeof processPlugin.apply>[1]) {
  const ctx = new Context()
  const services = await Promise.all([ctx.plugin(ToolService), ctx.plugin(WorkspaceService)])
  const workspacePlugin = await ctx.plugin(workspace)
  const plugin = await ctx.plugin(processPlugin, config)
  return { ctx, close: async () => { await plugin.dispose(); await workspacePlugin.dispose(); await Promise.all(services.map(service => service.dispose())) } }
}
