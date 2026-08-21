import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import readFileRenderer, { languageForPath, renderReadFile } from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function context(color = false): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width: 100, height: 24, provider: 'test', model: 'm', models: ['m'], theme: 'test',
    contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
  return {
    state, theme, width: 100, height: 24, color,
    style: color ? (text, _tone, bold) => bold ? `[${text}]` : text : text => text,
    fit: text => text,
    wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

describe('languageForPath', () => {
  it('infers common source languages from virtual paths', () => {
    expect(languageForPath('src/index.ts')).toBe('typescript')
    expect(languageForPath('src/App.tsx')).toBe('tsx')
    expect(languageForPath('@api/server.go')).toBe('go')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(languageForPath('Dockerfile')).toBeUndefined()
  })
})

describe('renderReadFile', () => {
  it('renders a compact file box with line numbers and a completion footer', () => {
    expect(renderReadFile('one\ntwo\nthree\n', context(), {}, {
      path: 'src/a.ts',
      toolName: 'read_file',
    })).toEqual([
      '  ┌ src/a.ts · 3 lines · typescript',
      '  │ 1 │ one',
      '  │ 2 │ two',
      '  │ 3 │ three',
      '  └ ✓ read_file',
    ])
  })

  it('renders empty files without a highlighted body', () => {
    expect(renderReadFile('', context(), {}, {
      path: 'src/empty.ts',
      toolName: 'read_file',
    })).toEqual([
      '  ┌ src/empty.ts · 0 lines · typescript',
      '  │ (empty)',
      '  └ ✓ read_file',
    ])
  })

  it('caps visible lines and reports the omission', () => {
    expect(renderReadFile('1\n2\n3\n4\n', context(), { maxLines: 2 }, {
      path: 'src/a.txt',
      toolName: 'read_file',
    })).toEqual([
      '  ┌ src/a.txt · 4 lines',
      '  │ 1 │ 1',
      '  │ 2 │ 2',
      '  │ [2 lines omitted]',
      '  └ ✓ read_file',
    ])
  })

  it('uses a compact default cap for large files', () => {
    const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    const output = renderReadFile(source, context(), {}, {
      path: 'src/big.txt',
      toolName: 'read_file',
    })
    expect(output[0]).toBe('  ┌ src/big.txt · 100 lines')
    expect(output[20]).toBe('  │  20 │ line 20')
    expect(output[21]).toBe('  │ [80 lines omitted]')
    expect(output[22]).toBe('  └ ✓ read_file')
    expect(output).toHaveLength(23)
  })

  it('uses syntax-highlighted spans and infers the language', () => {
    const languages: string[] = []
    const highlight = (code: string, language: string | undefined) => {
      languages.push(language ?? '')
      return [{ spans: [{ text: `‹${code}›`, style: { foreground: '#ff0000' } }] }]
    }
    expect(renderReadFile('one\n', context(), {}, {
      path: 'src/a.ts',
      highlight,
      toolName: 'read_file',
    })).toEqual([
      '  ┌ src/a.ts · 1 line · typescript',
      '  │ 1 │ ‹one›',
      '  └ ✓ read_file',
    ])
    expect(languages).toEqual(['typescript'])
  })

  it('falls back to plain text when the highlighter is unavailable', () => {
    expect(renderReadFile('one\n', context(), {}, {
      path: 'src/a.ts',
      highlight: () => undefined,
      toolName: 'read_file',
    })).toEqual([
      '  ┌ src/a.ts · 1 line · typescript',
      '  │ 1 │ one',
      '  └ ✓ read_file',
    ])
  })

  it('hides line numbers and the tool name when configured', () => {
    const output = renderReadFile('one\n', context(), {
      showLineNumbers: false,
      showToolName: false,
    }, {
      path: 'src/a.ts',
      toolName: 'read_file',
    })
    expect(output).toEqual([
      '  ┌ src/a.ts · 1 line · typescript',
      '  │ one',
      '  └ ✓',
    ])
  })
})

describe('read-file renderer plugin', () => {
  it('wins the event layer for read_file and defers unrelated or error events', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(readFileRenderer)
    const render = context()

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'read_file', arguments: { path: 'src/a.ts' } },
    }, render)).toEqual(['  • Explored', '    └ Read src/a.ts'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'read_file', arguments: { path: 'src/a.ts' } }, output: 'one\ntwo\n',
    }, render)).toEqual([])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '2', name: 'read_file', arguments: {} }, output: { error: 'bad' },
    }, render)).toEqual(['fallback result'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '3', name: 'run_command', arguments: {} }, output: 'ok',
    }, render)).toEqual(['fallback result'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '4', name: 'read_file', arguments: {} },
    }, render)).toEqual(['  • Explored', '    └ Read file'])

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })

  it('prefers presentation path metadata over tool arguments', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : undefined })
    } })
    const plugin = await ctx.plugin(readFileRenderer, { showResults: true })
    const render = context()

    const output = ctx.tui.renderEvent({
      type: 'tool-result',
      call: { id: '1', name: 'read_file', arguments: { path: 'src/arg.ts' } },
      output: 'one\n',
      presentation: { type: 'read-file', data: { path: 'src/presented.ts' } },
    }, render)
    expect(output[0]).toBe('  ┌ src/presented.ts · 1 line · typescript')

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })
})
