import type { Context } from 'cordis'
import type { TuiRenderContext } from '@deep-tui/sdk'

function centered(plain: string, rendered: string, width: number): string {
  return `${' '.repeat(Math.max(2, Math.floor((width - plain.length) / 2)))}${rendered}`
}

export const name = 'welcome-brand'
export const inject = ['tui']

export function apply(ctx: Context): void {
  ctx.tui.registerEmptyStateSection({
    id: 'deep-tui.empty.brand',
    priority: 20,
    render(render: TuiRenderContext) {
      if (render.state.events.length) return undefined
      return [
        '',
        '',
        centered('D E E P  T U I', render.style('D E E P  T U I', 'accent', true), render.width),
        centered('bend the harness, not your workflow', render.style('bend the harness, not your workflow', 'muted'), render.width),
      ]
    },
  })
}

export default { name, inject, apply }
