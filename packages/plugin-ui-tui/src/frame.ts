import type {
  AgentEvent,
  Theme,
  TuiComponent,
  TuiEventRenderer,
  TuiRenderContext,
  TuiService,
  TuiState,
  TuiViewportMetrics,
} from '@flect/sdk'
import { describeToolCall } from '@flect/sdk'
import { fit, renderRichText, style, visibleWidth, wrap, wrapAnsi } from './ansi.js'

const activityFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function activityGlyph(state: Readonly<TuiState>): string {
  return activityFrames[(state.activityFrame ?? 0) % activityFrames.length] ?? '⠋'
}

export function activityLabel(state: Readonly<TuiState>, now = Date.now()): string {
  const raw = state.status || 'thinking'
  const description = raw === 'thinking'
    ? 'Thinking'
    : raw === 'cancelling'
      ? 'Cancelling'
      : raw === 'permission required'
        ? 'Waiting for permission'
        : raw.startsWith('running ')
          ? `Using ${raw.slice('running '.length).replace(/_/g, ' ')}`
          : raw.startsWith('finished ')
            ? `Finished ${raw.slice('finished '.length).replace(/_/g, ' ')}`
            : `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`
  const elapsedMs = Math.max(0, now - (state.runStartedAt ?? now))
  const elapsed = elapsedMs < 10_000 ? `${(elapsedMs / 1_000).toFixed(1)}s` : `${Math.floor(elapsedMs / 1_000)}s`
  return `${activityGlyph(state)} ${description} · ${elapsed}`
}

function context(state: Readonly<TuiState>, theme: Theme, width: number, height: number, color: boolean): TuiRenderContext {
  return {
    state,
    theme,
    width,
    height,
    color,
    phase: 'display',
    style: (text, tone, bold) => style(theme, color, text, tone, bold),
    fit: (text, target = width) => fit(text, target),
    wrap: (text, target = width) => wrap(text, target),
    renderRich: (lines, target = width) => renderRichText(lines, target, color, theme.tokens.colors.background),
  }
}

function renderSlot(
  tui: TuiService,
  slot: string,
  state: Readonly<TuiState>,
  theme: Theme,
  width: number,
  height: number,
  color: boolean,
): readonly string[] {
  const component = tui.component(slot)
  if (!component) return []
  return component.render(context(state, theme, width, height, color))
}

interface WrappedPrompt {
  lines: string[]
  cursorLine: number
  cursorColumn: number
}

/**
 * Wrap prompt text one character at a time so the cursor position can be
 * mapped to a rendered line. Cursor columns are UTF-16 offsets, matching
 * `TuiState.cursor`.
 */
function wrapPrompt(value: string, cursor: number, width: number): WrappedPrompt {
  const lines: string[] = []
  let line = ''
  let lineWidth = 0
  let cursorLine = 0
  let cursorColumn = 0

  const markCursor = (column = line.length) => {
    cursorLine = lines.length
    cursorColumn = column
  }

  if (cursor <= 0) markCursor(0)

  let index = 0
  while (index < value.length) {
    const codePoint = value.codePointAt(index)
    const character = codePoint === undefined ? value[index] ?? '' : String.fromCodePoint(codePoint)
    if (!character) break
    const characterWidth = visibleWidth(character)

    if (character === '\n') {
      if (index === cursor) markCursor(line.length)
      lines.push(line)
      line = ''
      lineWidth = 0
      index += character.length
      continue
    }

    if (line && lineWidth + characterWidth > width) {
      lines.push(line)
      line = ''
      lineWidth = 0
    }

    if (index === cursor) markCursor(line.length)
    line += character
    lineWidth += characterWidth
    index += character.length
  }

  if (cursor >= value.length) markCursor(line.length)
  lines.push(line)
  return { lines, cursorLine, cursorColumn }
}

function rows(lines: readonly string[], width: number, height: number, fromBottom = false): string[] {
  const wrapped = lines.flatMap(line => wrapAnsi(line, width))
  const selected = fromBottom ? wrapped.slice(-height) : wrapped.slice(0, height)
  const padding = Array.from({ length: Math.max(0, height - selected.length) }, () => '')
  const combined = fromBottom ? [...padding, ...selected] : [...selected, ...padding]
  return combined.map(line => fit(line, width))
}

