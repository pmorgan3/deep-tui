import type { Context } from 'cordis'
import type { TuiRenderContext } from '@flect/sdk'

export interface RunCommandRendererConfig {
  /** Use the compact Claude-style command activity block. Default true. */
  compact?: boolean
  /** Visible output lines in compact mode. Default 3. */
  previewLines?: number
  /** Cap on visible stdout lines. Default 80. */
  maxStdoutLines?: number
  /** Cap on visible stderr lines. Default 40. */
  maxStderrLines?: number
  /** Global cap on rendered body lines before the completion footer. Default 240. */
  maxTotalLines?: number
  /** Command syntax-highlighting safety threshold. Longer commands stay plain and wrap. Default 4000. */
  maxLineLength?: number
  /** Show the tool name in the completion footer. Default true. */
  showToolName?: boolean
}

export interface RunCommandOutput {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  timedOut?: boolean
  elapsedMs?: number
}

export interface RunCommandFailure {
  error: string
}

export type RunCommandRenderInput =
  | { kind: 'result'; result: RunCommandOutput }
  | { kind: 'failure'; error: string }

export interface RenderRunCommandOptions {
  /** Display argv used for the header. */
  argv?: readonly string[]
  /** Tool name shown in the header and completion footer. */
  toolName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function sanitize(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function lines(value: string): string[] {
  const normalized = sanitize(value)
  if (!normalized) return []
  const output = normalized.split('\n')
  if (output.at(-1) === '') output.pop()
  return output
}

function bounded(value: string, _limit: number): string {
  return value
}

function formatArgv(argv: readonly string[]): string {
  return argv
    .map(value => /^[\w@%+=:,./#-]+$/.test(value) ? value : JSON.stringify(value))
    .join(' ')
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string')) return undefined
  return value as string[]
}

/** Parse a live run_command result object or a durable-session JSON string. */
export function parseRunCommandOutput(output: unknown): RunCommandRenderInput | undefined {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  if (typeof value.error === 'string') return { kind: 'failure', error: value.error }
  if (typeof value.stdout !== 'string' || typeof value.stderr !== 'string') return undefined

  const code = value.code
  if (code !== undefined && code !== null && typeof code !== 'number') return undefined
  const signal = value.signal
  if (signal !== undefined && signal !== null && typeof signal !== 'string') return undefined
  const stdoutTruncated = value.stdoutTruncated
  if (stdoutTruncated !== undefined && typeof stdoutTruncated !== 'boolean') return undefined
  const stderrTruncated = value.stderrTruncated
  if (stderrTruncated !== undefined && typeof stderrTruncated !== 'boolean') return undefined
  const timedOut = value.timedOut
  if (timedOut !== undefined && typeof timedOut !== 'boolean') return undefined
  const elapsedMs = value.elapsedMs
  if (elapsedMs !== undefined && typeof elapsedMs !== 'number') return undefined

  return {
    kind: 'result',
    result: {
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
      stdout: value.stdout,
      stderr: value.stderr,
      stdoutTruncated: stdoutTruncated === true,
      stderrTruncated: stderrTruncated === true,
      timedOut: timedOut === true,
      ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
    },
  }
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const elapsedMs = Math.max(0, value)
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)}ms`
  return `${(elapsedMs / 1_000).toFixed(1)}s`
}

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`
}

function statusFor(result: RunCommandOutput): { text: string; tone: 'success' | 'warning' | 'danger' | 'muted' } {
  if (result.timedOut) return { text: 'timed out', tone: 'warning' }
  if (result.signal) return { text: `signal ${result.signal}`, tone: 'danger' }
  if (result.code === null) return { text: 'exited', tone: 'muted' }
  return result.code === 0
    ? { text: `exit ${result.code}`, tone: 'success' }
    : { text: `exit ${result.code}`, tone: 'danger' }
}

function isSuccess(result: RunCommandOutput): boolean {
  return result.code === 0 && !result.signal && !result.timedOut
}

/**
 * Render a structured `run_command` result as a compact output box. The body
 * shows the exit status, elapsed time, and bounded stdout/stderr sections.
 * Durable-session JSON strings are parsed back into their structured form.
 */
export function renderRunCommand(
  output: unknown,
  render: TuiRenderContext,
  config: RunCommandRendererConfig = {},
  options: RenderRunCommandOptions = {},
): string[] | undefined {
  const parsed = parseRunCommandOutput(output)
  if (!parsed) return undefined

  const maxStdoutLines = boundedInteger(config.maxStdoutLines, 80, 1)
  const maxStderrLines = boundedInteger(config.maxStderrLines, 40, 1)
  const maxTotalLines = boundedInteger(config.maxTotalLines, 240, 1)
  const maxLineLength = boundedInteger(config.maxLineLength, 4_000, 40)
  const showToolName = config.showToolName !== false
  const toolName = options.toolName?.trim() || 'run_command'
  const command = options.argv?.length ? bounded(formatArgv(options.argv), maxLineLength) : ''
  const label = command ? `${toolName} · ${command}` : toolName

  const body: string[] = []
  body.push(`  ${render.style('┌', 'accent', true)} ${render.style(label, 'accent', true)}`)

  if (parsed.kind === 'failure') {
    body.push(`  │ ${render.style('✗', 'danger', true)} ${bounded(parsed.error, maxLineLength)}`)
  } else {
    const result = parsed.result
    const status = statusFor(result)
    const duration = formatDuration(result.elapsedMs)
    const summary = [
      render.style(status.text, status.tone, true),
      ...(duration ? [render.style(duration, 'muted')] : []),
    ]
    body.push(`  │ ${summary.join(' · ')}`)

    const stdout = lines(result.stdout)
    const stderr = lines(result.stderr)
    if (!stdout.length && !stderr.length) {
      body.push(`  │ ${render.style('(no output)', 'muted')}`)
    }
    appendStream(body, render, 'stdout', stdout, maxStdoutLines, maxLineLength)
    appendStream(body, render, 'stderr', stderr, maxStderrLines, maxLineLength)
  }

  const outputLines = body.length > maxTotalLines
    ? [
      ...body.slice(0, maxTotalLines),
      `  │ ${render.style(`[${body.length - maxTotalLines} output lines omitted]`, 'warning')}`,
    ]
    : body

  const success = parsed.kind === 'result' && isSuccess(parsed.result)
  const timedOut = parsed.kind === 'result' && parsed.result.timedOut === true
  const mark = success ? '✓' : timedOut ? '⚠' : '✗'
  const tone = success ? 'success' : timedOut ? 'warning' : 'danger'
  const footerName = showToolName ? ` ${toolName}` : ''
  outputLines.push(`  ${render.style('└', tone, true)} ${render.style(`${mark}${footerName}`, tone, true)}`)
  return outputLines
}

function appendStream(
  body: string[],
  render: TuiRenderContext,
  name: 'stdout' | 'stderr',
  stream: readonly string[],
  maxLines: number,
  maxLineLength: number,
): void {
  if (!stream.length) return
  const tone = name === 'stdout' ? 'muted' : 'warning'
  body.push(`  │ ${render.style(`${name} · ${formatLineCount(stream.length)}`, tone, true)}`)
  for (const line of stream.slice(0, maxLines)) {
    body.push(`  │ ${bounded(line, maxLineLength)}`)
  }
  const omitted = stream.length - Math.min(stream.length, maxLines)
  if (omitted > 0) {
    body.push(`  │ ${render.style(`[${omitted} ${name} line${omitted === 1 ? '' : 's'} omitted]`, 'warning')}`)
  }
}

/** Render bounded command output beneath a separate `Ran` activity header. */
export function renderCompactRunCommand(
  output: unknown,
  render: TuiRenderContext,
  config: RunCommandRendererConfig = {},
): string[] | undefined {
  const parsed = parseRunCommandOutput(output)
  if (!parsed) return undefined
  const maxLineLength = boundedInteger(config.maxLineLength, 4_000, 40)
  const previewLines = boundedInteger(config.previewLines, 3, 1)
  const rows: Array<{ text: string; tone: 'muted' | 'warning' | 'danger'; bold?: boolean }> = []

  if (parsed.kind === 'failure') {
    rows.push({ text: `✗ ${bounded(parsed.error, maxLineLength)}`, tone: 'danger', bold: true })
  } else {
    const result = parsed.result
    const outputLines = [
      ...lines(result.stdout).map(text => ({ text: bounded(text, maxLineLength), tone: 'muted' as const })),
      ...lines(result.stderr).map(text => ({ text: bounded(text, maxLineLength), tone: 'warning' as const })),
    ]
    if (outputLines.length <= previewLines) rows.push(...outputLines)
    else {
      const headCount = Math.min(2, previewLines)
      const tailCount = previewLines > 2 ? 1 : 0
      rows.push(...outputLines.slice(0, headCount))
      rows.push({ text: `[${outputLines.length - headCount - tailCount} lines omitted]`, tone: 'muted' })
      if (tailCount) rows.push(...outputLines.slice(-tailCount))
    }
    if (result.stdoutTruncated || result.stderrTruncated) {
      rows.push({ text: '[additional output truncated]', tone: 'warning' })
    }
    if (!isSuccess(result)) {
      const status = statusFor(result)
      rows.push({ text: status.text, tone: status.tone === 'success' ? 'muted' : status.tone, bold: true })
    }
    const duration = formatDuration(result.elapsedMs)
    if (duration) rows.push({ text: duration, tone: 'muted' })
    if (!rows.length) rows.push({ text: '(no output)', tone: 'muted' })
  }

  return rows.map((row, index) =>
    `${index === rows.length - 1 ? '  └ ' : '  │ '}${render.style(row.text, row.tone, row.bold)}`)
}

export const name = 'run-command-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: RunCommandRendererConfig = {}): void {
  const maxLineLength = boundedInteger(config.maxLineLength, 4_000, 40)
  ctx.tui.registerEventRenderer({
    id: 'flect.run-command.tool-call',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-call' || event.call.name !== 'run_command') return undefined
      const argv = stringArray(event.call.arguments.argv)
      const command = argv ? bounded(formatArgv(argv), maxLineLength) : ''
      const width = Math.max(8, render.width - 10)
      const highlighted = command && command.length <= maxLineLength
        ? ctx.tui.highlightCode(command, 'bash', render)
        : undefined
      const commandLines = highlighted?.length
        ? render.renderRich(highlighted, width)
        : render.wrap(command || 'command', width).map(line => render.style(line, command ? 'foreground' : 'muted'))
      return commandLines.map((line, index) => index === 0
        ? `  ${render.style('•', 'accent')} ${render.style('Ran', 'foreground', true)} ${line}`
        : `  │   ${line}`)
    },
  })

  ctx.tui.registerEventRenderer({
    id: 'flect.run-command.tool-result',
    priority: 180,
    render(event, render) {
      if (event.type !== 'tool-result' || event.call.name !== 'run_command') return undefined
      if (config.compact !== false) return renderCompactRunCommand(event.output, render, config)
      const argv = stringArray(event.call.arguments.argv)
      return renderRunCommand(event.output, render, config, {
        ...(argv ? { argv } : {}),
        toolName: event.call.name,
      })
    },
  })
}

export default { name, inject, apply }
