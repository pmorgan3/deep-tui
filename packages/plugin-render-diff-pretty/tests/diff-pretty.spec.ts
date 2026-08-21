import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, createUnifiedDiff, type RichTextLine, type Theme, type TuiRenderContext, type TuiState } from '@deep-tui/sdk'
import prettyRenderer, { parseUnifiedDiff, renderPrettyDiff, renderWriteFileDiff } from '../src/index.js'

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
    renderRich: lines => lines.map(line => line.spans.map(span => color && span.style?.bold ? `[${span.text}]` : span.text).join('')),
  }
}

const singleFile = createUnifiedDiff('src/a.ts', 'one\ntwo\nthree\n', 'one\nchanged\nthree\n')

describe('parseUnifiedDiff', () => {
  it('parses plain apply_patch headers', () => {
    expect(parseUnifiedDiff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n')).toEqual([
      {
        oldPath: 'src/a.ts', newPath: 'src/a.ts', additions: 1, deletions: 1,
        hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [' one', '-two', '+changed', ' three'] }],
      },
    ])
  })

  it('parses git headers, metadata, renames, and multiple files', () => {
    const source = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 123..456 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+changed',
      ' three',
      'diff --git a/old.txt b/new.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(parseUnifiedDiff(source)).toEqual([
      {
        oldPath: 'src/a.ts', newPath: 'src/a.ts', additions: 1, deletions: 1,
        hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [' one', '-two', '+changed', ' three'] }],
      },
      {
        oldPath: 'old.txt', newPath: 'new.txt', additions: 1, deletions: 1,
        hunks: [{ header: '@@ -1,1 +1,1 @@', lines: ['-old', '+new'] }],
      },
    ])
  })

  it('normalizes CRLF and skips no-newline metadata', () => {
    expect(parseUnifiedDiff('--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n\\ No newline at end of file\r\n')).toEqual([
      {
        oldPath: 'a.txt', newPath: 'a.txt', additions: 1, deletions: 1,
        hunks: [{ header: '@@ -1,1 +1,1 @@', lines: ['-old', '+new'] }],
      },
    ])
  })

  it('returns no files for unrelated text', () => {
    expect(parseUnifiedDiff('not a diff\nat all\n')).toEqual([])
  })
})

