import type { Context } from 'cordis'
import type { TuiRenderContext } from '@deep-tui/sdk'

export interface FilesRendererConfig {
  /** Show discovered entries in the transcript. Defaults to false for a compact exploration log. */
  showResults?: boolean
  /** Cap on visible result entries. Default 80. */
  maxEntries?: number
  /** @deprecated Paths and labels are preserved and wrapped by the TUI. */
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

export interface FileResults {
  files: readonly string[]
  truncated: boolean
}

export interface RenderFileResultsOptions {
  label?: string
  noun?: 'entry' | 'file'
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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return value as string[]
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

function bounded(value: string, _limit: number): string {
  return sanitize(value)
}

function countLabel(count: number, noun: 'entry' | 'file'): string {
  const plural = noun === 'entry' ? 'entries' : 'files'
  return `${count} ${count === 1 ? noun : plural}`
}

function pathLine(value: string, render: TuiRenderContext, maxLineLength: number): string {
  const path = bounded(value, maxLineLength)
  const directory = path.endsWith('/')
  const marker = render.style(directory ? '▸' : '•', directory ? 'accent' : 'muted', directory)
  const normalized = directory ? path.slice(0, -1) : path
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  const parent = separator >= 0 ? normalized.slice(0, separator + 1) : ''
  const leaf = normalized.slice(separator + 1) || normalized
  const display = `${parent ? render.style(parent, 'muted') : ''}${render.style(`${leaf}${directory ? '/' : ''}`, directory ? 'accent' : 'foreground', directory)}`
  return `  │ ${marker} ${display}`
}

/** Parse live and durable list_files results. */
export function parseListFilesOutput(output: unknown): FileResults | undefined {
  const files = stringArray(decoded(output))
  return files ? { files, truncated: false } : undefined
}

/** Parse live and durable find_files results. */
export function parseFindFilesOutput(output: unknown): FileResults | undefined {
  const value = decoded(output)
  if (!isRecord(value)) return undefined
  const files = stringArray(value.files)
  if (!files || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return undefined
  return { files, truncated: value.truncated === true }
}

/** Render list_files/find_files results as a bounded, compact file box. */
export function renderFileResults(
  result: FileResults,
  render: TuiRenderContext,
  config: FilesRendererConfig = {},
  options: RenderFileResultsOptions = {},
): string[] {
  const maxEntries = boundedInteger(config.maxEntries, 80, 1)
  const maxLineLength = boundedInteger(config.maxLineLength, 4_000, 40)
  const noun = options.noun ?? 'file'
  const label = bounded(options.label?.trim() || 'workspace', maxLineLength)
  const visible = result.files.slice(0, maxEntries)
  const omitted = result.files.length - visible.length
  const output = [
    `  ${render.style('┌', 'accent', true)} ${render.style(label, 'accent', true)} · ${countLabel(result.files.length, noun)}`,
  ]

  if (!result.files.length) output.push(`  │ ${render.style('(no files)', 'muted')}`)
  else output.push(...visible.map(file => pathLine(file, render, maxLineLength)))
  if (omitted > 0) output.push(`  │ ${render.style(`[${countLabel(omitted, noun)} omitted]`, 'warning')}`)
  if (result.truncated) output.push(`  │ ${render.style('[additional results truncated by tool]', 'warning')}`)

  const tool = config.showToolName !== false && options.toolName ? ` ${options.toolName}` : ''
  output.push(`  ${render.style('└', 'success', true)} ${render.style(`✓${tool}`, 'success', true)}`)
  return output
}

function argument(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export const name = 'files-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: FilesRendererConfig = {}): void {
  const maxLineLength = boundedInteger(config.maxLineLength, 4_000, 40)
  ctx.tui.registerEventRenderer({
    id: 'deep-tui.files.tool-call',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-call') return undefined
      if (event.call.name === 'list_files') {
        const target = bounded(argument(event.call.arguments.path, 'workspace'), maxLineLength)
        return explorationCall(event, render, 'List', render.style(target, 'foreground'))
      }
      if (event.call.name === 'find_files') {
        const pattern = bounded(argument(event.call.arguments.pattern, '**/*'), maxLineLength)
        const target = bounded(argument(event.call.arguments.path, 'workspace'), maxLineLength)
        const detail = `${render.style(pattern, 'foreground')} ${render.style('in', 'muted')} ${render.style(target, 'foreground')}`
        return explorationCall(event, render, 'Find', detail)
      }
      return undefined
    },
  })

  ctx.tui.registerEventRenderer({
    id: 'deep-tui.files.tool-result',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-result') return undefined
      if (event.call.name === 'list_files') {
        const result = parseListFilesOutput(event.output)
        if (!result) return undefined
        if (config.showResults !== true) return []
        return renderFileResults(result, render, config, {
          label: argument(event.call.arguments.path, 'workspace'),
          noun: 'entry',
          toolName: event.call.name,
        })
      }
      if (event.call.name === 'find_files') {
        const result = parseFindFilesOutput(event.output)
        if (!result) return undefined
        if (config.showResults !== true) return []
        const pattern = argument(event.call.arguments.pattern, '**/*')
        const target = argument(event.call.arguments.path, 'workspace')
        return renderFileResults(result, render, config, {
          label: `${pattern} in ${target}`,
          noun: 'file',
          toolName: event.call.name,
        })
      }
      return undefined
    },
  })
}

export default { name, inject, apply }
