import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ThemeService, TuiService, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import shiki from '../src/index.js'

const makeTheme = (id: string, keyword: string): Theme => ({
  id, label: id, tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#777777', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 }, syntax: { keyword },
  },
})

function render(theme: Theme): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width: 80, height: 24, provider: 'x', model: 'x', models: ['x'], theme: theme.id,
    contextWindow: 1, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: '', events: [], startedAt: 0,
  }
  return { state, theme, width: 80, height: 24, color: true, style: text => text, fit: text => text, wrap: text => [text], renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')) }
}

describe('Shiki contribution', () => {
  it('uses active semantic theme colors and unloads cleanly', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(ThemeService), ctx.plugin(TuiService)])
    const dark = makeTheme('dark', '#ff0000')
    const light = makeTheme('light', '#0000ff')
    const themes = await ctx.plugin({ name: 'themes', inject: ['themes'], apply(inner) { inner.themes.register(dark); inner.themes.register(light) } })
    const plugin = await ctx.plugin(shiki, { languages: ['typescript'] })
    const colors = (theme: Theme) => ctx.tui.highlightCode('const value = 1', 'typescript', render(theme))
      ?.flatMap(line => line.spans.map(span => span.style?.foreground?.toLowerCase())).filter(Boolean)
    expect(colors(dark)).toContain('#ff0000')
    expect(colors(light)).toContain('#0000ff')
    const first = ctx.tui.highlightCode('const cached = true', 'typescript', render(dark))
    expect(ctx.tui.highlightCode('const cached = true', 'typescript', render(dark))).toBe(first)
    expect(ctx.tui.highlightCode('const skipped = true', 'typescript', { ...render(dark), phase: 'measure' }))
      .toEqual([{ spans: [{ text: 'const skipped = true' }] }])
    await plugin.dispose()
    expect(ctx.tui.highlightCode('const value = 1', 'typescript', render(dark))).toBeUndefined()
    await themes.dispose(); await Promise.all(services.map(service => service.dispose()))
  })
})
