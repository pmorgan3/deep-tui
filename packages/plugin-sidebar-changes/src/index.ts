import type { Context } from 'cordis'
import type { AgentEvent, TuiSidebarRow } from '@deep-tui/sdk'

interface Change {
  path: string
  additions: number
  deletions: number
  eventIndex: number
}

function filesFromDiff(diff: string): Array<Omit<Change, 'eventIndex'>> {
  const output = new Map<string, Omit<Change, 'eventIndex'>>()
  let current: Omit<Change, 'eventIndex'> | undefined
  for (const line of diff.replace(/\r\n?/g, '\n').split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    const target = header?.[2] ?? line.match(/^\+\+\+ (?:b\/)?(.+)$/)?.[1]
    if (target && target !== '/dev/null') {
      current = output.get(target) ?? { path: target, additions: 0, deletions: 0 }
      output.set(target, current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
  }
  return [...output.values()]
}

function collect(events: readonly AgentEvent[]): Change[] {
  const changes = new Map<string, Change>()
  events.forEach((event, eventIndex) => {
    if (event.type !== 'tool-result' || event.presentation?.type !== 'diff') return
    const diff = event.presentation.data.diff
    if (typeof diff !== 'string') return
    let files = filesFromDiff(diff)
    if (!files.length) {
      const listed = Array.isArray(event.presentation.data.files)
        ? event.presentation.data.files.filter((value): value is string => typeof value === 'string')
        : []
      const additions = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length
      const deletions = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length
      files = (listed.length ? listed : ['workspace changes']).map(path => ({ path, additions, deletions }))
    }
    for (const file of files) {
      const previous = changes.get(file.path)
      changes.set(file.path, {
        path: file.path,
        additions: (previous?.additions ?? 0) + file.additions,
        deletions: (previous?.deletions ?? 0) + file.deletions,
        eventIndex,
      })
    }
  })
  return [...changes.values()].sort((left, right) => right.eventIndex - left.eventIndex || left.path.localeCompare(right.path))
}

export const name = 'sidebar-changes'
export const inject = ['tui']

export function apply(ctx: Context): void {
  let source: readonly AgentEvent[] | undefined
  let cached: Change[] = []
  ctx.tui.registerSidebarSection({
    id: 'deep-tui.sidebar.changes', title: 'Changes', order: 10,
    render(render) {
      if (source !== render.state.events) {
        source = render.state.events
        cached = collect(source)
      }
      if (!cached.length) return undefined
      const row = (change: Change): TuiSidebarRow => ({
        id: `change:${change.path}`,
        text: `${change.path} ${render.style(`+${change.additions}`, 'success')} ${render.style(`-${change.deletions}`, 'danger')}`,
        activate: actions => actions.revealEvent(change.eventIndex),
      })
      return { rows: cached.slice(0, 6).map(row), compactRows: cached.slice(0, 3).map(row) }
    },
  })
}

export default { name, inject, apply }
