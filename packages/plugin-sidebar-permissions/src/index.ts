import path from 'node:path'
import type { Context } from 'cordis'
import type { TuiActions } from '@deep-tui/sdk'

export const name = 'sidebar-permissions'
export const inject = ['permissionRules', 'tui']

export function apply(ctx: Context): void {
  const manage = async (actions: TuiActions) => { await ctx.tui.executeSlash('/permissions', actions) }
  ctx.tui.registerSidebarSection({
    id: 'deep-tui.sidebar.permissions', title: 'Permissions', order: 70,
    render(render) {
      const projectRoot = path.resolve(render.state.cwd)
      const rules = ctx.permissionRules.list().filter(rule => path.resolve(rule.projectRoot) === projectRoot)
      if (!rules.length) return undefined
      const session = rules.filter(rule => rule.scope === 'session').length
      const project = rules.length - session
      const summary = {
        id: 'permissions:manage', text: `${rules.length} remembered · ${session} session · ${project} project`,
        activate: manage,
      }
      const recent = [...rules].reverse().slice(0, 3).map(rule => ({
        id: `permission:${rule.id}`, text: `${rule.scope} · ${rule.label}`, tone: 'muted' as const,
        activate: manage,
      }))
      return { rows: [summary, ...recent], compactRows: [summary] }
    },
  })
  ctx.effect(() => ctx.permissionRules.subscribe(() => ctx.tui.invalidate()), 'sidebar permission updates')
}

export default { name, inject, apply }