function flowRows(lines: readonly string[], width: number, minimumHeight = 0): string[] {
  const wrapped = lines.flatMap(line => wrapAnsi(line, width))
  return [
    ...wrapped.map(line => fit(line, width)),
    ...Array.from({ length: Math.max(0, minimumHeight - wrapped.length) }, () => fit('', width)),
  ]
}

function viewportRows(
  lines: readonly string[],
  width: number,
  height: number,
  state: Readonly<TuiState>,
  requestedTop?: number,
): { lines: string[]; metrics: TuiViewportMetrics } {
  const wrapped = lines.flatMap(line => wrapAnsi(line, width))
  const viewport = state.viewports.transcript ?? { top: 0, follow: true, unseen: 0 }
  const maxTop = Math.max(0, wrapped.length - height)
  const top = requestedTop === undefined
    ? (viewport.follow ? maxTop : Math.max(0, Math.min(viewport.top, maxTop)))
    : Math.max(0, Math.min(requestedTop, maxTop))
  const selected = wrapped.slice(top, top + height).map(line => fit(line, width))
  const padding = Array.from({ length: Math.max(0, height - selected.length) }, () => fit('', width))
  return {
    lines: viewport.follow && state.events.length > 0 ? [...padding, ...selected] : [...selected, ...padding],
    metrics: { id: 'transcript', top, height, total: wrapped.length, maxTop },
  }
}

function eventLineOffset(
  tui: TuiService,
  state: Readonly<TuiState>,
  theme: Theme,
  width: number,
  height: number,
  color: boolean,
): number | undefined {
  if (state.revealEventIndex === undefined) return undefined
  const render = context(state, theme, width, height, color)
  return state.events.slice(0, Math.max(0, state.revealEventIndex))
    .reduce((total, event) => total + tui.renderEvent(event, render).length, 0)
}

function reasoningDisclosure(event: AgentEvent, ctx: TuiRenderContext): string[] | undefined {
  if (event.type !== 'assistant-finish') return undefined
  const reasoning = event.reasoning?.trim()
  if (!reasoning) return undefined
  const expanded = Boolean(ctx.state.expandedReasoning?.[event.messageId])
  const hovered = ctx.state.hoveredReasoning === event.messageId
  const wordCount = reasoning.split(/\s+/).filter(Boolean).length
  const detail = ctx.state.busy && !event.text ? 'streaming' : `${wordCount} word${wordCount === 1 ? '' : 's'}`
  const header = ctx.style(
    `  ${expanded ? '▾' : '▸'} Thinking · ${detail}${expanded ? '' : ' · ctrl+t or click to expand'}`,
    expanded || hovered ? 'accent' : 'muted',
    expanded || hovered,
  )
  const thought = expanded
    ? ctx.wrap(reasoning, Math.max(12, ctx.width - 8)).map(line => ctx.style(`    ${line}`, 'muted'))
    : []
  return [header, ...thought, ...(event.text ? [''] : [])]
}

function overlay(base: string[], modal: readonly string[], width: number): void {
  if (!modal.length || !base.length) return
  const startRow = Math.max(0, Math.floor((base.length - modal.length) / 2))
  for (let index = 0; index < modal.length && startRow + index < base.length; index += 1) {
    const line = modal[index] ?? ''
    const lineWidth = Math.min(width, visibleWidth(line))
    const left = Math.max(0, Math.floor((width - lineWidth) / 2))
    base[startRow + index] = fit(`${' '.repeat(left)}${line}`, width)
  }
}

function overlayBottom(base: string[], popup: readonly string[], width: number): void {
  if (!popup.length || !base.length) return
  const visible = popup.slice(-base.length)
  const start = base.length - visible.length
  for (let index = 0; index < visible.length; index += 1) {
    base[start + index] = fit(visible[index] ?? '', width)
  }
}

export interface TuiFrameLayout {
  output: string
  viewports: Readonly<Record<string, TuiViewportMetrics>>
  transcriptBounds: { x: number; y: number; width: number; height: number }
  interactions: readonly TuiInteractionRegion[]
}

export interface TuiInteractionRegion {
  kind: 'reasoning'
  messageId: string
  x: number
  y: number
  width: number
}

interface TranscriptSnapshot {
  events: readonly AgentEvent[]
  width: number
  height: number
  requestedTop?: number
  reasoning: readonly { line: number; messageId: string; width: number }[]
}

