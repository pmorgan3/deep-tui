import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import filesRenderer, {
  parseFindFilesOutput,
  parseListFilesOutput,
  renderFileResults,
} from '../src/index.js'

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
    style: text => text,
    fit: text => text,
    wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

describe('file result parsing', () => {
  it('parses live and durable list_files arrays', () => {
    const expected = { files: ['src/', 'src/index.ts'], truncated: false }
    expect(parseListFilesOutput(['src/', 'src/index.ts'])).toEqual(expected)
    expect(parseListFilesOutput(JSON.stringify(['src/', 'src/index.ts']))).toEqual(expected)
  })

  it('parses live and durable find_files objects and rejects malformed values', () => {
    const expected = { files: ['src/index.ts'], truncated: true }
    expect(parseFindFilesOutput({ files: ['src/index.ts'], truncated: true })).toEqual(expected)
    expect(parseFindFilesOutput(JSON.stringify({ files: ['src/index.ts'], truncated: true }))).toEqual(expected)
    expect(parseFindFilesOutput({ files: [1], truncated: false })).toBeUndefined()
    expect(parseListFilesOutput({ error: 'nope' })).toBeUndefined()
  })
})

describe('renderFileResults', () => {
  it('renders directories and files in a compact result box', () => {
    expect(renderFileResults({
      files: ['src/', 'src/index.ts', 'README.md'], truncated: false,
    }, context(), {}, { label: 'workspace', noun: 'entry', toolName: 'list_files' })).toEqual([
      '  ┌ workspace · 3 entries',
      '  │ ▸ src/',
      '  │ • src/index.ts',
      '  │ • README.md',
      '  └ ✓ list_files',
    ])
  })

  it('bounds visible results and distinguishes renderer and tool truncation', () => {
    expect(renderFileResults({
      files: ['a.ts', 'b.ts', 'c.ts'], truncated: true,
    }, context(), { maxEntries: 1 }, { label: '*.ts in src', noun: 'file', toolName: 'find_files' })).toEqual([
      '  ┌ *.ts in src · 3 files',
      '  │ • a.ts',
      '  │ [2 files omitted]',
      '  │ [additional results truncated by tool]',
      '  └ ✓ find_files',
    ])
  })

  it('renders an empty result clearly', () => {
    expect(renderFileResults({ files: [], truncated: false }, context(), {}, {
      label: 'src', noun: 'file', toolName: 'find_files',
    })).toEqual([
      '  ┌ src · 0 files',
      '  │ (no files)',
      '  └ ✓ find_files',
    ])
  })
})

describe('files renderer plugin', () => {
  it('wins list_files/find_files event layers and defers unrelated or malformed results', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(filesRenderer)
    const render = context()

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'list_files', arguments: { path: 'src' } },
    }, render)).toEqual(['  • Explored', '    └ List src'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '2', name: 'find_files', arguments: { pattern: '**/*.ts', path: 'src' } },
    }, render)).toEqual(['  • Explored', '    └ Find **/*.ts in src'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'list_files', arguments: { path: 'src' } }, output: ['src/a.ts'],
    }, render)).toEqual([])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '2', name: 'find_files', arguments: { pattern: '*.ts' } },
      output: JSON.stringify({ files: ['a.ts'], truncated: false }),
    }, render)).toEqual([])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '3', name: 'find_files', arguments: {} }, output: { error: 'bad' },
    }, render)).toEqual(['fallback result'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '4', name: 'read_file', arguments: {} },
    }, render)).toEqual(['raw arguments'])

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })
})
