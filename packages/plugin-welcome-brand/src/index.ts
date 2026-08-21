import type { Context } from 'cordis'
import type { TuiRenderContext } from '@flect/sdk'

function centered(plain: string, rendered: string, width: number): string {
  return `${' '.repeat(Math.max(2, Math.floor((width - plain.length) / 2)))}${rendered}`
}

export const name = 'welcome-brand'
export const inject = ['tui']

export function apply(ctx: Context): void {
  ctx.tui.registerEmptyStateSection({
    id: 'flect.empty.brand',
    priority: 20,
    render(render: TuiRenderContext) {
      if (render.state.events.length) return undefined
      return [
        '',
        '',
        centered('F L E C T', render.style('F L E C T', 'accent', true), render.width),
        centered('bend the harness, not your workflow', render.style('bend the harness, not your workflow', 'muted'), render.width),
      ]
    },
  })
}

export default { name, inject, apply }