const transcriptSnapshots = new WeakMap<object, TranscriptSnapshot>()
const frameLayouts = new WeakMap<object, TuiFrameLayout>()

export function layoutTuiFrame(
  tui: TuiService,
  state: Readonly<TuiState>,
  theme: Theme,
  color: boolean,
): TuiFrameLayout {
  const width = Math.max(40, state.width)
  const height = Math.max(12, state.height)
  const header = flowRows(renderSlot(tui, 'header', state, theme, width, 2, color), width, 2)
  const status = flowRows(renderSlot(tui, 'status', state, theme, width, 1, color), width, 1)
  const maxComposerHeight = Math.max(1, height - header.length - status.length - 1)
  const composerRendered = renderSlot(tui, 'composer', state, theme, width, maxComposerHeight, color)
  const composerHeight = Math.max(3, Math.min(composerRendered.length, maxComposerHeight))
  const composer = composerRendered.length > composerHeight
    ? rows(composerRendered, width, composerHeight, true)
    : rows(composerRendered, width, composerHeight)
  const bodyHeight = Math.max(1, height - header.length - composer.length - status.length)
  let body: string[]
  let transcriptMetrics: TuiViewportMetrics
  let transcriptWidth: number
  let transcriptSnapshot: TranscriptSnapshot | undefined

  const sidebarComponent = width >= 96 ? tui.component('sidebar') : undefined
  const fallbackSidebarWidth = Math.min(34, Math.floor(width * 0.32))
  const requestedSidebarWidth = sidebarComponent?.preferredWidth?.(state) ?? fallbackSidebarWidth
  const finiteSidebarWidth = Number.isFinite(requestedSidebarWidth) ? requestedSidebarWidth : fallbackSidebarWidth
  const sidebarWidth = Math.max(20, Math.min(Math.max(20, width - 41), Math.round(finiteSidebarWidth)))
  const sidebarCandidate = sidebarComponent
    ? renderSlot(tui, 'sidebar', state, theme, sidebarWidth, bodyHeight, color)
    : []
  if (sidebarCandidate.length) {
    const mainWidth = width - sidebarWidth - 1
    transcriptWidth = mainWidth
    const transcriptLines = renderSlot(tui, 'transcript', state, theme, mainWidth, bodyHeight, color)
    const candidate = transcriptSnapshots.get(state as object)
    transcriptSnapshot = tui.component('transcript')?.id === 'flect.default.transcript'
      && candidate?.events === state.events && candidate.width === mainWidth && candidate.height === bodyHeight
      ? candidate
      : undefined
    const requestedTop = transcriptSnapshot?.requestedTop
      ?? eventLineOffset(tui, state, theme, mainWidth, bodyHeight, color)
    const viewport = viewportRows(
      transcriptLines,
      mainWidth, bodyHeight, state, requestedTop,
    )
    const transcript = viewport.lines
    transcriptMetrics = viewport.metrics
    const sidebar = rows(sidebarCandidate, sidebarWidth, bodyHeight)
    body = transcript.map((line, index) => `${line}${style(theme, color, '│', 'muted')}${sidebar[index] ?? ''}`)
  } else {
    transcriptWidth = width
    const transcriptLines = renderSlot(tui, 'transcript', state, theme, width, bodyHeight, color)
    const candidate = transcriptSnapshots.get(state as object)
    transcriptSnapshot = tui.component('transcript')?.id === 'flect.default.transcript'
      && candidate?.events === state.events && candidate.width === width && candidate.height === bodyHeight
      ? candidate
      : undefined
    const requestedTop = transcriptSnapshot?.requestedTop
      ?? eventLineOffset(tui, state, theme, width, bodyHeight, color)
    const viewport = viewportRows(
      transcriptLines,
      width, bodyHeight, state, requestedTop,
    )
    body = viewport.lines
    transcriptMetrics = viewport.metrics
  }

  const slashSuggestions = tui.slashSuggestions(state.input, state)
  if (state.approval || state.overlay) {
    overlay(body, renderSlot(tui, 'modal', state, theme, Math.min(72, width - 4), bodyHeight, color), width)
  } else if (slashSuggestions.length) {
    overlayBottom(body, renderSlot(tui, 'autocomplete', state, theme, width, bodyHeight, color), width)
  }

  const visibleCount = Math.min(
    transcriptMetrics.height,
    Math.max(0, transcriptMetrics.total - transcriptMetrics.top),
  )
  const transcriptViewport = state.viewports.transcript ?? { top: 0, follow: true, unseen: 0 }
  const paddingTop = transcriptViewport.follow && state.events.length > 0
    ? Math.max(0, transcriptMetrics.height - visibleCount)
    : 0
  const interactions: TuiInteractionRegion[] = (transcriptSnapshot?.reasoning ?? []).flatMap(target => {
    if (target.line < transcriptMetrics.top || target.line >= transcriptMetrics.top + visibleCount) return []
    return [{
      kind: 'reasoning' as const,
      messageId: target.messageId,
      x: 1,
      y: header.length + 1 + paddingTop + target.line - transcriptMetrics.top,
      width: target.width,
    }]
  })
  const layout: TuiFrameLayout = {
    output: [...header, ...body, ...composer, ...status].slice(0, height).join('\r\n'),
    viewports: { transcript: transcriptMetrics },
    transcriptBounds: { x: 1, y: header.length + 1, width: transcriptWidth, height: bodyHeight },
    interactions,
  }
  frameLayouts.set(state as object, layout)
  return layout
}

