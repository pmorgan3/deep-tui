import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentLifecycleService, TuiService, type TuiActions, type TuiState } from '@flect/sdk'
import budgetPlugin from '../src/index.js'

function runContext(runId = 'run-1') {
  return { runId, input: 'work', cwd: '.', provider: 'fake', model: 'm' }
}

describe('run budget', () => {
  it('stops before the next step after step and reported-usage limits', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(AgentLifecycleService), ctx.plugin(TuiService)])
    const plugin = await ctx.plugin(budgetPlugin, { maxSteps: 2, maxTotalTokens: 100, maxDurationMs: 60_000 })
    try {
      const run = runContext()
      await ctx.agentHooks.start(run)
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 1, usage: {} })).toBeUndefined()
      await ctx.agentHooks.afterModel({ ...run, step: 1, responseUsage: { inputTokens: 60, outputTokens: 10 }, usage: { inputTokens: 60, outputTokens: 10 } })
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 2, usage: { inputTokens: 60, outputTokens: 10 } })).toBeUndefined()
      await ctx.agentHooks.afterModel({ ...run, step: 2, responseUsage: { inputTokens: 20, outputTokens: 10 }, usage: { inputTokens: 80, outputTokens: 20 } })
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 3, usage: { inputTokens: 80, outputTokens: 20 } }))
        .toBe('model-step budget reached (2)')
      await ctx.agentHooks.finish({ ...run, steps: 2, status: 'limit-reached', usage: { inputTokens: 80, outputTokens: 20 } })
    } finally {
      await plugin.dispose(); await Promise.all(services.map(service => service.dispose()))
    }
  })

  it('supports a session-only off switch through /budget', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(AgentLifecycleService), ctx.plugin(TuiService)])
    const plugin = await ctx.plugin(budgetPlugin, { maxSteps: 1 })
    const state = {
      cwd: '.', width: 80, height: 24, provider: 'fake', model: 'm', models: ['m'], theme: 'default',
      contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
      viewports: {}, busy: false, status: 'ready', events: [], startedAt: 0,
    } as TuiState
    const notices: string[] = []
    const actions = { state, notify: (message: string) => notices.push(message) } as TuiActions
    try {
      await ctx.tui.executeSlash('/budget off', actions)
      const run = runContext('run-2')
      await ctx.agentHooks.start(run)
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 100, usage: {} })).toBeUndefined()
      await ctx.agentHooks.finish({ ...run, steps: 0, status: 'complete', usage: {} })
      expect(notices).toEqual(['run budget off'])
    } finally {
      await plugin.dispose(); await Promise.all(services.map(service => service.dispose()))
    }
  })
})
