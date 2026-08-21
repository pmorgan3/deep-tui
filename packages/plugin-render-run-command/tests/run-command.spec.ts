import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import runCommandRenderer, { parseRunCommandOutput, renderCompactRunCommand, renderRunCommand } from '../src/index.js'

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

const success = {
  code: 0, signal: null, stdout: 'hello\nworld\n', stderr: '',
  stdoutTruncated: false, stderrTruncated: false, timedOut: false, elapsedMs: 12,
}

describe('parseRunCommandOutput', () => {
  it('parses the live structured process result', () => {
    expect(parseRunCommandOutput(success)).toEqual({
      kind: 'result',
      result: {
        code: 0, signal: null, stdout: 'hello\nworld\n', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, timedOut: false, elapsedMs: 12,
      },
    })
  })

  it('parses durable-session JSON strings', () => {
    expect(parseRunCommandOutput(JSON.stringify(success))).toEqual(parseRunCommandOutput(success))
  })

  it('parses tool failures and ignores unrelated output', () => {
    expect(parseRunCommandOutput({ error: 'permission denied' })).toEqual({ kind: 'failure', error: 'permission denied' })
    expect(parseRunCommandOutput('ok')).toBeUndefined()
    expect(parseRunCommandOutput({ code: 0 })).toBeUndefined()
  })
})

describe('renderRunCommand', () => {
  it('renders stdout and exit status as a compact box', () => {
    expect(renderRunCommand(success, context(), {}, { argv: ['node', '-e', 'console.log("hi")'], toolName: 'run_command' })).toEqual([
      '  ┌ run_command · node -e "console.log(\\"hi\\")"',
      '  │ exit 0 · 12ms',
      '  │ stdout · 2 lines',
      '  │ hello',
      '  │ world',
      '  └ ✓ run_command',
    ])
  })

  it('renders stderr and a non-zero exit as a failure', () => {
    expect(renderRunCommand(
      { code: 1, signal: null, stdout: '', stderr: 'boom\n', elapsedMs: 20 },
      context(), {}, { argv: ['pnpm', 'test'], toolName: 'run_command' },
    )).toEqual([
      '  ┌ run_command · pnpm test',
      '  │ exit 1 · 20ms',
      '  │ stderr · 1 line',
      '  │ boom',
      '  └ ✗ run_command',
    ])
  })

  it('renders timeouts with a warning footer', () => {
    expect(renderRunCommand(
      { code: null, signal: null, stdout: '', stderr: '', timedOut: true, elapsedMs: 1_000 },
      context(), {}, { toolName: 'run_command' },
    )).toEqual([
      '  ┌ run_command',
      '  │ timed out · 1.0s',
      '  │ (no output)',
      '  └ ⚠ run_command',
    ])
  })

  it('bounds per-stream output and reports omissions', () => {
    const stdout = Array.from({ length: 5 }, (_, index) => `line${index}`).join('\n')
    expect(renderRunCommand(
      { code: 0, signal: null, stdout, stderr: '', elapsedMs: 12 },
      context(), { maxStdoutLines: 2 }, { toolName: 'run_command' },
    )).toEqual([
      '  ┌ run_command',
      '  │ exit 0 · 12ms',
      '  │ stdout · 5 lines',
      '  │ line0',
      '  │ line1',
      '  │ [3 stdout lines omitted]',
      '  └ ✓ run_command',
    ])
  })

  it('strips ANSI escape sequences from command output', () => {
    expect(renderRunCommand(
      { code: 0, signal: null, stdout: '\u001b[31mred\u001b[0m\n', stderr: '' },
      context(), {}, { toolName: 'run_command' },
    )).toEqual([
      '  ┌ run_command',
      '  │ exit 0',
      '  │ stdout · 1 line',
      '  │ red',
      '  └ ✓ run_command',
    ])
  })

  it('renders tool failures', () => {
    expect(renderRunCommand(
      { error: 'permission denied: nope' },
      context(), {}, { argv: ['nope'], toolName: 'run_command' },
    )).toEqual([
      '  ┌ run_command · nope',
      '  │ ✗ permission denied: nope',
      '  └ ✗ run_command',
    ])
  })
})

describe('renderCompactRunCommand', () => {
  it('shows a head/tail preview, omitted count, and duration', () => {
    const stdout = Array.from({ length: 5 }, (_, index) => `line${index}`).join('\n')
    expect(renderCompactRunCommand(
      { code: 0, signal: null, stdout, stderr: '', elapsedMs: 12 },
      context(),
    )).toEqual([
      '  │ line0',
      '  │ line1',
      '  │ [2 lines omitted]',
      '  │ line4',
      '  └ 12ms',
    ])
  })

  it('keeps failure output and status visible', () => {
    expect(renderCompactRunCommand(
      { code: 1, signal: null, stdout: '', stderr: 'boom\n', elapsedMs: 20 },
      context(),
    )).toEqual([
      '  │ boom',
      '  │ exit 1',
      '  └ 20ms',
    ])
  })
})

describe('run command renderer plugin', () => {
  it('wins the event layer for run_command and defers unrelated events', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const fallback = await ctx.plugin({ name: 'fallback', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({ id: 'fallback.tool', priority: -100, render: event =>
        event.type === 'tool-result' ? ['fallback result'] : event.type === 'tool-call' ? ['raw arguments'] : undefined })
    } })
    const plugin = await ctx.plugin(runCommandRenderer)
    const render = context()

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '1', name: 'run_command', arguments: { argv: ['pnpm', 'test'] } },
    }, render)).toEqual(['  • Ran pnpm test'])

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: 'wrapped', name: 'run_command', arguments: { argv: ['pnpm', '--filter', 'app', 'test'] } },
    }, { ...render, wrap: () => ['pnpm --filter app', 'test'] })).toEqual([
      '  • Ran pnpm --filter app',
      '  │   test',
    ])

    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'run_command', arguments: { argv: ['pnpm', 'test'] } },
      output: success,
    }, render)).toEqual(['  │ hello', '  │ world', '  └ 12ms'])

    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '2', name: 'run_command', arguments: {} },
      output: JSON.stringify(success),
    }, render)).toEqual(['  │ hello', '  │ world', '  └ 12ms'])

    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '3', name: 'run_command', arguments: {} }, output: 'ok',
    }, render)).toEqual(['fallback result'])

    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '4', name: 'write_file', arguments: {} }, output: {},
    }, render)).toEqual(['fallback result'])

    expect(ctx.tui.renderEvent({
      type: 'tool-call', call: { id: '5', name: 'write_file', arguments: { path: 'src/a.ts' } },
    }, render)).toEqual(['raw arguments'])

    await plugin.dispose()
    await fallback.dispose()
    await tui.dispose()
  })

  it('retains the detailed result box when compact mode is disabled', async () => {
    const ctx = new Context()
    const tui = await ctx.plugin(TuiService)
    const plugin = await ctx.plugin(runCommandRenderer, { compact: false })

    expect(ctx.tui.renderEvent({
      type: 'tool-result', call: { id: '1', name: 'run_command', arguments: { argv: ['pnpm', 'test'] } },
      output: success,
    }, context())).toEqual([
      '  ┌ run_command · pnpm test',
      '  │ exit 0 · 12ms',
      '  │ stdout · 2 lines',
      '  │ hello',
      '  │ world',
      '  └ ✓ run_command',
    ])

    await plugin.dispose()
    await tui.dispose()
  })
})
