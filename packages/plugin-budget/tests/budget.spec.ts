import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import {
  AgentLifecycleService,
  TuiService,
  type TuiActions,
  type TuiRenderContext,
  type TuiState,
} from '@deep-tui/sdk'
import budgetPlugin, { isDeepSeekPeakHour } from '../src/index.js'

afterEach(() => vi.useRealTimers())

function runContext(runId = 'run-1') {
  return { runId, input: 'work', cwd: '.', provider: 'fake', model: 'm' }
}

describe('run budget', () => {
  it('recognizes the documented DeepSeek UTC peak windows', () => {
    expect(isDeepSeekPeakHour(new Date('2026-08-21T00:59:59Z'))).toBe(false)
    expect(isDeepSeekPeakHour(new Date('2026-08-21T01:00:00Z'))).toBe(true)
    expect(isDeepSeekPeakHour(new Date('2026-08-21T04:00:00Z'))).toBe(false)
    expect(isDeepSeekPeakHour(new Date('2026-08-21T06:00:00Z'))).toBe(true)
    expect(isDeepSeekPeakHour(new Date('2026-08-21T10:00:00Z'))).toBe(false)
  })

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

  it('accounts for a peak-priced DeepSeek response and notes the active tariff', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T02:00:00Z'))
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(AgentLifecycleService), ctx.plugin(TuiService)])
    const plugin = await ctx.plugin(budgetPlugin, { maxCostUsd: 0.0001 })
    const state = {
      cwd: '.', width: 80, height: 24, provider: 'deepseek', model: 'flash', models: ['flash'], theme: 'default',
      contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
      viewports: {}, busy: true, status: 'running', events: [], startedAt: 0,
    } as TuiState
    let lines: readonly string[] = []
    const actions = {
      state,
      notify() {},
      showOverlay(overlay: { lines: readonly string[] }) { lines = overlay.lines },
    } as unknown as TuiActions
    try {
      const run = { ...runContext('run-peak'), provider: 'deepseek', model: 'flash' }
      await ctx.agentHooks.start(run)
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 1, usage: {} })).toBeUndefined()
      const usage = { inputTokens: 100, outputTokens: 10, calculatedCostUsd: 0.00012056 }
      await ctx.agentHooks.afterModel({ ...run, step: 1, responseUsage: usage, usage })
      expect(await ctx.agentHooks.beforeStep({ ...run, step: 2, usage }))
        .toBe('cost budget reached ($0.0001)')

      const render = { state, style: (text: string) => text } as unknown as TuiRenderContext
      expect(ctx.tui.listStatusItems().map(item => item.render(render)))
        .toContain('BUDGET 1/∞ · DEEPSEEK PEAK')
      expect(await ctx.tui.executeSlash('/budget status', actions)).toBe(true)
      expect(lines).toContain('DeepSeek peak pricing active (2× off-peak).')
      await ctx.agentHooks.finish({ ...run, steps: 1, status: 'limit-reached', usage })
    } finally {
      await plugin.dispose(); await Promise.all(services.map(service => service.dispose()))
    }
  })
})
