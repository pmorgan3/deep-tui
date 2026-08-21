import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { PermissionService, TuiService, type TuiActions } from '@deep-tui/sdk'
import autoPermission from '../src/index.js'

const request = (risk: 'read' | 'write' | 'execute' | 'network') => ({
  capability: `test.${risk}`,
  risk,
  description: `${risk} test`,
})

describe('auto permission mode', () => {
  it('starts off, toggles through /auto, excludes network, and does not persist a rule', async () => {
    const ctx = new Context()
    const permissions = await ctx.plugin(PermissionService)
    const tui = await ctx.plugin(TuiService)
    const plugin = await ctx.plugin(autoPermission)
    const notices: string[] = []
    const overlays: string[] = []
    const actions = {
      notify(message: string) { notices.push(message) },
      showOverlay(overlay: { title: string }) { overlays.push(overlay.title) },
    } as unknown as TuiActions

    await expect(ctx.permissions.authorize(request('write'))).rejects.toThrow('permission denied')
    expect(await ctx.tui.executeSlash('/auto on', actions)).toBe(true)
    await expect(ctx.permissions.authorize(request('read'))).resolves.toMatchObject({ decision: 'allow', policyId: 'deep-tui.permission.auto' })
    await expect(ctx.permissions.authorize(request('write'))).resolves.toMatchObject({ decision: 'allow' })
    await expect(ctx.permissions.authorize(request('execute'))).resolves.toMatchObject({ decision: 'allow' })
    await expect(ctx.permissions.authorize(request('network'))).rejects.toThrow('permission denied')
    expect(notices.at(-1)).toContain('auto mode on')

    await ctx.tui.executeSlash('/auto status', actions)
    expect(overlays).toEqual(['Auto mode'])
    await ctx.tui.executeSlash('/auto off', actions)
    await expect(ctx.permissions.authorize(request('execute'))).rejects.toThrow('permission denied')

    await plugin.dispose()
    await tui.dispose()
    await permissions.dispose()
  })
})
