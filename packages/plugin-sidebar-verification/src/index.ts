import type { Context } from 'cordis'
import type { AgentEvent, ToolCall, TuiSidebarRow } from '@flect/sdk'

interface Check {
  call: ToolCall
  command: string
  eventIndex: number
  status: 'running' | 'passed' | 'failed'
}

function isVerification(call: ToolCall): boolean {
  if (call.name !== 'run_command' || !Array.isArray(call.arguments.argv)) return false
  const command = call.arguments.argv.filter(value => typeof value === 'string').join(' ').toLowerCase()
  return /(^|\s)(test|check|lint|typecheck|build|vitest|jest|pytest|mypy|ruff)(\s|$)|cargo test|go test|dotnet test|tsc(?:\s|$)/.test(command)
}

function commandLabel(call: ToolCall): string {
  const argv = Array.isArray(call.arguments.argv)
    ? call.arguments.argv.filter((value): value is string => typeof value === 'string')
    : []
  const value = argv.join(' ')
  return value || 'verification'
}

function passed(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false
  const result = output as Record<string, unknown>
  return result.code === 0 && result.timedOut !== true
}

function collect(events: readonly AgentEvent[]): Check[] {
  const checks = new Map<string, Check>()
  events.forEach((event, eventIndex) => {
    if (event.type === 'tool-call' && isVerification(event.call)) {
      checks.set(event.call.id, {
        call: event.call, command: commandLabel(event.call), eventIndex, status: 'running',
      })
    } else if (event.type === 'tool-result') {
      const check = checks.get(event.call.id)
      if (check) checks.set(event.call.id, {
        ...check, eventIndex, status: passed(event.output) ? 'passed' : 'failed',
      })
    }
  })
  return [...checks.values()].reverse()
}

export const name = 'sidebar-verification'
export const inject = ['tui']

export function apply(ctx: Context): void {
  let source: readonly AgentEvent[] | undefined
  let cached: Check[] = []
  ctx.tui.registerSidebarSection({
    id: 'flect.sidebar.verification', title: 'Verification', order: 40,
    render(render) {
      if (source !== render.state.events) {
        source = render.state.events
        cached = collect(source)
      }
      if (!cached.length) return undefined
      const row = (check: Check): TuiSidebarRow => ({
        id: `verification:${check.call.id}`,
        text: `${check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : '●'} ${check.command}`,
        tone: check.status === 'passed' ? 'success' : check.status === 'failed' ? 'danger' : 'warning',
        activate: actions => actions.revealEvent(check.eventIndex),
      })
      return { rows: cached.slice(0, 4).map(row), compactRows: cached.slice(0, 2).map(row) }
    },
  })
}

export default { name, inject, apply }