/** Resolve a click on a visible Thinking header to its assistant message. */
export function reasoningMessageAt(
  tui: TuiService,
  state: Readonly<TuiState>,
  theme: Theme,
  color: boolean,
  x: number,
  y: number,
): string | undefined {
  if (state.approval || state.overlay || tui.slashSuggestions(state.input, state).length) return undefined
  const layout = frameLayouts.get(state as object) ?? layoutTuiFrame(tui, state, theme, color)
  const bounds = layout.transcriptBounds
  if (x < bounds.x || x >= bounds.x + bounds.width || y < bounds.y || y >= bounds.y + bounds.height) return undefined
  const target = layout.interactions.find(region =>
    region.kind === 'reasoning' && y === region.y && x >= region.x && x < region.x + region.width)
  return target?.messageId
}

export function renderTuiFrame(
  tui: TuiService,
  state: Readonly<TuiState>,
  theme: Theme,
  color: boolean,
): string {
  return layoutTuiFrame(tui, state, theme, color).output
}

function sides(left: string, right: string, width: number): string[] {
  const space = width - visibleWidth(left) - visibleWidth(right)
  if (space >= 1) return [`${left}${' '.repeat(space)}${right}`]
  return [
    ...wrapAnsi(left, width),
    ...wrapAnsi(right, width).map(line => `${' '.repeat(Math.max(0, width - visibleWidth(line)))}${line}`),
  ]
}

function border(label: string, width: number): string {
  const middle = `─ ${label} `
  return `╭${middle}${'─'.repeat(Math.max(0, width - visibleWidth(middle) - 2))}╮`
}

