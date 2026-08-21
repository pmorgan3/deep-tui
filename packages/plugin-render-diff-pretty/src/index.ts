import type { Context } from 'cordis'
import type { RichTextLine, RichTextSpan, RichTextStyle, TuiRenderContext } from '@deep-tui/sdk'

export interface PrettyDiffRendererConfig {
  /** Per-file cap on rendered body lines (hunk headers and content). Default 120. */
  maxLinesPerFile?: number
  /** Global cap on rendered lines before the completion footer. Default 500. */
  maxTotalLines?: number
  /** Per-line syntax-highlighting safety threshold. Longer lines stay plain and wrap. Default 4000. */
  maxLineLength?: number
  /** Show the tool name in the completion line. Default true. */
  showToolName?: boolean
  /** Bold/underline the changed span inside adjacent +/- line pairs. Default true. */
  wordDiff?: boolean
  /** Ask the TUI code highlighter for syntax colors when a language is known. Default true. */
  syntaxHighlight?: boolean
  /** Tint changed lines with the add/remove tone while keeping syntax colors. Default true. */
  tintBackground?: boolean
  /** Render @@ hunk headers. Default true. */
  showHunks?: boolean
}

export interface RenderPrettyDiffOptions {
  /** Canonical target paths from the presentation; preferred over parsed headers. */
  files?: readonly string[]
  /** Code highlighter hook; falls back to plain tone styling when unavailable. */
  highlight?: (code: string, language: string | undefined) => readonly RichTextLine[] | undefined
  /** Tool name shown in the completion footer. */
  toolName?: string
}

interface NumberedDiffLine {
  source: string
  index: number
  siblings: readonly string[]
  pairs?: Map<number, number>
  lineNumber?: number
}

export interface PrettyHunk {
  header: string
  lines: string[]
}

export interface PrettyFileDiff {
  oldPath: string
  newPath: string
  additions: number
  deletions: number
  hunks: PrettyHunk[]
}

function sanitize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function cleanPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/dev/null') return trimmed
  return trimmed.replace(/^[ab]\//, '')
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) ? 2 : 1
}

function displayWidth(value: string): number {
  return [...value].reduce((total, character) => total + characterWidth(character), 0)
}

/**
 * Lenient unified-diff parser for display. Unlike the patch tool's validating
 * parser this never throws: it accepts git and plain `---`/`+++` headers,
 * skips metadata and `\ No newline` lines, and pairs +/- lines for word diffs.
 */
