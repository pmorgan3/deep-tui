import type { Context } from 'cordis'
import type { TuiRenderContext } from '@flect/sdk'

function centered(plain: string, rendered: string, width: number): string {
  return `${' '.repeat(Math.max(2, Math.floor((width - plain.length) / 2)))}${rendered}`
}

export const name = 'welcome-prompt'
export const inject = ['tui']

export function apply(ctx: Context): void {
  ctx.tui.registerEmptyStateSection({
    id: 'flect.empty.prompt',
    priority: 10,
    render(render: TuiRenderContext) {
      if (render.state.events.length) return undefined
      return [
        '',
        centered('Everything is a plugin.', 'Everything is a plugin.', render.width),
        centered('Type a request below to begin.', render.style('Type a request below to begin.', 'muted'), render.width),
      ]
    },
  })
}

export default { name, inject, apply }
