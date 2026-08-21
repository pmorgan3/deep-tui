import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type Theme, type TuiRenderContext, type TuiState } from '@deep-tui/sdk'
import searchTextRenderer, { parseSearchTextOutput, renderSearchText } from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function context(events: TuiState['events'] = []): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width: 100, height: 24, provider: 'test', model: 'm', models: ['m'], theme: 'test',
    contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events, startedAt: 0,
  }
  return {
    state, theme, width: 100, height: 24, color: false,
    style: text => text,
    fit: text => text,
    wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

const results = {
  matches: [
    { path: 'src/a.ts', line: 2, column: 4, preview: '  const needle = true' },
    { path: 'src/a.ts', line: 10, column: 1, preview: 'needle()' },
    { path: 'src/b.ts', line: 3, column: 8, preview: 'return needle' },
  ],
  truncated: false,
}

describe('parseSearchTextOutput', () => {
  it('parses live and durable search results', () => {
    expect(parseSearchTextOutput(results)).toEqual(results)
    expect(parseSearchTextOutput(JSON.stringify(results))).toEqual(results)
  })

  it('rejects malformed and unrelated output', () => {
    expect(parseSearchTextOutput({ matches: [{ path: 'a', line: 0, column: 1, preview: '' }] })).toBeUndefined()
    expect(parseSearchTextOutput({ matches: 'nope' })).toBeUndefined()
    expect(parseSearchTextOutput({ error: 'failed' })).toBeUndefined()
  })
})

describe('renderSearchText', () => {
  it('groups matches by file and renders line:column previews', () => {
    expect(renderSearchText(results, context(), {}, { query: 'needle', toolName: 'search_text' })).toEqual([
      '  ┌ "needle" · 3 matches · 2 files',
      '  │ src/a.ts · 2 matches',
      '  │    2:4 │ const needle = true',
      '  │   10:1 │ needle()',
      '  │ src/b.ts · 1 match',
      '  │   3:8 │ return needle',
      '  └ ✓ search_text',
    ])
  })

  it('bounds matches and files and reports tool truncation separately', () => {
    expect(renderSearchText({ ...results, truncated: true }, context(), {
      maxMatches: 2, maxFiles: 1,
    }, { query: 'needle', toolName: 'search_text' })).toEqual([
      '  ┌ "needle" · 3 matches · 2 files',
      '  │ src/a.ts · 2 matches',
      '  │    2:4 │ const needle = true',
      '  │   10:1 │ needle()',
      '  │ [1 match omitted]',
      '  │ [additional matches truncated by tool]',
      '  └ ✓ search_text',
    ])
  })

  it('renders empty searches clearly', () => {
    expect(renderSearchText({ matches: [], truncated: false }, context(), {}, {
      query: 'missing', toolName: 'search_text',
    })).toEqual([
      '  ┌ "missing" · 0 matches · 0 files',
      '  │ (no matches)',
      '  └ ✓ search_text',
    ])
  })
})

describe('search-text renderer plugin', () => {
  it('wins the search_text event layer and defers unrelated or malformed output', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(searchTextRenderer)
    const render = context()

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'search_text', arguments: { query: 'needle', path: 'src', pattern: '**/*.ts' } },
    }, render)).toEqual(['  • Explored', '    └ Search needle in src · **/*.ts'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'search_text', arguments: { query: 'needle' } }, output: results,
    }, render)).toEqual([])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '2', name: 'search_text', arguments: {} }, output: { error: 'bad' },
    }, render)).toEqual(['fallback result'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '3', name: 'read_file', arguments: {} },
    }, render)).toEqual(['raw arguments'])

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })

  it('groups later exploration calls under the existing heading', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const plugin = await ctx.plugin(searchTextRenderer)
    const previous = { type: 'tool-call' as const, call: { id: '1', name: 'read_file', arguments: { path: 'src/a.ts' } } }
    const search = { type: 'tool-call' as const, call: { id: '2', name: 'search_text', arguments: { query: 'needle', path: 'src' } } }

    expect(ctx.tui.renderEvent(search, context([previous, search]))).toEqual([
      '      Search needle in src',
    ])

    await plugin.dispose()
    await tui.dispose()
  })
})