export function parseUnifiedDiff(source: string): PrettyFileDiff[] {
  const lines = sanitize(source).split('\n')
  if (lines.at(-1) === '') lines.pop()
  const files: PrettyFileDiff[] = []
  let current: PrettyFileDiff | undefined
  let pendingGit = false
  for (const line of lines) {
    const diffGit = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (diffGit?.[1] && diffGit?.[2]) {
      const file: PrettyFileDiff = { oldPath: cleanPath(diffGit[1]), newPath: cleanPath(diffGit[2]), additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      current = file
      pendingGit = true
      continue
    }
    if (line.startsWith('--- ')) {
      const oldPath = cleanPath(line.slice(4))
      if (current && current.hunks.length === 0 && pendingGit) {
        current.oldPath = oldPath
      } else {
        const file: PrettyFileDiff = { oldPath, newPath: '', additions: 0, deletions: 0, hunks: [] }
        files.push(file)
        current = file
        pendingGit = false
      }
      continue
    }
    if (current && line.startsWith('+++ ')) {
      current.newPath = cleanPath(line.slice(4))
      continue
    }
    if (current && line.startsWith('@@ ')) {
      current.hunks.push({ header: line, lines: [] })
      continue
    }
    if (current && current.hunks.length) {
      const marker = line[0]
      if (marker === ' ' || marker === '+' || marker === '-') {
        const hunk = current.hunks[current.hunks.length - 1]
        hunk?.lines.push(line)
        if (marker === '+') current.additions += 1
        else if (marker === '-') current.deletions += 1
      }
    }
    // Anything else (`index`, `mode`, `\ No newline`, ...) is metadata for display.
  }
  return files.filter(file => file.hunks.length > 0)
}

function targetPath(file: PrettyFileDiff): string {
  if (file.newPath && file.newPath !== '/dev/null') return file.newPath
  if (file.oldPath && file.oldPath !== '/dev/null') return file.oldPath
  return file.newPath || file.oldPath || '(unknown)'
}

function fileBadge(file: PrettyFileDiff): string | undefined {
  if (file.newPath === '/dev/null') return 'deleted file'
  if (file.oldPath === '/dev/null' && file.newPath && file.newPath !== '/dev/null') return 'new file'
  if (file.oldPath && file.newPath && file.newPath !== '/dev/null' && file.oldPath !== file.newPath) return 'renamed'
  return undefined
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.css': 'css', '.dockerfile': 'dockerfile', '.go': 'go', '.html': 'html', '.htm': 'html',
  '.java': 'java', '.js': 'javascript', '.jsx': 'jsx', '.json': 'json', '.md': 'markdown',
  '.markdown': 'markdown', '.py': 'python', '.rs': 'rust', '.sh': 'bash', '.bash': 'bash',
  '.sql': 'sql', '.ts': 'typescript', '.tsx': 'tsx', '.yaml': 'yaml', '.yml': 'yaml',
}

function languageForPath(value: string): string | undefined {
  if (!value) return undefined
  const base = value.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  for (const [extension, language] of Object.entries(EXTENSION_LANGUAGES)) {
    if (base.endsWith(extension)) return language
  }
  return undefined
}

/** Blend `tone` into `background` by `ratio` for a subtle line tint. */
function blend(foreground: string, background: string, ratio: number): string | undefined {
  if (!/^#[\da-f]{6}$/i.test(foreground) || !/^#[\da-f]{6}$/i.test(background)) return undefined
  const channels = [1, 3, 5].map(index => {
    const a = Number.parseInt(foreground.slice(index, index + 2), 16)
    const b = Number.parseInt(background.slice(index, index + 2), 16)
    return Math.round(b + (a - b) * ratio).toString(16).padStart(2, '0')
  }).join('')
  return `#${channels}`
}

/** Pair adjacent +/- lines inside a hunk so word diffs can style the changed span. */
function changedPairs(lines: readonly string[]): Map<number, number> {
  const pairs = new Map<number, number>()
  const removed: number[] = []
  const added: number[] = []
  const flush = () => {
    const count = Math.min(removed.length, added.length)
    for (let index = 0; index < count; index += 1) {
      const left = removed[index]
      const right = added[index]
      if (left !== undefined && right !== undefined) {
        pairs.set(left, right)
        pairs.set(right, left)
      }
    }
    removed.length = 0
    added.length = 0
  }
  for (const [index, line] of lines.entries()) {
    if (line[0] === '-') removed.push(index)
    else if (line[0] === '+') added.push(index)
    else flush()
  }
  flush()
  return pairs
}

function wordDiffRange(left: string, right: string): { start: number; end: number } | undefined {
  if (!left || !right || left === right) return undefined
  const maxPrefix = Math.min(left.length, right.length)
  let prefix = 0
  while (prefix < maxPrefix && left[prefix] === right[prefix]) prefix += 1
  const maxSuffix = maxPrefix - prefix
  let suffix = 0
  while (suffix < maxSuffix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1
  const start = prefix
  const end = left.length - suffix
  return start < end ? { start, end } : undefined
}

function styleMiddle(spans: readonly RichTextSpan[], start: number, end: number, patch: RichTextStyle): RichTextSpan[] {
  const output: RichTextSpan[] = []
  let offset = 0
  for (const span of spans) {
    const next = offset + span.text.length
    if (next <= start || offset >= end) {
      output.push(span)
    } else {
      const overlapStart = Math.max(start, offset)
      const overlapEnd = Math.min(end, next)
      if (overlapStart > offset) {
        output.push({ text: span.text.slice(0, overlapStart - offset), ...(span.style ? { style: span.style } : {}) })
      }
      output.push({
        text: span.text.slice(overlapStart - offset, overlapEnd - offset),
        style: { ...(span.style ?? {}), ...patch },
      })
      if (overlapEnd < next) {
        output.push({ text: span.text.slice(overlapEnd - offset), ...(span.style ? { style: span.style } : {}) })
      }
    }
    offset = next
  }
  return output
}

interface DiffLineOptions {
  highlightLimit: number
  wordDiff: boolean
  syntaxHighlight: boolean
  tintBackground: boolean
  pairs?: Map<number, number>
  highlight?: (code: string, language: string | undefined) => readonly RichTextLine[] | undefined
}

function highlightBody(body: string, file: PrettyFileDiff, options: DiffLineOptions): readonly RichTextLine[] | undefined {
  if (!options.highlight || body.length > options.highlightLimit) return undefined
  const language = languageForPath(file.newPath || file.oldPath)
  try {
    const lines = options.highlight(body, language)
    return lines?.length ? lines : undefined
  } catch {
    return undefined
  }
}

function renderDiffLine(
  line: string,
  index: number,
  lines: readonly string[],
  file: PrettyFileDiff,
  render: TuiRenderContext,
  options: DiffLineOptions,
): string[] {
  const marker = line[0]
  if (marker !== ' ' && marker !== '+' && marker !== '-') {
    return render.wrap(line, Math.max(1, render.width - 4)).map(part => `  │ ${part}`)
  }
  const body = line.slice(1)
  const pairIndex = options.pairs?.get(index)
  const pairBody = pairIndex === undefined
    ? undefined
    : lines[pairIndex]?.slice(1) ?? ''
  const tone: 'success' | 'danger' | undefined = marker === '+' ? 'success' : marker === '-' ? 'danger' : undefined
  const toneColor = tone ? render.theme.tokens.colors[tone] : undefined
  const highlighted = options.syntaxHighlight ? highlightBody(body, file, options) : undefined
  const tint = toneColor && options.tintBackground
      ? blend(toneColor, render.theme.tokens.colors.background, 0.15)
      : undefined
  let spans: RichTextSpan[] = highlighted?.[0]?.spans?.length
    ? [...highlighted[0].spans]
    : [{ text: body, ...(toneColor ? { style: { foreground: toneColor } } : {}) }]
  if (tint) spans = spans.map(span => ({ ...span, style: { ...(span.style ?? {}), background: tint } }))
  if (tone && options.wordDiff && pairBody !== undefined) {
    const range = wordDiffRange(body, pairBody)
    if (range) spans = styleMiddle(spans, range.start, range.end, { bold: true, underline: true, ...(tint ? { background: tint } : {}) })
  }
  const markerStyle: RichTextStyle | undefined = toneColor
    ? { foreground: toneColor, ...(highlighted ? { bold: true } : {}), ...(tint ? { background: tint } : {}) }
    : undefined
  const rich: RichTextLine = { spans: [
    { text: marker, ...(markerStyle ? { style: markerStyle } : {}) },
    ...spans,
  ] }
  return render.renderRich([rich], Math.max(1, render.width - 4)).map(part => `  │ ${part}`)
}

function fileLineCount(file: PrettyFileDiff, showHunks: boolean): number {
  return file.hunks.reduce((total, hunk) => total + hunk.lines.length + (showHunks ? 1 : 0), 0)
}

function numberedLines(file: PrettyFileDiff, wordDiff: boolean): NumberedDiffLine[] {
  const output: NumberedDiffLine[] = []
  for (const hunk of file.hunks) {
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?(?: @@|$)/.exec(hunk.header)
    let oldLine = range?.[1] ? Number(range[1]) : undefined
    let newLine = range?.[2] ? Number(range[2]) : undefined
    const pairs = wordDiff ? changedPairs(hunk.lines) : undefined
    for (const [index, source] of hunk.lines.entries()) {
      const marker = source[0]
      const lineNumber = marker === '-' ? oldLine : newLine
      output.push({ source, index, siblings: hunk.lines, ...(pairs ? { pairs } : {}), ...(lineNumber === undefined ? {} : { lineNumber }) })
      if (marker !== '+' && oldLine !== undefined) oldLine += 1
      if (marker !== '-' && newLine !== undefined) newLine += 1
    }
  }
  return output
}

function renderEditorDiffLine(
  item: NumberedDiffLine,
  file: PrettyFileDiff,
  gutterWidth: number,
  render: TuiRenderContext,
  options: DiffLineOptions,
): string[] {
  const marker = item.source[0] ?? ' '
  const prefixWidth = 2 + gutterWidth + 3
  const body = item.source.slice(1)
  const pairIndex = item.pairs?.get(item.index)
  const pairBody = pairIndex === undefined
    ? undefined
    : item.siblings[pairIndex]?.slice(1) ?? ''
  const changed = marker === '+' || marker === '-'
  const tone: 'success' | 'danger' | undefined = marker === '+' ? 'success' : marker === '-' ? 'danger' : undefined
  const toneColor = tone ? render.theme.tokens.colors[tone] : undefined
  const tint = changed && options.tintBackground && toneColor
    ? blend(toneColor, render.theme.tokens.colors.background, 0.15)
    : undefined
  const highlighted = options.syntaxHighlight ? highlightBody(body, file, options) : undefined
  let codeSpans: RichTextSpan[] = highlighted?.[0]?.spans?.length
    ? [...highlighted[0].spans]
    : [{ text: body }]
  if (tint) codeSpans = codeSpans.map(span => ({ ...span, style: { ...(span.style ?? {}), background: tint } }))
  if (changed && options.wordDiff && pairBody !== undefined) {
    const range = wordDiffRange(body, pairBody)
    if (range) codeSpans = styleMiddle(codeSpans, range.start, range.end, { bold: true, underline: true, ...(tint ? { background: tint } : {}) })
  }

  const number = item.lineNumber === undefined ? '' : String(item.lineNumber)
  const baseStyle = tint ? { background: tint } : undefined
  const markerStyle = {
    ...(toneColor ? { foreground: toneColor, bold: true } : {}),
    ...(tint ? { background: tint } : {}),
  }
  const used = prefixWidth + displayWidth(body)
  const padding = changed ? ' '.repeat(Math.max(0, render.width - used)) : ''
  const rich: RichTextLine = { spans: [
    { text: '  ', ...(baseStyle ? { style: baseStyle } : {}) },
    { text: number.padStart(gutterWidth), style: { foreground: render.theme.tokens.colors.muted, ...(baseStyle ?? {}) } },
    { text: ' ', ...(baseStyle ? { style: baseStyle } : {}) },
    { text: marker === ' ' ? ' ' : marker, ...(Object.keys(markerStyle).length ? { style: markerStyle } : {}) },
    { text: ' ', ...(baseStyle ? { style: baseStyle } : {}) },
    ...codeSpans,
    ...(padding ? [{ text: padding, ...(baseStyle ? { style: baseStyle } : {}) }] : []),
  ] }
  return render.renderRich([rich], render.width)
}

/** Render write_file as an editor-style diff with numbered, full-width changed rows. */
export function renderWriteFileDiff(
  source: string,
  render: TuiRenderContext,
  config: PrettyDiffRendererConfig = {},
  options: RenderPrettyDiffOptions = {},
): string[] {
  const maxLinesPerFile = Math.max(1, config.maxLinesPerFile ?? 120)
  const maxTotalLines = Math.max(1, config.maxTotalLines ?? 500)
  const highlightLimit = Math.max(40, config.maxLineLength ?? 4_000)
  const wordDiff = config.wordDiff !== false
  const syntaxHighlight = config.syntaxHighlight !== false
  const tintBackground = config.tintBackground !== false
  const files = parseUnifiedDiff(source)
  if (!files.length) return renderPrettyDiff(source, render, { ...config, showToolName: false }, options).slice(0, -1)

  const base: DiffLineOptions = {
    highlightLimit,
    wordDiff,
    syntaxHighlight,
    tintBackground,
    ...(options.highlight ? { highlight: options.highlight } : {}),
  }
  const listed = options.files ?? []
  const output: string[] = []
  for (const [index, file] of files.entries()) {
    const label = listed[index] || targetPath(file)
    output.push(`  ${render.style('•', 'muted')} ${render.style('Edited', 'foreground', true)} ${render.style(label, 'foreground')} (${render.style(`+${file.additions}`, 'success')} ${render.style(`-${file.deletions}`, 'danger')})`)
    const numbered = numberedLines(file, wordDiff)
    const gutterWidth = Math.max(1, ...numbered.map(line => String(line.lineNumber ?? '').length))
    const selected = numbered.slice(0, maxLinesPerFile)
    for (const item of selected) output.push(...renderEditorDiffLine(item, file, gutterWidth, render, base))
    if (numbered.length > selected.length) {
      output.push(render.style(`  ${' '.repeat(gutterWidth)}   [${numbered.length - selected.length} more lines omitted]`, 'warning'))
    }
  }
  if (output.length <= maxTotalLines) return output
  return [
    ...output.slice(0, maxTotalLines),
    render.style(`  [${output.length - maxTotalLines} diff lines omitted]`, 'warning'),
  ]
}

/**
 * Render a `diff` tool presentation as compact per-file boxes. Files each get a
 * stat header, hunks are styled and (optionally) word-diffed, and the result
 * degrades to a bounded raw unified diff when the source cannot be parsed.
 */
export function renderPrettyDiff(
  source: string,
  render: TuiRenderContext,
  config: PrettyDiffRendererConfig = {},
  options: RenderPrettyDiffOptions = {},
): string[] {
  const maxLinesPerFile = Math.max(1, config.maxLinesPerFile ?? 120)
  const maxTotalLines = Math.max(1, config.maxTotalLines ?? 500)
  const highlightLimit = Math.max(40, config.maxLineLength ?? 4_000)
  const wordDiff = config.wordDiff !== false
  const syntaxHighlight = config.syntaxHighlight !== false
  const tintBackground = config.tintBackground !== false
  const showHunks = config.showHunks !== false
  const showToolName = config.showToolName !== false

  const parsed = parseUnifiedDiff(source)
  const files = parsed.filter(file => file.hunks.length > 0)
  const listed = options.files ?? []

  const base: DiffLineOptions = {
    highlightLimit,
    wordDiff,
    syntaxHighlight,
    tintBackground,
    ...(options.highlight ? { highlight: options.highlight } : {}),
  }

  const body: string[] = []
  if (!files.length) {
    const all = sanitize(source).split('\n')
    if (all.at(-1) === '') all.pop()
    const selected = all.slice(0, maxTotalLines)
    for (const line of selected) {
      const text = `  │ ${line}`
      if (line.startsWith('+++')) body.push(render.style(text, 'success', true))
      else if (line.startsWith('---')) body.push(render.style(text, 'danger', true))
      else if (line.startsWith('+')) body.push(render.style(text, 'success'))
      else if (line.startsWith('-')) body.push(render.style(text, 'danger'))
      else if (line.startsWith('@@')) body.push(render.style(text, 'accent', true))
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) body.push(render.style(text, 'muted'))
      else body.push(text)
    }
    if (all.length > selected.length) {
      body.push(render.style(`  │ [${all.length - selected.length} diff lines omitted]`, 'warning'))
    }
  } else {
    for (const [index, file] of files.entries()) {
      if (index > 0) body.push('  │')
      const label = listed[index] || targetPath(file)
      const badge = fileBadge(file)
      body.push(`  ${render.style('┌', 'accent', true)} ${render.style(label, 'accent', true)} · ${render.style(`+${file.additions}`, 'success', true)} ${render.style(`-${file.deletions}`, 'danger', true)}${badge ? ` · ${render.style(badge, 'muted')}` : ''}`)
      let shown = 0
      for (const hunk of file.hunks) {
        if (shown >= maxLinesPerFile) break
        if (showHunks) {
          body.push(`  │ ${render.style(hunk.header, 'accent', true)}`)
          shown += 1
        }
        const pairs = wordDiff ? changedPairs(hunk.lines) : undefined
        for (const [lineIndex, line] of hunk.lines.entries()) {
          if (shown >= maxLinesPerFile) break
          body.push(...renderDiffLine(line, lineIndex, hunk.lines, file, render, { ...base, ...(pairs ? { pairs } : {}) }))
          shown += 1
        }
        if (shown >= maxLinesPerFile) break
      }
      const remaining = fileLineCount(file, showHunks) - shown
      if (remaining > 0) body.push(render.style(`  │ [${remaining} more lines omitted]`, 'warning'))
    }
  }

  const output = body.length > maxTotalLines
    ? [
      ...body.slice(0, maxTotalLines),
      render.style(`  │ [${body.length - maxTotalLines} diff lines omitted]`, 'warning'),
    ]
    : body
  const totals = files.reduce((sum, file) => ({
    additions: sum.additions + file.additions,
    deletions: sum.deletions + file.deletions,
  }), { additions: 0, deletions: 0 })
  const summary = files.length > 1
    ? ` · ${files.length} files · +${totals.additions} -${totals.deletions}`
    : ''
  const name = showToolName && options.toolName ? ` ${options.toolName}` : ''
  output.push(`  ${render.style('└', 'success', true)} ✓${name}${summary}`)
  return output
}

export const name = 'diff-pretty-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: PrettyDiffRendererConfig = {}): void {
  ctx.tui.registerEventRenderer({
    id: 'deep-tui.diff-pretty.tool-call',
    priority: 200,
    render(event, render) {
      if (event.type !== 'tool-call') return undefined
      if (event.call.name === 'write_file' && typeof event.call.arguments.path === 'string') {
        return []
      }
      if (event.call.name !== 'apply_patch' || typeof event.call.arguments.patch !== 'string') return undefined
      let files: PrettyFileDiff[] = []
      try {
        files = parseUnifiedDiff(event.call.arguments.patch)
      } catch {
        files = []
      }
      if (!files.length) return undefined
      const additions = files.reduce((sum, file) => sum + file.additions, 0)
      const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
      const label = files.length === 1 ? targetPath(files[0]!) : `${files.length} files`
      const stats = additions || deletions
        ? ` · ${render.style(`+${additions}`, 'success', true)} ${render.style(`-${deletions}`, 'danger', true)}`
        : ''
      return [render.style(`  ↳ apply_patch · ${label}`, 'muted') + stats]
    },
  })

  ctx.tui.registerEventRenderer({
    id: 'deep-tui.diff-pretty.tool-result',
    priority: 200,
    render(event, render) {
      if (event.type !== 'tool-result' || event.presentation?.type !== 'diff') return undefined
      const diff = event.presentation.data.diff
      if (typeof diff !== 'string' || !diff) return undefined
      const files = Array.isArray(event.presentation.data.files)
        ? event.presentation.data.files.filter((value): value is string => typeof value === 'string')
        : []
      if (event.call.name === 'write_file') {
        return renderWriteFileDiff(diff, render, config, {
          files,
          highlight: (code, language) => ctx.tui.highlightCode(code, language, render),
          toolName: event.call.name,
        })
      }
      return renderPrettyDiff(diff, render, config, {
        files,
        highlight: (code, language) => ctx.tui.highlightCode(code, language, render),
        toolName: event.call.name,
      })
    },
  })
}

export default { name, inject, apply }
