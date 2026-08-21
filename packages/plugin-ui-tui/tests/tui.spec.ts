import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type Theme, type TuiActions, type TuiRenderContext, type TuiState } from '@deep-tui/sdk'
import {
  activityLabel,
  coalesceMouseMoves,
  decodeKeys,
  defaultComponents,
  defaultEventRenderers,
  fit,
  layoutTuiFrame,
  mergeUsage,
  reasoningMessageAt,
  renderFrameUpdate,
  renderRichText,
  stripAnsi,
  TuiInputDecoder,
  unaccountedUsage,
  visibleWidth,
  wrap,
  wrapAnsi,
} from '../src/index.js'

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: { background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff', success: '#00ff00', warning: '#ffff00', danger: '#ff0000' },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

describe('composable TUI contracts', () => {
  it('wraps ANSI-styled text without losing content or adding ellipses', () => {
    const input = '\u001b[38;2;255;0;0mabcdefghi\u001b[39m'
    const lines = wrapAnsi(input, 4)
    expect(lines.map(stripAnsi)).toEqual(['abcd', 'efgh', 'i'])
    expect(lines.every(line => visibleWidth(line) <= 4)).toBe(true)
    expect(lines[1]).toContain('\u001b[38;2;255;0;0m')
    expect(lines.join('')).not.toContain('…')
  })

  it('uses a plain crop as the final fit safety without an ellipsis', () => {
    expect(fit('abcdefgh', 4)).toBe('abcd')
  })

  it('hot-swaps a slot override and reveals the default when it unloads', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    let revisions = 0
    const unsubscribe = ctx.tui.subscribe(() => { revisions += 1 })
    const defaults = await ctx.plugin({
      name: 'default-component',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerComponent({
          id: 'default.header',
          slot: 'header',
          priority: -100,
          render: () => ['default'],
        })
      },
    })
    const override = await ctx.plugin({
      name: 'override-component',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerComponent({
          id: 'custom.header',
          slot: 'header',
          priority: 10,
          render: () => ['custom'],
        })
      },
    })

    expect(ctx.tui.component('header')?.id).toBe('custom.header')
    await override.dispose()
    expect(ctx.tui.component('header')?.id).toBe('default.header')
    expect(revisions).toBeGreaterThanOrEqual(3)

    unsubscribe()
    await defaults.dispose()
    await service.dispose()
  })

  it('composes empty-transcript sections by priority and unloads them', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const defaults = await ctx.plugin({
      name: 'default-components',
      inject: ['tui'],
      apply(inner) {
        for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
      },
    })
    const low = await ctx.plugin({
      name: 'empty-low',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerEmptyStateSection({
          id: 'test.empty.low', priority: -100,
          render: () => ['low'],
        })
      },
    })
    const high = await ctx.plugin({
      name: 'empty-high',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerEmptyStateSection({
          id: 'test.empty.high', priority: 100,
          render: () => ['high'],
        })
      },
    })
    const transcript = ctx.tui.component('transcript')
    const render: TuiRenderContext = {
      state: baseState(), theme, width: 80, height: 24, color: false,
      style: text => text,
      fit: text => text,
      wrap: text => [text],
      renderRich: () => [],
    }

    expect(transcript?.render(render)).toEqual(['high', 'low'])
    await high.dispose()
    expect(transcript?.render(render)).toEqual(['low'])
    await low.dispose()
    expect(transcript?.render(render)).toEqual([])

    await defaults.dispose()
    await service.dispose()
  })

  it('decodes text, model switching, and navigation keys', () => {
    expect(decodeKeys(Buffer.from(`hi\u0002\u0010\u0014\u001b[D`))).toEqual([
      { name: 'text', sequence: 'h', text: 'h' },
      { name: 'text', sequence: 'i', text: 'i' },
      { name: 'ctrl+b', sequence: '\u0002' },
      { name: 'ctrl+p', sequence: '\u0010' },
      { name: 'ctrl+t', sequence: '\u0014' },
      { name: 'left', sequence: '\u001b[D' },
    ])
  })

  it('buffers fragmented UTF-8, page keys, and mouse sequences without treating clicks as text', () => {
    const source = Buffer.from(`é\u001b[5~\u001b[<0;12;8M\u001b[<0;12;8m\u001b[<64;12;8M`)
    const expected = [
      { name: 'text', sequence: 'é', text: 'é' },
      { name: 'pageup', sequence: '\u001b[5~' },
      { name: 'mouse-left', sequence: '\u001b[<0;12;8M', mouse: { button: 'left', x: 12, y: 8 } },
      { name: 'mouse-release', sequence: '\u001b[<0;12;8m', mouse: { button: 'left-release', x: 12, y: 8 } },
      { name: 'wheel-up', sequence: '\u001b[<64;12;8M', mouse: { button: 'wheel-up', x: 12, y: 8 } },
    ]
    for (let split = 1; split < source.length; split += 1) {
      const decoder = new TuiInputDecoder()
      expect([...decoder.push(source.subarray(0, split)), ...decoder.push(source.subarray(split)), ...decoder.flush()]).toEqual(expected)
    }
  })

  it('consumes SGR button, release, motion, and horizontal-wheel reports', () => {
    expect(decodeKeys(Buffer.from(
      `a\u001b[<0;4;5M\u001b[<0;4;5m\u001b[<32;6;7M\u001b[<35;8;9M\u001b[<66;8;9Mb`,
    ))).toEqual([
      { name: 'text', sequence: 'a', text: 'a' },
      { name: 'mouse-left', sequence: '\u001b[<0;4;5M', mouse: { button: 'left', x: 4, y: 5 } },
      { name: 'mouse-release', sequence: '\u001b[<0;4;5m', mouse: { button: 'left-release', x: 4, y: 5 } },
      { name: 'mouse-drag', sequence: '\u001b[<32;6;7M', mouse: { button: 'left-drag', x: 6, y: 7 } },
      { name: 'mouse-move', sequence: '\u001b[<35;8;9M', mouse: { button: 'move', x: 8, y: 9 } },
      { name: 'text', sequence: 'b', text: 'b' },
    ])
  })

  it('coalesces consecutive pointer motion while preserving other input', () => {
    const move = (x: number): TuiKeyEvent => ({
      name: 'mouse-move', sequence: '', mouse: { button: 'move', x, y: 4 },
    })
    expect(coalesceMouseMoves([
      move(1), move(2),
      { name: 'text', sequence: 'a', text: 'a' },
      move(3), move(4),
    ])).toEqual([
      move(2),
      { name: 'text', sequence: 'a', text: 'a' },
      move(4),
    ])
  })

  it('renders configured step-budget exhaustion as stopped rather than finished', () => {
    const renderer = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.finish')
    const rendered = renderer?.render(
      { type: 'finish', text: '', steps: 12, status: 'limit-reached' },
      {
        state: baseState(), theme, width: 80, height: 24, color: false,
        style: text => text,
        fit: text => text,
        wrap: text => [text],
        renderRich: () => [],
      },
    )

    expect(rendered).toEqual(['', '  stopped after 12 steps · configured step limit reached'])
  })

  it('renders model reasoning as a collapsed block that can be expanded', () => {
    const renderer = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.reasoning')
    const state = baseState()
    const event = {
      type: 'assistant-finish' as const,
      messageId: 'reason-1',
      reasoning: 'Inspect the decoder and then add a regression test.',
      text: 'I fixed it.',
    }
    const context = () => ({
      state, theme, width: 80, height: 24, color: false,
      style: (text: string) => text,
      fit: (text: string) => text,
      wrap: (text: string) => [text],
      renderRich: () => [],
    })

    expect(renderer?.render(event, context())).toEqual([
      '  ▸ Thinking · 9 words · ctrl+t or click to expand',
      '',
    ])
    const headerStyles: Array<{ tone: string | undefined; bold: boolean | undefined }> = []
    state.hoveredReasoning = 'reason-1'
    renderer?.render(event, {
      ...context(),
      style(text, tone, bold) {
        headerStyles.push({ tone, bold })
        return text
      },
    })
    expect(headerStyles[0]).toEqual({ tone: 'accent', bold: true })
    delete state.hoveredReasoning
    state.expandedReasoning = { 'reason-1': true }
    expect(renderer?.render(event, context())).toEqual([
      '  ▾ Thinking · 9 words',
      '    Inspect the decoder and then add a regression test.',
      '',
    ])
  })

  it('keeps the reasoning disclosure when a richer assistant renderer wins', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const defaults = await ctx.plugin({
      name: 'default-event-renderers', inject: ['tui'], apply(inner) {
        for (const renderer of defaultEventRenderers()) inner.tui.registerEventRenderer(renderer)
      },
    })
    const markdown = await ctx.plugin({
      name: 'markdown-test-renderer', inject: ['tui'], apply(inner) {
        inner.tui.registerEventRenderer({
          id: 'test.markdown', priority: 50,
          render: event => event.type === 'assistant-finish' ? ['  rendered Markdown'] : undefined,
        })
      },
    })
    const state = baseState()
    const render: TuiRenderContext = {
      state, theme, width: 80, height: 24, color: false,
      style: text => text,
      fit: text => text,
      wrap: text => [text],
      renderRich: () => [],
    }
    const event = {
      type: 'assistant-finish' as const,
      messageId: 'reason-1',
      reasoning: 'Visible through composition.',
      text: '# Answer',
    }

    expect(ctx.tui.renderEvent(event, render)).toEqual([
      '  ▸ Thinking · 3 words · ctrl+t or click to expand',
      '',
      '  rendered Markdown',
    ])
    state.expandedReasoning = { 'reason-1': true }
    expect(ctx.tui.renderEvent(event, render)).toEqual([
      '  ▾ Thinking · 3 words',
      '    Visible through composition.',
      '',
      '  rendered Markdown',
    ])

    await markdown.dispose()
    await defaults.dispose()
    await service.dispose()
  })

  it('maps mouse clicks on visible reasoning headers to the correct message', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const defaults = await ctx.plugin({
      name: 'clickable-reasoning', inject: ['tui'], apply(inner) {
        for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
        for (const renderer of defaultEventRenderers()) inner.tui.registerEventRenderer(renderer)
      },
    })
    const state = baseState()
    state.height = 16
    state.events = [
      ...Array.from({ length: 8 }, (_, index) => ({ type: 'start' as const, input: `old event ${index}` })),
      { type: 'assistant-finish', messageId: 'reason-1', reasoning: 'First visible thought.', text: 'First answer.' },
      { type: 'assistant-finish', messageId: 'reason-2', reasoning: 'Second visible thought.', text: 'Second answer.' },
    ]

    let lines = layoutTuiFrame(ctx.tui, state, theme, false).output.split('\r\n')
    const thinkingRows = lines.flatMap((line, index) => line.includes('Thinking ·') ? [index + 1] : [])
    expect(thinkingRows).toHaveLength(2)
    expect(reasoningMessageAt(ctx.tui, state, theme, false, 4, thinkingRows[0]!)).toBe('reason-1')
    expect(reasoningMessageAt(ctx.tui, state, theme, false, 4, thinkingRows[1]!)).toBe('reason-2')
    expect(reasoningMessageAt(ctx.tui, state, theme, false, 79, thinkingRows[1]!)).toBeUndefined()

    state.expandedReasoning = { 'reason-1': true }
    lines = layoutTuiFrame(ctx.tui, state, theme, false).output.split('\r\n')
    const expandedRow = lines.findIndex(line => line.includes('▾ Thinking ·')) + 1
    expect(expandedRow).toBeGreaterThan(0)
    expect(reasoningMessageAt(ctx.tui, state, theme, false, 4, expandedRow)).toBe('reason-1')

    await defaults.dispose()
    await service.dispose()
  })

  it('reuses layout interaction regions for repeated reasoning hit tests', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    let renders = 0
    const defaults = await ctx.plugin({
      name: 'cached-reasoning-hit-test', inject: ['tui'], apply(inner) {
        for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
        for (const renderer of defaultEventRenderers()) inner.tui.registerEventRenderer(renderer)
        inner.tui.registerEventRenderer({
          id: 'test.count-reasoning', mode: 'append', priority: 100,
          render(event) {
            if (event.type !== 'assistant-finish') return undefined
            renders += 1
            return []
          },
        })
      },
    })
    const state = baseState()
    state.events = [{
      type: 'assistant-finish', messageId: 'reason-1', reasoning: 'A cached thought.', text: 'Answer.',
    }]
    const layout = layoutTuiFrame(ctx.tui, state, theme, false)
    const row = layout.output.split('\r\n').findIndex(line => line.includes('Thinking ·')) + 1
    const afterLayout = renders

    expect(reasoningMessageAt(ctx.tui, state, theme, false, 4, row)).toBe('reason-1')
    expect(reasoningMessageAt(ctx.tui, state, theme, false, 5, row)).toBe('reason-1')
    expect(renders).toBe(afterLayout)

    await defaults.dispose()
    await service.dispose()
  })

  it('renders read_file tool calls as a friendly reading message', () => {
    const toolCall = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.tool-call')
    const toolResult = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.tool-result')
    const context = () => ({
      state: baseState(), theme, width: 80, height: 24, color: false,
      style: (text: string) => text,
      fit: (text: string) => text,
      wrap: (text: string) => [text],
      renderRich: () => [],
    })
    expect(toolCall?.render(
      { type: 'tool-call', call: { id: '1', name: 'read_file', arguments: { path: 'src/index.ts' } } },
      context(),
    )).toEqual(['  ┌ Reading src/index.ts'])
    expect(toolResult?.render(
      { type: 'tool-result', call: { id: '1', name: 'read_file', arguments: { path: 'src/index.ts' } }, output: '' },
      context(),
    )).toEqual(['  └ ✓ Reading src/index.ts'])
  })

  it('keeps raw arguments for tools without a friendly label', () => {
    const toolCall = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.tool-call')
    expect(toolCall?.render(
      { type: 'tool-call', call: { id: '2', name: 'run_command', arguments: { argv: ['pnpm', 'test'] } } },
      {
        state: baseState(), theme, width: 80, height: 24, color: false,
        style: (text: string) => text,
        fit: (text: string) => text,
        wrap: (text: string) => [text],
        renderRich: () => [],
      },
    )).toEqual(['  ┌ run_command', '  │ {"argv":["pnpm","test"]}'])
  })

  it('formats animated work status with the current tool and elapsed time', () => {
    const state = baseState()
    state.busy = true
    state.status = 'running read_file'
    state.activityFrame = 1
    state.runStartedAt = 1_000
    expect(activityLabel(state, 2_500)).toBe('⠙ Using read file · 1.5s')
  })

  it('calculates and clamps a replaceable transcript viewport', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const component = await ctx.plugin({ name: 'long-transcript', inject: ['tui'], apply(inner) {
      inner.tui.registerComponent({ id: 'test.transcript', slot: 'transcript', render: () => Array.from({ length: 100 }, (_, index) => `line ${index + 1}`) })
      inner.tui.registerComponent({ id: 'test.header', slot: 'header', render: () => ['header'] })
      inner.tui.registerComponent({ id: 'test.composer', slot: 'composer', render: () => ['composer'] })
      inner.tui.registerComponent({ id: 'test.status', slot: 'status', render: () => ['status'] })
    } })
    const state = baseState()
    state.height = 10
    let layout = layoutTuiFrame(ctx.tui, state, theme, false)
    expect(layout.viewports.transcript).toMatchObject({ height: 6, total: 100, top: 94, maxTop: 94 })
    state.viewports = { transcript: { top: 20, follow: false, unseen: 3 } }
    layout = layoutTuiFrame(ctx.tui, state, theme, false)
    expect(layout.viewports.transcript.top).toBe(20)
    state.viewports = { transcript: { top: 999, follow: false, unseen: 0 } }
    expect(layoutTuiFrame(ctx.tui, state, theme, false).viewports.transcript.top).toBe(94)
    await component.dispose()
    await service.dispose()
  })

  it('wraps long prompt input in the composer', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const contribution = await ctx.plugin({ name: 'default-components', inject: ['tui'], apply(inner) {
      for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
    } })
    const state = baseState()
    state.height = 12
    state.input = 'a'.repeat(100)
    state.cursor = state.input.length
    const layout = layoutTuiFrame(ctx.tui, state, theme, false)
    expect(layout.viewports.transcript.height).toBe(5)
    const promptLines = layout.output.split('\r\n').filter(line => line.includes('│ › ') && line.includes('a'))
    expect(promptLines).toHaveLength(2)
    await contribution.dispose()
    await service.dispose()
  })

  it('wraps long user messages in the transcript', () => {
    const renderer = defaultEventRenderers().find(item => item.id === 'deep-tui.default.event.start')
    const context = {
      state: baseState(), theme, width: 40, height: 24, color: false,
      style: (text: string) => text,
      fit: (text: string) => text,
      wrap: (text: string, target = 40) => wrap(text, target),
      renderRich: () => [],
    }
    const rendered = renderer?.render({ type: 'start', input: 'word '.repeat(20).trim() }, context)
    expect(rendered?.[0]).toBe('')
    expect(rendered?.[1]).toMatch(/^› /)
    expect(rendered?.[2]).toMatch(/^  /)
    expect(rendered?.length).toBeGreaterThan(3)
    for (const line of rendered ?? []) expect(line.length).toBeLessThanOrEqual(40)
  })

  it('wraps overlong renderer output at the frame boundary', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const contribution = await ctx.plugin({ name: 'wrapped-frame', inject: ['tui'], apply(inner) {
      for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
      inner.tui.registerEventRenderer({
        id: 'test.long-event', priority: 1_000,
        render: event => event.type === 'start' ? ['\u001b[38;2;255;0;0m' + 'x'.repeat(65) + '\u001b[39m'] : undefined,
      })
    } })
    const state = baseState()
    state.width = 40
    state.height = 16
    state.events = [{ type: 'start', input: 'ignored' }]
    const layout = layoutTuiFrame(ctx.tui, state, theme, true)
    const rows = layout.output.split('\r\n')
    expect(layout.viewports.transcript.total).toBe(2)
    expect(rows.every(line => visibleWidth(line) <= 40)).toBe(true)
    expect(rows.map(stripAnsi).join('\n')).toContain('x'.repeat(40))
    expect(rows.map(stripAnsi).join('\n')).toContain('x'.repeat(25))
    expect(layout.output).not.toContain('…')
    await contribution.dispose()
    await service.dispose()
  })

  it('reuses rendered transcript events while viewport and composer state change', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    let renders = 0
    const contribution = await ctx.plugin({ name: 'cached-default-transcript', inject: ['tui'], apply(inner) {
      for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
      inner.tui.registerEventRenderer({
        id: 'test.counted-event',
        priority: 100,
        render(event) {
          if (event.type !== 'start') return undefined
          renders += 1
          return [event.input]
        },
      })
    } })
    const state = baseState()
    state.events = [
      { type: 'start', input: 'first' },
      { type: 'start', input: 'second' },
    ]

    layoutTuiFrame(ctx.tui, state, theme, false)
    state.viewports = { transcript: { top: 0, follow: false, unseen: 0 } }
    layoutTuiFrame(ctx.tui, state, theme, false)
    expect(renders).toBe(2)

    state.input = 'typing must not rerender the transcript'
    state.cursor = state.input.length
    layoutTuiFrame(ctx.tui, state, theme, false)
    expect(renders).toBe(2)

    state.events = [state.events[0]!, { type: 'start', input: 'second updated' }]
    layoutTuiFrame(ctx.tui, state, theme, false)
    expect(renders).toBe(3)

    await contribution.dispose()
    await service.dispose()
  })

  it('invalidates only the hovered reasoning event', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    let renders = 0
    const contribution = await ctx.plugin({ name: 'event-local-hover-cache', inject: ['tui'], apply(inner) {
      for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
      for (const renderer of defaultEventRenderers()) inner.tui.registerEventRenderer(renderer)
      inner.tui.registerCodeHighlighter({ id: 'test.highlighter', highlight: () => undefined })
      inner.tui.registerEventRenderer({
        id: 'test.count-hover-events', mode: 'append', priority: 100,
        render(event) {
          if (event.type !== 'assistant-finish') return undefined
          renders += 1
          return []
        },
      })
    } })
    const state = baseState()
    state.events = Array.from({ length: 3 }, (_, index) => ({
      type: 'assistant-finish' as const,
      messageId: `reason-${index}`,
      reasoning: `Thought ${index}.`,
      text: `Answer ${index}.`,
    }))

    layoutTuiFrame(ctx.tui, state, theme, false)
    const initial = renders
    state.hoveredReasoning = 'reason-1'
    layoutTuiFrame(ctx.tui, state, theme, false)
    expect(renders - initial).toBe(1)

    await contribution.dispose()
    await service.dispose()
  })

  it('highlights only transcript events intersecting the viewport', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    let highlights = 0
    const contribution = await ctx.plugin({ name: 'virtual-transcript', inject: ['tui'], apply(inner) {
      for (const component of defaultComponents(inner.tui)) inner.tui.registerComponent(component)
      inner.tui.registerCodeHighlighter({
        id: 'test.highlighter',
        highlight(code) {
          highlights += 1
          return [{ spans: [{ text: code }] }]
        },
      })
      inner.tui.registerEventRenderer({
        id: 'test.highlight-event',
        render(event, render) {
          if (event.type !== 'assistant-finish') return undefined
          inner.tui.highlightCode(event.text, 'text', render)
          return [event.text]
        },
      })
    } })
    const state = baseState()
    state.height = 12
    state.events = Array.from({ length: 100 }, (_, index) => ({
      type: 'assistant-finish' as const, messageId: `m-${index}`, text: `line ${index}`,
    }))

    const first = layoutTuiFrame(ctx.tui, state, theme, false)
    expect(first.viewports.transcript.total).toBe(100)
    expect(first.output).toContain('line 99')
    expect(first.output).not.toContain('line 0 ')
    expect(highlights).toBeGreaterThan(0)
    expect(highlights).toBeLessThanOrEqual(first.viewports.transcript.height)
    const afterTail = highlights
    state.viewports = { transcript: { top: 0, follow: false, unseen: 0 } }
    const scrolled = layoutTuiFrame(ctx.tui, state, theme, false)
    expect(scrolled.viewports.transcript.total).toBe(100)
    expect(scrolled.output).toContain('line 0')
    expect(highlights - afterTail).toBeLessThanOrEqual(first.viewports.transcript.height)

    await contribution.dispose()
    await service.dispose()
  })

  it('emits terminal updates only for changed rows after the first frame', () => {
    expect(renderFrameUpdate(undefined, 'one\r\ntwo', 'BG')).toBe('\u001b[HBGone\r\ntwo\u001b[J\u001b[0m')
    expect(renderFrameUpdate('one\r\ntwo', 'one\r\nchanged', 'BG')).toBe(
      '\u001b[2;1H\u001b[2KBGchanged\u001b[0m',
    )
    expect(renderFrameUpdate('one\r\ntwo', 'one\r\ntwo', 'BG')).toBe('')
  })

  it('restores inline backgrounds to the active theme background', () => {
    const rendered = renderRichText([{
      spans: [{ text: 'inline', style: { background: '#ff0000' } }],
    }], 80, true, '#010203')

    expect(rendered).toEqual(['\u001b[48;2;255;0;0minline\u001b[48;2;1;2;3m'])
    expect(rendered[0]).not.toContain('\u001b[49m')
  })

  it('honors a live plugin-provided sidebar width', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const component = await ctx.plugin({ name: 'sized-sidebar', inject: ['tui'], apply(inner) {
      inner.tui.registerComponent({ id: 'test.transcript', slot: 'transcript', render: () => ['main'] })
      inner.tui.registerComponent({
        id: 'test.sidebar', slot: 'sidebar', preferredWidth: () => 50, render: () => ['side'],
      })
    } })
    const value = baseState()
    value.width = 130
    value.height = 12
    const body = layoutTuiFrame(ctx.tui, value, theme, false).output.split('\r\n')[2]

    expect(body?.indexOf('│')).toBe(79)
    expect(body).toHaveLength(130)

    await component.dispose()
    await service.dispose()
  })

  it('reveals the transcript line associated with a plugin-selected agent event', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const contribution = await ctx.plugin({ name: 'event-transcript', inject: ['tui'], apply(inner) {
      inner.tui.registerEventRenderer({
        id: 'test.start', render: event => event.type === 'start' ? [event.input] : undefined,
      })
      inner.tui.registerComponent({
        id: 'test.transcript', slot: 'transcript',
        render: render => render.state.events.flatMap(event => inner.tui.renderEvent(event, render)),
      })
      inner.tui.registerComponent({ id: 'test.header', slot: 'header', render: () => [] })
      inner.tui.registerComponent({ id: 'test.composer', slot: 'composer', render: () => [] })
      inner.tui.registerComponent({ id: 'test.status', slot: 'status', render: () => [] })
    } })
    const value = baseState()
    value.height = 12
    value.events = Array.from({ length: 30 }, (_, index) => ({ type: 'start' as const, input: `event ${index}` }))
    value.revealEventIndex = 10

    expect(layoutTuiFrame(ctx.tui, value, theme, false).viewports.transcript.top).toBe(10)

    await contribution.dispose()
    await service.dispose()
  })

  it('accounts usage on each model turn without double-counting the final run aggregate', () => {
    const first = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, contextTokens: 100, calculatedCostUsd: 0.001 }
    const second = { inputTokens: 200, cachedInputTokens: 150, outputTokens: 20, contextTokens: 250, calculatedCostUsd: 0.002 }
    const aggregate = { inputTokens: 300, cachedInputTokens: 210, outputTokens: 30, contextTokens: 250, calculatedCostUsd: 0.003 }
    const accounted = mergeUsage(mergeUsage({}, first), second)
    const liveSession = mergeUsage(mergeUsage({}, first), second)

    expect(mergeUsage(liveSession, unaccountedUsage(aggregate, accounted))).toEqual(aggregate)
    expect(unaccountedUsage(aggregate, {})).toEqual(aggregate)
  })

  it('discovers, executes, overrides, and unloads plugin slash commands', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const calls: string[] = []
    const state = baseState()
    state.input = '/gr'
    state.cursor = 3
    const actions: TuiActions = {
      state,
      setInput() {},
      async submit() {},
      exit() {},
      cancel: () => false,
      clear() {},
      cycleModel() {},
      setModel() {},
      notify() {},
      showOverlay() {},
      closeOverlay() {},
      moveSlashSelection() {},
      acceptSlashSuggestion: () => false,
      answerPermission() {},
      scrollViewport() {},
      pageViewport() {},
      followViewport() {},
      toggleReasoning() {},
      revealEvent() {},
      selectPermissionCandidate() {},
      async newConversation() {},
      async openConversation() {},
      async forkConversation() {},
      async renameConversation() {},
    }
    const defaults = await ctx.plugin({
      name: 'default-slash-command',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerSlashCommand({
          id: 'default.greet',
          name: 'greet',
          description: 'Default greeting.',
          priority: -100,
          run: args => { calls.push(`default:${args.join('|')}`) },
        })
      },
    })
    const override = await ctx.plugin({
      name: 'override-slash-command',
      inject: ['tui'],
      apply(inner) {
        inner.tui.registerSlashCommand({
          id: 'custom.greet',
          name: 'greet',
          description: 'Custom greeting.',
          priority: 10,
          run: args => { calls.push(`custom:${args.join('|')}`) },
        })
      },
    })

    expect(ctx.tui.slashSuggestions('/gr', state)[0]).toMatchObject({ label: '/greet' })
    expect(await ctx.tui.executeSlash('/greet "Ada Lovelace" now', actions)).toBe(true)
    expect(calls).toEqual(['custom:Ada Lovelace|now'])

    await override.dispose()
    await ctx.tui.executeSlash('/greet again', actions)
    expect(calls.at(-1)).toBe('default:again')

    await defaults.dispose()
    await service.dispose()
  })
})

function baseState(): TuiState {
  return {
    cwd: '.', width: 80, height: 24, provider: 'test', model: 'flash', models: ['flash', 'pro'],
    theme: 'default', contextWindow: 1_000_000, usage: {}, input: '', cursor: 0, slashSelection: 0,
    viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
}
