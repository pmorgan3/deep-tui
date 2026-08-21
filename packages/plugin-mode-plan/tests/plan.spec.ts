import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  PermissionService,
  PromptService,
  TuiService,
  type TuiActions,
  type TuiRenderContext,
} from '@deep-tui/sdk'
import autoPermission from '../../plugin-permission-auto/src/index.js'
import planMode from '../src/index.js'

const request = (risk: 'read' | 'write' | 'execute' | 'network') => ({
  capability: `test.${risk}`,
  risk,
  description: `${risk} test`,
})

describe('plan mode', () => {
  it('adds planning instructions, overrides auto approval, and restores it on exit', async () => {
    const ctx = new Context()
    const permissions = await ctx.plugin(PermissionService)
    const prompts = await ctx.plugin(PromptService)
    const tui = await ctx.plugin(TuiService)
    const auto = await ctx.plugin(autoPermission)
    const plan = await ctx.plugin(planMode)
    const notices: string[] = []
    const overlays: string[] = []
    const actions = {
      notify(message: string) { notices.push(message) },
      showOverlay(overlay: { title: string }) { overlays.push(overlay.title) },
    } as unknown as TuiActions
    const render = { style: (text: string) => text } as TuiRenderContext
    const autoStatus = () => ctx.tui.listStatusItems()
      .find(item => item.id === 'deep-tui.permission.auto.status')?.render(render)
    const planStatus = () => ctx.tui.listStatusItems()
      .find(item => item.id === 'deep-tui.mode.plan.status')?.render(render)

    await ctx.tui.executeSlash('/auto on', actions)
    await expect(ctx.permissions.authorize(request('write'))).resolves.toMatchObject({ decision: 'allow' })
    expect(autoStatus()).toBe('AUTO')
    expect(await ctx.prompts.render({ cwd: '.', model: 'm' })).toContain('PLAN MODE IS OFF')

    expect(await ctx.tui.executeSlash('/plan', actions)).toBe(true)
    expect(await ctx.prompts.render({ cwd: '.', model: 'm' })).toContain('PLAN MODE IS ACTIVE')
    expect((await ctx.prompts.assemble({ cwd: '.', model: 'm' })).system).toBe('')
    expect((await ctx.prompts.assemble({ cwd: '.', model: 'm' })).contexts).toMatchObject([
      { id: 'deep-tui.mode.plan.prompt', text: expect.stringContaining('PLAN MODE IS ACTIVE') },
    ])
    await expect(ctx.permissions.authorize(request('read'))).resolves.toMatchObject({ decision: 'allow' })
    await expect(ctx.permissions.authorize(request('write'))).rejects.toThrow('permission denied')
    await expect(ctx.permissions.authorize(request('execute'))).rejects.toThrow('permission denied')
    await expect(ctx.permissions.authorize(request('network'))).rejects.toThrow('permission denied')
    expect(autoStatus()).toBeUndefined()
    expect(planStatus()).toBe('PLAN')
    expect(notices.at(-1)).toContain('plan mode on')

    await ctx.tui.executeSlash('/plan status', actions)
    expect(overlays).toEqual(['Plan mode'])
    await ctx.tui.executeSlash('/plan off', actions)
    expect(await ctx.prompts.render({ cwd: '.', model: 'm' })).toContain('PLAN MODE IS OFF')
    await expect(ctx.permissions.authorize(request('write'))).resolves.toMatchObject({ decision: 'allow' })
    expect(autoStatus()).toBe('AUTO')
    expect(planStatus()).toBeUndefined()

    await ctx.tui.executeSlash('/plan', actions)
    expect(autoStatus()).toBeUndefined()
    await plan.dispose()
    expect(autoStatus()).toBe('AUTO')
    await auto.dispose()
    await tui.dispose()
    await prompts.dispose()
    await permissions.dispose()
  })
})
