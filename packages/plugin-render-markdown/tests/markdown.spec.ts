import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ThemeService, TuiService, type RichTextSpan, type Theme, type TuiRenderContext, type TuiState } from '@flect/sdk'
import markdown from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#777777', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function hardWrap(value: string, width: number): string[] {
  const output: string[] = []
  for (const source of value.split('\n')) {
    if (!source) {
      output.push('')
      continue
    }
    for (let offset = 0; offset < source.length; offset += width) output.push(source.slice(offset, offset + width))
  }
  return output
}

function renderContext(themeOverride: Theme = theme, width = 80): TuiRenderContext {
  const state: TuiState = {
    cwd: '.', width, height: 24, provider: 'test', model: 'test', models: ['test'], theme: 'test',
    contextWindow: 1_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
  return {
    state, theme: themeOverride, width, height: 24, color: false,
    style: text => text,
    fit: (text, target = width) => text.slice(0, target),
    wrap: (text, target = width) => hardWrap(text, target),
    renderRich: (lines, target = width) => lines.flatMap(line => hardWrap(
      line.spans.map(span => span.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).join(''),
      target,
    )),
  }
}

function captureSpans(themeOverride: Theme = theme): { context: TuiRenderContext; spans: RichTextSpan[] } {
  const base = renderContext(themeOverride)
  const spans: RichTextSpan[] = []
  return {
    spans,
    context: {
      ...base,
      renderRich: lines => {
        spans.push(...lines.flatMap(line => line.spans))
        return lines.map(line => line.spans.map(span => span.text).join(''))
      },
    },
  }
}

describe('markdown event renderer', () => {
  it('renders GFM structure, tasks, tables, and safe inert HTML', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(TuiService), ctx.plugin(ThemeService)])
    const contribution = await ctx.plugin(markdown, { codeLineNumbers: true })
    const lines = ctx.tui.renderEvent({
      type: 'assistant-finish', messageId: 'm1',
      text: '# Heading\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst n = 1\n```\n\n<b>inert</b>\u001b[31m',
    }, renderContext())
    const output = lines.join('\n')
    expect(output).toContain('Heading')
    expect(output).toContain('[x]')
    expect(output).toContain('A │ B')
    expect(output).toContain('1 │ const n = 1')
    expect(output).toContain('<b>inert</b>')
    expect(output).not.toContain('\u001b')

    await contribution.dispose()
    expect(ctx.tui.renderEvent({ type: 'assistant-finish', messageId: 'm2', text: 'plain' }, renderContext())).toEqual([])
    await Promise.all(services.map(service => service.dispose()))
  })

  it('renders inline code with accent text on a muted background by default', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(TuiService), ctx.plugin(ThemeService)])
    const contribution = await ctx.plugin(markdown)
    const { context, spans } = captureSpans()
    ctx.tui.renderEvent({ type: 'assistant-finish', messageId: 'm1', text: 'Run `pnpm build` now.' }, context)
    const code = spans.find(span => span.text === 'pnpm build')
    expect(code?.style).toEqual({ foreground: '#00aaff', background: '#777777', bold: true })
    await contribution.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })

  it('reserves margins and list markers before wrapping', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(TuiService), ctx.plugin(ThemeService)])
    const contribution = await ctx.plugin(markdown)
    const width = 40
    const lines = ctx.tui.renderEvent({
      type: 'assistant-finish', messageId: 'wrapped-list',
      text: '- Registered them with priorities 20 and 10 so the original vertical order is preserved.',
    }, renderContext(theme, width))

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => line.length <= width)).toBe(true)
    expect(lines[0]).toMatch(/^  • /)
    expect(lines.slice(1).every(line => line.startsWith('    '))).toBe(true)

    await contribution.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })

  it('renders inline code with the theme inlineCode highlight color when provided', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(TuiService), ctx.plugin(ThemeService)])
    const contribution = await ctx.plugin(markdown)
    const themed: Theme = { ...theme, tokens: { ...theme.tokens, colors: { ...theme.tokens.colors, inlineCode: '#d65d0e' } } }
    const { context, spans } = captureSpans(themed)
    ctx.tui.renderEvent({ type: 'assistant-finish', messageId: 'm2', text: 'Run `pnpm build` now.' }, context)
    const code = spans.find(span => span.text === 'pnpm build')
    expect(code?.style).toEqual({ foreground: '#000000', background: '#d65d0e', bold: true })
    await contribution.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })

  it('reuses rendered documents across restored event objects', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(TuiService), ctx.plugin(ThemeService)])
    const contribution = await ctx.plugin(markdown)
    const base = renderContext()
    let richRenders = 0
    const render: TuiRenderContext = {
      ...base,
      renderRich(lines) {
        richRenders += 1
        return lines.map(line => line.spans.map(span => span.text).join(''))
      },
    }
    const event = () => ({ type: 'assistant-finish' as const, messageId: crypto.randomUUID(), text: '**cached document**' })

    ctx.tui.renderEvent(event(), render)
    const first = richRenders
    ctx.tui.renderEvent(event(), render)
    expect(richRenders).toBe(first)

    await contribution.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })
})
