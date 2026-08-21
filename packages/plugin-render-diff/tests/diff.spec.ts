import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createUnifiedDiff, TuiService, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import diffRenderer, { renderUnifiedDiff } from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function context(): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width: 100, height: 24, provider: 'test', model: 'm', models: ['m'], theme: 'test',
    contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
  return {
    state, theme, width: 100, height: 24, color: false,
    style: text => text, fit: text => text, wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

describe('inline diff renderer', () => {
  it('renders compact calls and successful changes while preserving fallback events', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(diffRenderer)
    const render = context()
    const diff = createUnifiedDiff('src/a.ts', 'one\ntwo\nthree\n', 'one\nchanged\nthree\n')

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'secret' } },
    }, render)).toEqual(['  ↳ editing src/a.ts'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'write_file', arguments: {} }, output: { path: 'src/a.ts' },
      presentation: { type: 'diff', data: { diff, files: ['src/a.ts'] } },
    }, render)).toEqual([
      '  ┌ changed src/a.ts +1 -1',
      '  │ --- a/src/a.ts',
      '  │ +++ b/src/a.ts',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ +changed',
      '  │  three',
      '  └ ✓ write_file',
    ])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '2', name: 'run_command', arguments: {} }, output: 'ok',
    }, render)).toEqual(['fallback result'])
    expect(renderUnifiedDiff(`${diff}extra\n`, render, { maxLines: 2 }).at(-1)).toContain('diff lines omitted')

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })
})
