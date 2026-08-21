import type { Context } from 'cordis'
import type { AgentEvent } from '@deep-tui/sdk'

export const name = 'sidebar-activity'
export const inject = ['tui']

export function apply(ctx: Context): void {
  let source: readonly AgentEvent[] | undefined
  let toolIndex = -1
  let finish: Extract<AgentEvent, { type: 'finish' }> | undefined
  ctx.tui.registerSidebarSection({
    id: 'deep-tui.sidebar.activity', title: 'Activity', order: 30,
    render(render) {
      if (!render.state.busy && !render.state.events.length) return undefined
      if (source !== render.state.events) {
        source = render.state.events
        toolIndex = -1
        finish = undefined
        for (let index = source.length - 1; index >= 0; index -= 1) {
          const event = source[index]
          if (toolIndex < 0 && (event?.type === 'tool-call' || event?.type === 'tool-result')) toolIndex = index
          if (!finish && event?.type === 'finish') finish = event
          if (toolIndex >= 0 && finish) break
        }
      }
      const tool = toolIndex >= 0 ? render.state.events[toolIndex] : undefined
      const toolName = tool && (tool.type === 'tool-call' || tool.type === 'tool-result') ? tool.call.name : undefined
      const status = render.state.busy ? `● ${render.state.status}` : `● ${render.state.status || 'ready'}`
      const statusRow = { text: status, tone: render.state.busy ? 'warning' as const : 'success' as const }
      const toolRow = toolName ? {
        id: `activity:${toolIndex}`, text: `${render.state.busy ? 'current' : 'last'} ${toolName}`,
        activate: (actions: import('@deep-tui/sdk').TuiActions) => actions.revealEvent(toolIndex),
      } : undefined
      const rows = [statusRow, ...(toolRow ? [toolRow] : []),
        ...(finish?.type === 'finish' ? [{ text: `${finish.steps} step${finish.steps === 1 ? '' : 's'}`, tone: 'muted' as const }] : [])]
      return { rows, compactRows: [statusRow, ...(toolRow ? [toolRow] : [])] }
    },
  })
}

export default { name, inject, apply }