export function defaultComponents(tui: TuiService): TuiComponent[] {
  interface CachedEvent {
    signature: readonly unknown[]
    lines: readonly string[]
  }

  const measuredEventCache = new WeakMap<object, CachedEvent>()
  const displayedEventCache = new WeakMap<object, CachedEvent>()
  const sameSignature = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  // Cache interaction state per event. Moving between reasoning headers should
  // invalidate those two events, not every historical Markdown and diff block.
  const eventSignature = (
    event: AgentEvent,
    ctx: TuiRenderContext,
    phase: 'measure' | 'display',
  ): readonly unknown[] => [
    tui.revision,
    ctx.theme,
    ctx.width,
    ctx.height,
    ctx.color,
    event.type === 'assistant-finish' && !event.text ? ctx.state.busy : false,
    event.type === 'assistant-finish'
      ? Boolean(ctx.state.expandedReasoning?.[event.messageId])
      : false,
    phase === 'display' && event.type === 'assistant-finish'
      ? ctx.state.hoveredReasoning === event.messageId
      : false,
    phase,
  ]
  const renderCached = (
    event: AgentEvent,
    ctx: TuiRenderContext,
    phase: 'measure' | 'display',
    cache: WeakMap<object, CachedEvent>,
  ): readonly string[] => {
    const signature = eventSignature(event, ctx, phase)
    const cached = cache.get(event)
    if (cached && sameSignature(cached.signature, signature)) return cached.lines
    const lines = [...tui.renderEvent(event, ctx)].flatMap(line => wrapAnsi(line, ctx.width))
    cache.set(event, { signature, lines })
    return lines
  }

  return [
    {
      id: 'flect.default.header',
      slot: 'header',
      priority: -100,
      render(ctx) {
        const brand = ctx.style('flect', 'accent', true)
        const model = ctx.style(`${ctx.state.provider}/${ctx.state.model}`, 'muted')
        const cwd = ctx.style(ctx.state.cwd, 'muted')
        return [...sides(` ${brand}  ${cwd}`, model, ctx.width), ctx.style('─'.repeat(ctx.width), 'muted')]
      },
    },
    {
      id: 'flect.default.transcript',
      slot: 'transcript',
      priority: -100,
      render(ctx) {
        if (!ctx.state.events.length) {
          return tui.listEmptyStateSections().flatMap(section => section.render(ctx) ?? [])
        }

        const virtual = tui.listCodeHighlighters().length > 0
        const measure = virtual ? { ...ctx, phase: 'measure' as const } : ctx
        const blocks = ctx.state.events.map((event, index) => ({
          event,
          index,
          lines: renderCached(event, measure, 'measure', measuredEventCache),
          start: 0,
        }))
        let total = 0
        for (const block of blocks) {
          block.start = total
          total += block.lines.length
        }
        const viewport = ctx.state.viewports.transcript ?? { top: 0, follow: true, unseen: 0 }
        const maxTop = Math.max(0, total - ctx.height)
        const reveal = ctx.state.revealEventIndex === undefined
          ? undefined
          : blocks[Math.max(0, ctx.state.revealEventIndex)]?.start
        const top = reveal === undefined
          ? (viewport.follow ? maxTop : Math.max(0, Math.min(viewport.top, maxTop)))
          : Math.max(0, Math.min(reveal, maxTop))
        const bottom = top + ctx.height
        const reasoning: Array<{ line: number; messageId: string; width: number }> = []
        const lines: string[] = []
        for (const block of blocks) {
          const visible = block.start < bottom && block.start + block.lines.length > top
          const rendered = virtual && visible
            ? renderCached(block.event, ctx, 'display', displayedEventCache)
            : block.lines
          const start = lines.length
          lines.push(...rendered)
          if (visible && block.event.type === 'assistant-finish') {
            const disclosure = reasoningDisclosure(block.event, ctx)
            const header = disclosure?.[0] ? wrapAnsi(disclosure[0], ctx.width)[0] : undefined
            const offset = header ? rendered.indexOf(header) : -1
            if (header && offset >= 0) reasoning.push({
              line: start + offset,
              messageId: block.event.messageId,
              width: Math.min(ctx.width, visibleWidth(header)),
            })
          }
        }
        transcriptSnapshots.set(ctx.state as object, {
          events: ctx.state.events,
          width: ctx.width,
          height: ctx.height,
          ...(reveal === undefined ? {} : { requestedTop: reveal }),
          reasoning,
        })
        return lines
      },
    },
    {
      id: 'flect.default.composer',
      slot: 'composer',
      priority: -100,
      render(ctx) {
        const width = ctx.width
        const label = ctx.state.busy ? ` ${activityGlyph(ctx.state)} Working ` : ' Prompt '
        const top = ctx.style(border(label, width), ctx.state.busy ? 'warning' : 'accent')
        const cursor = ctx.style('▏', 'accent', true)
        const borderLeft = ctx.style('│', 'accent')
        const prompt = ctx.style('›', 'accent', true)
        const prefix = `${borderLeft} ${prompt} `
        const fitLine = (line: string) => fit(`${prefix}${line}`, width - 1) + borderLeft
        const hint = ctx.state.input.startsWith('/')
          ? ' tab complete · ↑↓ select · enter run · esc close '
          : ' enter send · ctrl+p model · ctrl+l clear · ctrl+c quit '
        const hintLines = wrap(hint.trim(), Math.max(1, width - 4))
        const bottom = hintLines.length === 1
          ? [ctx.style(`╰${'─'.repeat(Math.max(0, width - visibleWidth(hint) - 2))}${hint}╯`, 'muted')]
          : [
            ...hintLines.map(line => ctx.style(`│ ${fit(line, width - 4)} │`, 'muted')),
            ctx.style(`╰${'─'.repeat(width - 2)}╯`, 'muted'),
          ]
        if (ctx.state.approval) {
          const approval = wrap('Answer the permission request above', Math.max(1, width - visibleWidth(prefix) - 2))
          return [top, ...approval.map(line => fitLine(ctx.style(line, 'muted'))), ...bottom]
        }

        // Reserve one column for the cursor so it stays visible at the end of a
        // completely full prompt line instead of being truncated by `fit()`.
        const textWidth = Math.max(1, width - visibleWidth(prefix) - 2)
        const wrapped = wrapPrompt(ctx.state.input, ctx.state.cursor, textWidth)
        const inputLines = wrapped.lines.map((line, index) => {
          if (index !== wrapped.cursorLine) return fitLine(line)
          const before = line.slice(0, wrapped.cursorColumn)
          const after = line.slice(wrapped.cursorColumn)
          return fitLine(`${before}${cursor}${after}`)
        })
        return [top, ...inputLines, ...bottom]
      },
    },
    {
      id: 'flect.default.status',
      slot: 'status',
      priority: -100,
      render(ctx) {
        const statusItems = tui.listStatusItems().map(item => ({ item, text: item.render(ctx) }))
        const leftItems = statusItems.flatMap(({ item, text }) =>
          text && (item.align ?? 'left') === 'left' ? [text] : [])
        const rightItems = statusItems.flatMap(({ item, text }) =>
          text && item.align === 'right' ? [text] : [])
        const viewport = ctx.state.viewports.transcript
        const scroll = viewport && !viewport.follow
          ? ctx.style(` ↑ ${viewport.unseen} new · End to follow`, 'accent')
          : ''
        const message = ctx.state.error
          ? ctx.style(` error: ${ctx.state.error}`, 'danger')
          : ctx.state.notice
            ? ctx.style(` ${ctx.state.notice}`, 'warning')
            : ctx.style(` ${ctx.state.busy ? activityLabel(ctx.state) : ctx.state.status}`, ctx.state.busy ? 'warning' : 'muted')
        const left = `${leftItems.length ? ` ${leftItems.join(' · ')} ·` : ''}${message}${scroll}`
        const right = rightItems.length ? ` ${rightItems.join(' · ')} ` : ''
        return sides(left, right, ctx.width)
      },
    },
    {
      id: 'flect.default.autocomplete',
      slot: 'autocomplete',
      priority: -100,
      render(ctx) {
        const all = tui.slashSuggestions(ctx.state.input, ctx.state)
        if (!all.length) return []
        const selectedIndex = ctx.state.slashSelection % all.length
        const start = Math.min(Math.max(0, selectedIndex - 7), Math.max(0, all.length - 8))
        const suggestions = all.slice(start, start + 8)
        const width = Math.min(ctx.width, 76)
        const inner = width - 4
        const output = [ctx.style(`╭─ Commands ${'─'.repeat(Math.max(0, width - 13))}╮`, 'accent', true)]
        for (let index = 0; index < suggestions.length; index += 1) {
          const suggestion = suggestions[index]
          if (!suggestion) continue
          const selected = start + index === selectedIndex
          const marker = selected ? ctx.style('›', 'accent', true) : ' '
          const label = selected ? ctx.style(suggestion.label, 'accent', true) : suggestion.label
          const description = ctx.style(suggestion.description, 'muted')
          const wrapped = wrapAnsi(`${marker} ${label} ${description}`, inner)
          for (const line of wrapped) {
            output.push(`${ctx.style('│', 'accent')} ${fit(line, inner)} ${ctx.style('│', 'accent')}`)
          }
        }
        output.push(ctx.style(`╰${'─'.repeat(width - 2)}╯`, 'accent'))
        return output
      },
    },
    {
      id: 'flect.default.permission-modal',
      slot: 'modal',
      priority: -100,
      render(ctx) {
        const request = ctx.state.approval
        const presented = ctx.state.overlay
        if (!request && !presented) return []
        const width = Math.min(ctx.width, 68)
        const inner = width - 4
        if (presented) {
          const tone = presented.tone ?? 'accent'
          const titleFits = visibleWidth(presented.title) <= width - 5
          const top = titleFits
            ? ctx.style(`╭─ ${presented.title} ${'─'.repeat(Math.max(0, width - visibleWidth(presented.title) - 5))}╮`, tone, true)
            : ctx.style(`╭${'─'.repeat(width - 2)}╮`, tone)
          const titleLines = titleFits ? [] : wrapAnsi(ctx.style(presented.title, tone, true), inner)
          const lines = [...titleLines, ...presented.lines.flatMap(line => ctx.wrap(line, inner))]
            .map(line => `${ctx.style('│', tone)} ${fit(line, inner)} ${ctx.style('│', tone)}`)
          lines.push(`${ctx.style('│', tone)} ${fit(ctx.style('esc close', 'muted'), inner)} ${ctx.style('│', tone)}`)
          return [top, ...lines, ctx.style(`╰${'─'.repeat(width - 2)}╯`, tone)]
        }
        if (!request) return []
        const description = ctx.wrap(request.description, inner)
        const top = ctx.style(`╭─ Permission ${'─'.repeat(Math.max(0, width - 15))}╮`, 'warning', true)
        const boxed = (value: string) => wrapAnsi(value, inner)
          .map(line => `${ctx.style('│', 'warning')} ${fit(line, inner)} ${ctx.style('│', 'warning')}`)
        const lines = description.flatMap(line => boxed(line))
        const risk = `${request.risk.toUpperCase()} · ${request.capability}`
        lines.push(...boxed(ctx.style(risk, 'muted')))
        const remember = request.remember?.length
          ? `   ${ctx.style('s', 'accent', true)} session   ${ctx.style('p', 'accent', true)} project`
          : ''
        lines.push(...boxed(`${ctx.style('y', 'success', true)} once${remember}   ${ctx.style('n', 'danger', true)} deny`))
        const candidates = request.remember ?? []
        const candidate = candidates[(ctx.state.permissionSelection ?? 0) % Math.max(1, candidates.length)]
        if (candidate) {
          const choose = candidates.length > 1 ? ' · tab changes scope' : ''
          lines.push(...boxed(ctx.style(`don't ask again: ${candidate.label}${choose}`, 'muted')))
        }
        return [top, ...lines, ctx.style(`╰${'─'.repeat(width - 2)}╯`, 'warning')]
      },
    },
  ]
}

