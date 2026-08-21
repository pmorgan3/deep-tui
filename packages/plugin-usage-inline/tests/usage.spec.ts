import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  TuiService,
  type Theme,
  type TuiRenderContext,
  type TuiState,
} from '@deep-tui/sdk'
import inlineUsage, { formatMessageUsage, formatSessionCost } from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function renderContext(usage: TuiState['usage']): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width: 100, height: 24, provider: 'test', model: 'flash', models: ['flash'], theme: 'test',
    contextWindow: 1_000, usage, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } },
    busy: false, status: 'ready', events: [], startedAt: 0,
  }
  return {
    state, theme, width: 100, height: 24, color: false,
    style: text => text,
    fit: text => text,
    wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

describe('inline usage plugin', () => {
  it('decorates the active assistant renderer and contributes a session footer total', async () => {
    const usage = { inputTokens: 1_234, cachedInputTokens: 1_000, outputTokens: 56, calculatedCostUsd: 0.000034945 }
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const base = await ctx.plugin({ name: 'base-renderer', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({
        id: 'test.assistant',
        render: event => event.type === 'assistant-finish' ? ['rendered Markdown'] : undefined,
      })
    } })
    const plugin = await ctx.plugin(inlineUsage)
    const render = renderContext(usage)

    expect(ctx.tui.renderEvent({ type: 'assistant-finish', messageId: 'a1', text: '# Hello', usage }, render)).toEqual([
      'rendered Markdown',
      '  ↳ cost $0.000035 · tok in 1,234 · out 56 · cache 1,000',
    ])
    expect(ctx.tui.listStatusItems().map(item => item.render(render))).toEqual(['session cost $0.000035'])
    expect(formatMessageUsage(usage)).toContain('tok in 1,234')
    expect(formatSessionCost(usage)).toBe('session cost $0.000035')

    await plugin.dispose()
    expect(ctx.tui.listStatusItems()).toEqual([])
    await base.dispose()
    await tui.dispose()
  })
})