describe('renderPrettyDiff', () => {
  it('renders write_file like an editor diff with line numbers and no box footer', () => {
    expect(renderWriteFileDiff(singleFile, context(), {}, { files: ['src/a.ts'], toolName: 'write_file' })
      .map(line => line.trimEnd())).toEqual([
      '  • Edited src/a.ts (+1 -1)',
      '  1   one',
      '  2 - two',
      '  2 + changed',
      '  3   three',
    ])
  })

  it('tints every span across full-width write_file change rows', () => {
    const render = context()
    const captured: RichTextLine[] = []
    render.renderRich = lines => {
      captured.push(...lines)
      return lines.map(line => line.spans.map(span => span.text).join(''))
    }
    renderWriteFileDiff(singleFile, render, {}, { files: ['src/a.ts'] })

    expect(captured[1]?.spans.every(span => span.style?.background === '#260000')).toBe(true)
    expect(captured[2]?.spans.every(span => span.style?.background === '#002600')).toBe(true)
    expect(captured[1]?.spans.map(span => span.text).join('')).toHaveLength(render.width)
    expect(captured[2]?.spans.map(span => span.text).join('')).toHaveLength(render.width)
  })

  it('renders a compact per-file box with hunks and a completion footer', () => {
    expect(renderPrettyDiff(singleFile, context(), {}, { files: ['src/a.ts'], toolName: 'apply_patch' })).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ +changed',
      '  │  three',
      '  └ ✓ apply_patch',
    ])
  })

  it('summarizes multiple files in the footer', () => {
    const source = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n' +
      '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n'
    expect(renderPrettyDiff(source, context(), {}, { toolName: 'apply_patch' })).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ +changed',
      '  │  three',
      '  │',
      '  ┌ src/b.ts · +1 -1',
      '  │ @@ -1,2 +1,2 @@',
      '  │ -old',
      '  │ +new',
      '  └ ✓ apply_patch · 2 files · +2 -2',
    ])
  })

  it('labels creates, deletes, and renames', () => {
    expect(renderPrettyDiff(
      '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+hello\n',
      context(), {}, { files: ['src/new.ts'], toolName: 'apply_patch' },
    )[0]).toBe('  ┌ src/new.ts · +1 -0 · new file')
    expect(renderPrettyDiff(
      '--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n',
      context(), {}, { files: ['src/old.ts'], toolName: 'apply_patch' },
    )[0]).toBe('  ┌ src/old.ts · +0 -1 · deleted file')
    expect(renderPrettyDiff(
      '--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      context(), {}, { files: ['new.txt'], toolName: 'apply_patch' },
    )[0]).toBe('  ┌ new.txt · +1 -1 · renamed')
  })

  it('truncates long files and reports the omission', () => {
    expect(renderPrettyDiff(singleFile, context(), { maxLinesPerFile: 3 }, { files: ['src/a.ts'], toolName: 'apply_patch' })).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ [2 more lines omitted]',
      '  └ ✓ apply_patch',
    ])
  })

  it('caps the total output before the footer', () => {
    const output = renderPrettyDiff(singleFile, context(), { maxTotalLines: 4 }, { files: ['src/a.ts'], toolName: 'apply_patch' })
    expect(output).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ [2 diff lines omitted]',
      '  └ ✓ apply_patch',
    ])
  })

  it('falls back to a bounded raw diff when nothing parses', () => {
    expect(renderPrettyDiff('not a diff\nat all\n', context(), {}, { toolName: 'apply_patch' })).toEqual([
      '  │ not a diff',
      '  │ at all',
      '  └ ✓ apply_patch',
    ])
  })

  it('bolds the changed span inside +/- pairs', () => {
    const render = context(true)
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const value = 1\n+const value = 2\n'
    expect(renderPrettyDiff(diff, render, {}, { files: ['src/a.ts'], toolName: 'apply_patch' })).toEqual([
      '  [┌] [src/a.ts] · [+1] [-1]',
      '  │ [@@ -1,1 +1,1 @@]',
      '  │ -const value = [1]',
      '  │ +const value = [2]',
      '  [└] ✓ apply_patch',
    ])
  })

  it('keeps syntax-highlighted code with the diff marker and infers the language', () => {
    const languages: string[] = []
    const highlight = (code: string, language: string | undefined) => {
      languages.push(language ?? '')
      return [{ spans: [{ text: `‹${code}›`, style: { foreground: '#ff0000' } }] }]
    }
    const output = renderPrettyDiff(singleFile, context(), {}, {
      files: ['src/a.ts'],
      highlight,
      toolName: 'apply_patch',
    })
    expect(output).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  ‹one›',
      '  │ -‹two›',
      '  │ +‹changed›',
      '  │  ‹three›',
      '  └ ✓ apply_patch',
    ])
    expect(languages).toEqual(['typescript', 'typescript', 'typescript', 'typescript'])
  })

  it('hides the tool name and hunk headers when configured', () => {
    const output = renderPrettyDiff(singleFile, context(), { showToolName: false, showHunks: false }, { files: ['src/a.ts'], toolName: 'apply_patch' })
    expect(output.at(-1)).toBe('  └ ✓')
    expect(output).not.toContain('@@ -1,3 +1,3 @@')
  })
})

describe('pretty diff renderer plugin', () => {
  it('wins the event layer over fallback renderers and defers unrelated events', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(prettyRenderer)
    const render = context()

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'apply_patch', arguments: {
        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      } },
    }, render)).toEqual(['  ↳ apply_patch · src/a.ts · +1 -1'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '2', name: 'apply_patch', arguments: {
        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n',
      } },
    }, render)).toEqual(['  ↳ apply_patch · 2 files · +2 -2'])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '3', name: 'apply_patch', arguments: {} }, output: {},
      presentation: { type: 'diff', data: { diff: singleFile, files: ['src/a.ts'] } },
    }, render)).toEqual([
      '  ┌ src/a.ts · +1 -1',
      '  │ @@ -1,3 +1,3 @@',
      '  │  one',
      '  │ -two',
      '  │ +changed',
      '  │  three',
      '  └ ✓ apply_patch',
    ])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '4', name: 'write_file', arguments: {} }, output: {},
      presentation: { type: 'diff', data: { diff: singleFile, files: ['src/a.ts'] } },
    }, render).map(line => line.trimEnd())).toEqual([
      '  • Edited src/a.ts (+1 -1)',
      '  1   one',
      '  2 - two',
      '  2 + changed',
      '  3   three',
    ])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '5', name: 'write_file', arguments: { path: 'src/a.ts', content: 'secret' } },
    }, render)).toEqual([])
    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '6', name: 'run_command', arguments: {} }, output: 'ok',
    }, render)).toEqual(['fallback result'])
    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '7', name: 'run_command', arguments: {} },
    }, render)).toEqual(['raw arguments'])

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })
})
