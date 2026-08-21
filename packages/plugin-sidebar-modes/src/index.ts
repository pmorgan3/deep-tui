import type { Context } from 'cordis'
import type { TuiActions, TuiRenderContext, TuiSidebarRow } from '@flect/sdk'

function modeRows(ctx: Context, render: TuiRenderContext): TuiSidebarRow[] {
  return ctx.tui.listStatusItems().flatMap(item => {
    if (item.id !== 'flect.mode.plan.status' && item.id !== 'flect.permission.auto.status') return []
    const value = item.render(render)
    if (!value) return []
    const command = item.id === 'flect.mode.plan.status' ? '/plan status' : '/auto status'
    return [{
      id: `mode:${item.id}`, text: value,
      activate: async (actions: TuiActions) => { await ctx.tui.executeSlash(command, actions) },
    }]
  })
}

export const name = 'sidebar-modes'
export const inject = ['tui']

export function apply(ctx: Context): void {
  ctx.tui.registerSidebarSection({
    id: 'flect.sidebar.modes', title: 'Modes', order: 60,
    render(render) {
      const rows = modeRows(ctx, render)
      return rows.length ? { rows } : undefined
    },
  })
}

export default { name, inject, apply }