export function defaultEventRenderers(): TuiEventRenderer[] {
  return [
    {
      id: 'flect.default.event.start', priority: -100,
      render(event, ctx) {
        if (event.type !== 'start') return undefined
        const prefix = `${ctx.style('›', 'accent', true)} `
        const lines = ctx.wrap(event.input, Math.max(12, ctx.width - 4))
          .map((line, index) => index === 0 ? `${prefix}${line}` : `  ${line}`)
        return ['', ...lines, '']
      },
    },
    {
      id: 'flect.default.event.assistant', priority: -100,
      render(event, ctx) {
        if (event.type !== 'assistant' && event.type !== 'assistant-finish') return undefined
        return event.text
          ? ctx.wrap(event.text, Math.max(12, ctx.width - 4)).map(line => `  ${line}`)
          : []
      },
    },
    {
      id: 'flect.default.event.reasoning', mode: 'prepend', priority: -100,
      render(event, ctx) {
        return reasoningDisclosure(event, ctx)
      },
    },
    {
      id: 'flect.default.event.tool-call', priority: -100,
      render(event, ctx) {
        if (event.type !== 'tool-call') return undefined
        const label = describeToolCall(event.call)
        const output = [ctx.style(`  ┌ ${label}`, 'muted')]
        if (label === event.call.name) {
          const serialized = JSON.stringify(event.call.arguments)
          output.push(...ctx.wrap(serialized, Math.max(12, ctx.width - 6)).map(line => ctx.style(`  │ ${line}`, 'muted')))
        }
        return output
      },
    },
    {
      id: 'flect.default.event.tool-result', priority: -100,
      render(event, ctx) {
        if (event.type !== 'tool-result') return undefined
        return [ctx.style(`  └ ✓ ${describeToolCall(event.call)}`, 'success')]
      },
    },
    {
      id: 'flect.default.event.finish', priority: -100,
      render(event, ctx) {
        if (event.type !== 'finish') return undefined
        if (event.status === 'limit-reached') {
          return ['', ctx.style(`  stopped after ${event.steps} steps · configured step limit reached`, 'warning')]
        }
        return ['', ctx.style(`  finished in ${event.steps} step${event.steps === 1 ? '' : 's'}`, 'muted')]
      },
    },
  ]
}
