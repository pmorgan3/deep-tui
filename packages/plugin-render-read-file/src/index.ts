import type { Context } from 'cordis'
import type { RichTextLine, TuiRenderContext } from '@flect/sdk'

export interface ReadFileRendererConfig {
  /** Show file contents in the transcript. Defaults to false for a compact exploration log. */
  showResults?: boolean
  /** Cap on visible file lines. Default 20. */
  maxLines?: number
  /** Per-line syntax-highlighting safety threshold. Longer lines stay plain and wrap. Default 4000. */
  maxLineLength?: number
  /** Render the line-number gutter. Default true. */
  showLineNumbers?: boolean
  /** Ask the TUI code highlighter for syntax colors when a language is known. Default true. */
  syntaxHighlight?: boolean
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

export interface RenderReadFileOptions {
  /** Display path used for the header and language detection. */
  path?: string
  /** Code highlighter hook; falls back to plain text when unavailable. */
  highlight?: (code: string, language: string | undefined) => readonly RichTextLine[] | undefined
  /** Tool name shown in the completion footer. */
  toolName?: string
}

function sanitize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function bounded(value: string, _limit: number): string {
  return value
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.css': 'css', '.dockerfile': 'dockerfile', '.go': 'go', '.html': 'html', '.htm': 'html',
  '.java': 'java', '.js': 'javascript', '.jsx': 'jsx', '.json': 'json', '.md': 'markdown',
  '.markdown': 'markdown', '.py': 'python', '.rs': 'rust', '.sh': 'bash', '.bash': 'bash',
  '.sql': 'sql', '.ts': 'typescript', '.tsx': 'tsx', '.yaml': 'yaml', '.yml': 'yaml',
}

export function languageForPath(value: string): string | undefined {
  if (!value) return undefined
  const base = value.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  for (const [extension, language] of Object.entries(EXTENSION_LANGUAGES)) {
    if (base.endsWith(extension)) return language
  }
  return undefined
}

/**
 * Render a successful `read_file` output as a compact file box with optional
 * line numbers and syntax highlighting. Line-count caps keep very large files
 * from flooding the transcript; individual lines remain intact and wrap.
 */
export function renderReadFile(
  source: string,
  render: TuiRenderContext,
  config: ReadFileRendererConfig = {},
  options: RenderReadFileOptions = {},
): string[] {
  const maxLines = Math.max(1, config.maxLines ?? 20)
  const maxLineLength = Math.max(40, config.maxLineLength ?? 4_000)
  const showLineNumbers = config.showLineNumbers !== false
  const syntaxHighlight = config.syntaxHighlight !== false
  const showToolName = config.showToolName !== false

  const normalized = sanitize(source)
  const all = normalized.split('\n')
  const totalLines = normalized === '' ? 0 : all.at(-1) === '' ? all.length - 1 : all.length
  const lines = totalLines === 0 ? [] : all.slice(0, Math.min(totalLines, maxLines))
  const omitted = Math.max(0, totalLines - lines.length)
  const label = options.path?.trim() || 'read_file'
  const language = languageForPath(label)
  const gutterWidth = showLineNumbers ? String(totalLines || 1).length : 0
  const richWidth = Math.max(1, render.width - 4)

  const output: string[] = []
  output.push(`  ${render.style('┌', 'accent', true)} ${render.style(label, 'accent', true)} · ${totalLines} line${totalLines === 1 ? '' : 's'}${language ? ` · ${language}` : ''}`)

  if (totalLines === 0) {
    output.push(`  │ ${render.style('(empty)', 'muted')}`)
  } else {
    const visibleSource = lines.map(line => bounded(line, maxLineLength)).join('\n')
    let highlighted: readonly RichTextLine[] | undefined
    if (syntaxHighlight && options.highlight && lines.every(line => line.length <= maxLineLength)) {
      try {
        highlighted = options.highlight(visibleSource, language)
      } catch {
        highlighted = undefined
      }
    }

    lines.forEach((raw, index) => {
      const body = bounded(raw, maxLineLength)
      const spans = highlighted?.[index]?.spans ?? [{ text: body }]
      const rendered = render.renderRich([{
        spans: [
          ...(showLineNumbers ? [{
            text: `${String(index + 1).padStart(gutterWidth)} │ `,
            style: { foreground: render.theme.tokens.colors.muted },
          }] : []),
          ...spans,
        ],
      }], richWidth)
      output.push(...rendered.map(line => `  │ ${line}`))
    })

    if (omitted > 0) {
      output.push(`  │ ${render.style(`[${omitted} line${omitted === 1 ? '' : 's'} omitted]`, 'warning')}`)
    }
  }

  const name = showToolName && options.toolName ? ` ${options.toolName}` : ''
  output.push(`  ${render.style('└', 'success', true)} ✓${name}`)
  return output
}

export const name = 'read-file-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: ReadFileRendererConfig = {}): void {
  ctx.tui.registerEventRenderer({
    id: 'flect.read-file.tool-call',
    priority: 150,
    render(event, render) {
      if (event.type !== 'tool-call' || event.call.name !== 'read_file') return undefined
      const path = typeof event.call.arguments.path === 'string' && event.call.arguments.path
        ? event.call.arguments.path
        : 'file'
      return explorationCall(event, render, 'Read', render.style(path, 'foreground'))
    },
  })

  ctx.tui.registerEventRenderer({
    id: 'flect.read-file.tool-result',
    priority: 150,
    render(event, render) {
      if (event.type !== 'tool-result' || event.call.name !== 'read_file' || typeof event.output !== 'string') return undefined
      if (config.showResults !== true) return []
      const presentationPath = event.presentation?.type === 'read-file'
        && typeof event.presentation.data.path === 'string'
        ? event.presentation.data.path
        : undefined
      const argumentPath = typeof event.call.arguments.path === 'string' && event.call.arguments.path
        ? event.call.arguments.path
        : undefined
      const path = presentationPath ?? argumentPath
      return renderReadFile(event.output, render, config, {
        ...(path ? { path } : {}),
        highlight: (code, language) => ctx.tui.highlightCode(code, language, render),
        toolName: event.call.name,
      })
    },
  })
}

export default { name, inject, apply }
