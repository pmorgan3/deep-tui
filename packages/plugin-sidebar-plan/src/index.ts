import type { Context } from 'cordis'
import type { AgentEvent, TuiRenderContext, TuiSidebarRow } from '@flect/sdk'

interface PlanItem {
  text: string
  complete: boolean
  eventIndex: number
}

function planActive(ctx: Context, render: TuiRenderContext): boolean {
  return ctx.tui.listStatusItems().some(item =>
    item.id === 'flect.mode.plan.status' && Boolean(item.render(render)))
}

function collect(events: readonly AgentEvent[]): PlanItem[] {
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex]
    if (event?.type !== 'assistant' && event?.type !== 'assistant-finish') continue
    const items = event.text.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*(?:[-*]|\d+\.)\s+\[([ xX])\]\s+(.+)$/)
      return match?.[2] ? [{ text: match[2], complete: match[1]?.toLowerCase() === 'x', eventIndex }] : []
    })
    if (items.length) return items
  }
  return []
}

export const name = 'sidebar-plan'
export const inject = ['tui']

export function apply(ctx: Context): void {
  let source: readonly AgentEvent[] | undefined
  let cached: PlanItem[] = []
  ctx.tui.registerSidebarSection({
    id: 'flect.sidebar.plan', title: 'Plan', order: 5,
    render(render) {
      if (source !== render.state.events) {
        source = render.state.events
        cached = collect(source)
      }
      const active = planActive(ctx, render)
      if (!active && !cached.length) return undefined
      let rows: TuiSidebarRow[] = cached.slice(0, 6).map((item, index) => ({
        id: `plan:${item.eventIndex}:${index}`,
        text: `${item.complete ? '✓' : '○'} ${item.text}`,
        ...(item.complete ? { tone: 'success' as const } : {}),
        activate: actions => actions.revealEvent(item.eventIndex),
      }))
      if (!rows.length && active) {
        let objectiveIndex = -1
        for (let index = render.state.events.length - 1; index >= 0; index -= 1) {
          if (render.state.events[index]?.type === 'start') { objectiveIndex = index; break }
        }
        const event = objectiveIndex >= 0 ? render.state.events[objectiveIndex] : undefined
        const objective = event?.type === 'start' ? event.input : 'Waiting for a planning request'
        rows = [{
          ...(objectiveIndex >= 0 ? { id: `plan:objective:${objectiveIndex}` } : {}),
          text: objective,
          tone: 'accent',
          ...(objectiveIndex >= 0 ? { activate: (actions: import('@flect/sdk').TuiActions) => actions.revealEvent(objectiveIndex) } : {}),
        }]
      }
      return { rows, compactRows: rows.slice(0, 3) }
    },
  })
}

export default { name, inject, apply }
