import type { Context } from 'cordis'
import type { TuiRenderContext } from '@flect/sdk'

export interface SearchTextRendererConfig {
  /** Show match previews in the transcript. Defaults to false for a compact exploration log. */
  showResults?: boolean
  /** Cap on visible matches. Default 80. */
  maxMatches?: number
  /** Cap on visible files. Default 20. */
  maxFiles?: number
  /** @deprecated Previews and labels are preserved and wrapped by the TUI. */
  maxLineLength?: number
  /** Show the tool name in the completion footer. Default true. */
  showToolName?: boolean
}

const EXPLORATION_TOOLS = new Set(['read_file', 'search_text', 'list_files', 'find_files'])

function explorationCall(
  event: Extract<TuiRenderContext['state']['events'][number], { type: 'tool-call' }>,
  render: TuiRenderContext,
  verb: string,
  detail: string,
): string[] {
  const index = render.state.events.indexOf(event)
  let first = true
  if (index >= 0) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = render.state.events[cursor]
      if (previous?.type === 'start') break
      if (previous?.type === 'tool-call' && EXPLORATION_TOOLS.has(previous.call.name)) {
        first = false
        break
      }
    }
  }
  return [
    ...(first ? [`  ${render.style('•', 'muted')} ${render.style('Explored', 'foreground', true)}`] : []),
    `${first ? '    └ ' : '      '}${render.style(verb, 'success')} ${detail}`,
  ]
}

export interface SearchTextMatch {
  path: string
  line: number
  column: number
  preview: string
}

export interface SearchTextResults {
  matches: readonly SearchTextMatch[]
  truncated: boolean
}

export interface RenderSearchTextOptions {
  query?: string
  toolName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decoded(output: unknown): unknown {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function sanitize(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function bounded(value: string, _limit: number): string {
  return sanitize(value)
}

function countLabel(count: number, noun: 'match' | 'file'): string {
  const plural = noun === 'match' ? 'matches' : 'files'
  return `${count} ${count === 1 ? noun : plural}`
}

/** Parse live structured search_text output or durable-session JSON. */
export function parseSearchTextOutput(output: unknown): SearchTextResults | undefined {
  const value = decoded(output)
  if (!isRecord(value) || !Array.isArray(value.matches)) return undefined
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') return undefined
  const matches: SearchTextMatch[] = []
  for (const match of value.matches) {
    if (!isRecord(match)
      || typeof match.path !== 'string' || !match.path
      || !positiveInteger(match.line) || !positiveInteger(match.column)
      || typeof match.preview !== 'string') return undefined
    matches.push({ path: match.path, line: match.line, column: match.column, preview: match.preview })
  }
  return { matches, truncated: value.truncated === true }
}

/** Render search matches grouped by file with compact line:column locations. */
export function renderSearchText(
  result: SearchTextResults,
  render: TuiRenderContext,
  config: SearchTextRendererConfig = {},
  options: RenderSearchTextOptions = {},
): string[] {
  const maxMatches = boundedInteger(config.maxMatches, 80, 1)
  const maxFiles = boundedInteger(config.maxFiles, 20, 1)
  const maxLineLength = boundedInteger(config.maxLineLength, 1_000, 40)
  const groups = new Map<string, SearchTextMatch[]>()
  for (const match of result.matches) {
    const existing = groups.get(match.path)
    if (existing) existing.push(match)
    else groups.set(match.path, [match])
  }

  const query = bounded(options.query?.trim() || 'text', maxLineLength)
  const header = `${JSON.stringify(query)} · ${countLabel(result.matches.length, 'match')} · ${countLabel(groups.size, 'file')}`
  const output = [`  ${render.style('┌', 'accent', true)} ${render.style(header, 'accent', true)}`]
  let shown = 0
  let shownFiles = 0

  if (!result.matches.length) {
    output.push(`  │ ${render.style('(no matches)', 'muted')}`)
  } else {
    for (const [path, matches] of groups) {
      if (shownFiles >= maxFiles || shown >= maxMatches) break
      const visible = matches.slice(0, maxMatches - shown)
      shownFiles += 1
      shown += visible.length
      output.push(`  │ ${render.style(bounded(path, maxLineLength), 'accent', true)} · ${countLabel(matches.length, 'match')}`)
      const gutter = visible.reduce((width, match) => Math.max(width, `${match.line}:${match.column}`.length), 1)
      for (const match of visible) {
        const location = `${match.line}:${match.column}`.padStart(gutter)
        const preview = bounded(match.preview.trim(), maxLineLength) || '(blank line)'
        output.push(`  │   ${render.style(location, 'muted')} │ ${preview}`)
      }
    }
  }

  const omitted = result.matches.length - shown
  if (omitted > 0) output.push(`  │ ${render.style(`[${countLabel(omitted, 'match')} omitted]`, 'warning')}`)
  if (result.truncated) output.push(`  │ ${render.style('[additional matches truncated by tool]', 'warning')}`)
  const tool = config.showToolName !== false && options.toolName ? ` ${options.toolName}` : ''
  output.push(`  ${render.style('└', 'success', true)} ${render.style(`✓${tool}`, 'success', true)}`)
  return output
}

function argument(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export const name = 'search-text-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: SearchTextRendererConfig = {}): void {
  const maxLineLength = boundedInteger(config.maxLineLength, 1_000, 40)
  ctx.tui.registerEventRenderer({
    id: 'flect.search-text.tool-call',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-call' || event.call.name !== 'search_text') return undefined
      const query = bounded(argument(event.call.arguments.query, 'text'), maxLineLength)
      const target = bounded(argument(event.call.arguments.path, 'workspace'), maxLineLength)
      const pattern = bounded(argument(event.call.arguments.pattern, '**/*'), maxLineLength)
      const detail = `${render.style(query, 'foreground')} ${render.style('in', 'muted')} ${render.style(target, 'foreground')}`
        + (pattern === '**/*' ? '' : ` ${render.style(`· ${pattern}`, 'muted')}`)
      return explorationCall(event, render, 'Search', detail)
    },
  })

  ctx.tui.registerEventRenderer({
    id: 'flect.search-text.tool-result',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-result' || event.call.name !== 'search_text') return undefined
      const result = parseSearchTextOutput(event.output)
      if (!result) return undefined
      if (config.showResults !== true) return []
      return renderSearchText(result, render, config, {
        query: argument(event.call.arguments.query, 'text'),
        toolName: event.call.name,
      })
    },
  })
}

export default { name, inject, apply }
