import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  TuiService,
  type Theme,
  type TuiActions,
  type TuiKeyEvent,
  type TuiRenderContext,
  type TuiState,
} from '@flect/sdk'
import sidebar from '../src/index.js'
import changes from '../../plugin-sidebar-changes/src/index.js'
import contextSection, { cacheHitPercentage } from '../../plugin-sidebar-context/src/index.js'
import verification from '../../plugin-sidebar-verification/src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000', foreground: '#fff', muted: '#888', accent: '#0af', success: '#0f0', warning: '#ff0', danger: '#f00' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function state(): TuiState {
  return {
    cwd: '.', width: 130, height: 30, provider: 'deepseek', model: 'flash', models: ['flash', 'pro'],
    theme: 'test', contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: Date.now(),
  }
}

function render(value: TuiState): TuiRenderContext {
  return {
    state: value, theme, width: 34, height: 24, color: false,
    style: text => text, fit: text => text, wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

function actions(value: TuiState, reveal: (index: number) => void = () => {}): TuiActions {
  return {
    state: value, setInput() {}, async submit() {}, exit() {}, clear() {}, cancel: () => false,
    cycleModel() {}, setModel() {}, notify() {}, showOverlay() {}, closeOverlay() {},
    moveSlashSelection() {}, acceptSlashSuggestion: () => false, scrollViewport() {}, pageViewport() {},
    followViewport() {}, toggleReasoning() {}, revealEvent: reveal, selectPermissionCandidate() {}, answerPermission() {},
    async newConversation() {}, async openConversation() {}, async forkConversation() {}, async renameConversation() {},
  }
}

describe('composable sidebar plugins', () => {
  it('composes structured sections, switches compact layouts, and supports keyboard activation', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const compositor = await ctx.plugin(sidebar)
    let activated = 0
    const section = await ctx.plugin({ name: 'test-sidebar-section', inject: ['tui'], apply(inner) {
      inner.tui.registerSidebarSection({
        id: 'test.section', title: 'Useful', order: 1,
        render: () => ({
          rows: [{ id: 'full', text: 'full detail', activate: () => { activated += 1 } }],
          compactRows: [{ id: 'compact', text: 'compact detail', activate: () => { activated += 1 } }],
        }),
      })
    } })
    const value = state()
    const component = ctx.tui.component('sidebar')
    expect(component?.render(render(value)).join('\n')).toContain('full detail')
    const override = await ctx.plugin({ name: 'override-sidebar-section', inject: ['tui'], apply(inner) {
      inner.tui.registerSidebarSection({
        id: 'test.section', title: 'Override', order: 1, priority: 100,
        render: () => ({ rows: [{ text: 'overridden' }] }),
      })
    } })
    expect(component?.render(render(value)).join('\n')).toContain('overridden')
    await override.dispose()
    expect(component?.render(render(value)).join('\n')).toContain('full detail')
    value.width = 100
    expect(component?.render(render(value)).join('\n')).toContain('compact detail')
    value.width = 90
    expect(component?.render(render(value))).toEqual([])
    value.width = 100

    const key = async (name: string, mouse?: TuiKeyEvent['mouse']) => {
      const event: TuiKeyEvent = { name, sequence: '', ...(mouse ? { mouse } : {}) }
      for (const binding of ctx.tui.bindings(event)) {
        if (await binding.handle(event, actions(value))) break
      }
    }
    await key('ctrl+b')
    expect(component?.render(render(value))).toEqual([])
    await key('ctrl+b')
    component?.render(render(value))
    await key('enter')
    expect(activated).toBe(1)
    await key('escape')

    value.width = 130
    expect(component?.preferredWidth?.(value)).toBe(34)
    await key('mouse-left', { button: 'left', x: 96, y: 5 })
    await key('mouse-drag', { button: 'left-drag', x: 80, y: 5 })
    expect(component?.preferredWidth?.(value)).toBe(50)
    await key('mouse-release', { button: 'left-release', x: 80, y: 5 })
    await ctx.tui.executeSlash('/sidebar reset', actions(value))
    expect(component?.preferredWidth?.(value)).toBe(34)
    await key('mouse-left', { button: 'left', x: 96, y: 5 })
    await key('mouse-drag', { button: 'left-drag', x: 1, y: 5 })
    expect(component?.preferredWidth?.(value)).toBe(60)
    await key('mouse-release', { button: 'left-release', x: 1, y: 5 })
    await ctx.tui.executeSlash('/sidebar reset', actions(value))
    await key('mouse-left', { button: 'left', x: 96, y: 5 })
    await key('mouse-drag', { button: 'left-drag', x: 125, y: 5 })
    expect(component?.preferredWidth?.(value)).toBe(22)
    await key('mouse-release', { button: 'left-release', x: 125, y: 5 })
    await ctx.tui.executeSlash('/sidebar reset', actions(value))

    await section.dispose()
    expect(component?.render(render(value))).toEqual([])
    await compositor.dispose()
    await service.dispose()
  })

  it('summarizes diff and verification events and jumps to their transcript entries', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const changePlugin = await ctx.plugin(changes)
    const verificationPlugin = await ctx.plugin(verification)
    const contextPlugin = await ctx.plugin(contextSection)
    const value = state()
    value.usage = { contextTokens: 750, inputTokens: 900, outputTokens: 50, cachedInputTokens: 600, calculatedCostUsd: 0.001234 }
    value.latestUsage = { inputTokens: 100, cachedInputTokens: 80, uncachedInputTokens: 20 }
    value.cachePrefix = {
      status: 'stable', stableMessages: 12, totalMessages: 13, envelopeFingerprint: 'abc',
    }
    value.events = [
      { type: 'tool-result', call: { id: 'edit', name: 'apply_patch', arguments: {} }, output: 'ok', presentation: {
        type: 'diff', data: { diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+more' },
      } },
      { type: 'tool-call', call: { id: 'test', name: 'run_command', arguments: { argv: ['pnpm', 'test'] } } },
      { type: 'tool-result', call: { id: 'test', name: 'run_command', arguments: {} }, output: { code: 0, timedOut: false } },
    ]
    const sections = Object.fromEntries(ctx.tui.listSidebarSections().map(section => [section.id, section]))
    const changed = sections['flect.sidebar.changes']?.render(render(value))
    const checked = sections['flect.sidebar.verification']?.render(render(value))
    const usage = sections['flect.sidebar.context']?.render(render(value))
    expect(changed?.rows[0]?.text).toContain('src/a.ts +2 -1')
    expect(checked?.rows[0]?.text).toContain('✓ pnpm test')
    expect(usage?.rows.map(row => row.text).join('\n')).toContain('cost $0.001234')
    expect(usage?.rows.map(row => row.text).join('\n')).toContain('last cache 80.0% · 80/100')
    expect(usage?.rows.map(row => row.text).join('\n')).toContain('session cache 66.7% · 600/900')
    expect(usage?.compactRows?.map(row => row.text)).toContain('last cache 80.0%')
    expect(usage?.compactRows?.map(row => row.text)).toContain('prefix stable · 12 msgs')
    expect(cacheHitPercentage({ inputTokens: 0, cachedInputTokens: 0 })).toBeUndefined()
    expect(cacheHitPercentage({ inputTokens: 10, cachedInputTokens: 20 })).toBe(100)

    const revealed: number[] = []
    await changed?.rows[0]?.activate?.(actions(value, index => revealed.push(index)))
    await checked?.rows[0]?.activate?.(actions(value, index => revealed.push(index)))
    expect(revealed).toEqual([0, 2])

    await contextPlugin.dispose()
    await verificationPlugin.dispose()
    await changePlugin.dispose()
    await service.dispose()
  })
})
