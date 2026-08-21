import type { Context } from 'cordis'
import type { TuiRenderContext } from '@flect/sdk'

export interface DiffRendererConfig {
  maxLines?: number
  /** @deprecated Lines are preserved and wrapped by the TUI. */
  maxLineLength?: number
  showToolName?: boolean
}

function sanitize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function styledDiffLine(line: string, render: TuiRenderContext): string {
  const text = `  │ ${line}`
  if (line.startsWith('+++')) return render.style(text, 'success', true)
  if (line.startsWith('---')) return render.style(text, 'danger', true)
  if (line.startsWith('+')) return render.style(text, 'success')
  if (line.startsWith('-')) return render.style(text, 'danger')
  if (line.startsWith('@@')) return render.style(text, 'accent', true)
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) return render.style(text, 'muted')
  return text
}

function filesFromCall(name: string, input: Record<string, unknown>): string[] {
  if (name === 'write_file' && typeof input.path === 'string') return [input.path]
  if (name !== 'apply_patch' || typeof input.patch !== 'string') return []
  return [...input.patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)]
    .map(match => match[1])
    .filter((value): value is string => Boolean(value && value !== '/dev/null'))
}

function changedLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

export function renderUnifiedDiff(
  source: string,
  render: TuiRenderContext,
  config: DiffRendererConfig = {},
): string[] {
  const all = sanitize(source).split('\n')
  if (all.at(-1) === '') all.pop()
  const limit = Math.max(1, config.maxLines ?? 400)
  const selected = all.slice(0, limit)
  const output = selected.map(line => styledDiffLine(line, render))
  if (all.length > selected.length) {
    output.push(render.style(`  │ [${all.length - selected.length} diff lines omitted]`, 'warning'))
  }
  return output
}

export const name = 'diff-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: DiffRendererConfig = {}): void {
  ctx.tui.registerEventRenderer({
    id: 'flect.diff.tool-call',
    priority: 150,
    render(event, render) {
      if (event.type !== 'tool-call' || (event.call.name !== 'apply_patch' && event.call.name !== 'write_file')) return undefined
      const files = filesFromCall(event.call.name, event.call.arguments)
      const label = files.length === 1 ? files[0] : files.length ? `${files.length} files` : 'workspace files'
      return [render.style(`  ↳ editing ${label}`, 'muted')]
    },
  })
  ctx.tui.registerEventRenderer({
    id: 'flect.diff.tool-result',
    priority: 150,
    render(event, render) {
      if (event.type !== 'tool-result' || event.presentation?.type !== 'diff') return undefined
      const diff = event.presentation.data.diff
      if (typeof diff !== 'string' || !diff) return undefined
      const files = Array.isArray(event.presentation.data.files)
        ? event.presentation.data.files.filter((value): value is string => typeof value === 'string')
        : []
      const label = files.length === 1 ? files[0] : `${files.length || 1} files`
      const counts = changedLines(diff)
      return [
        `${render.style(`  ┌ changed ${label}`, 'accent', true)} ${render.style(`+${counts.additions}`, 'success', true)} ${render.style(`-${counts.deletions}`, 'danger', true)}`,
        ...renderUnifiedDiff(diff, render, config),
        render.style(`  └ ✓${config.showToolName === false ? '' : ` ${event.call.name}`}`, 'success'),
      ]
    },
  })
}

export default { name, inject, apply }
