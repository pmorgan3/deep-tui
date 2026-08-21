import type { Context } from 'cordis'
import type { TuiActions, TuiSidebarRow, WorkspaceRoot } from '@deep-tui/sdk'

export const name = 'sidebar-folders'
export const inject = ['project', 'tui', 'workspace']

export async function apply(ctx: Context): Promise<void> {
  let roots: readonly WorkspaceRoot[] = await ctx.workspace.roots({ cwd: ctx.project.root })
  let active = true
  const refresh = async (cwd = ctx.project.root) => {
    const next = await ctx.workspace.roots({ cwd })
    if (!active) return
    roots = next
    ctx.tui.invalidate()
  }
  const open = async (actions: TuiActions) => { await ctx.tui.executeSlash('/folders status', actions) }

  ctx.tui.registerSidebarSection({
    id: 'deep-tui.sidebar.folders', title: 'Folders', order: 55,
    render() {
      if (!roots.length) return undefined
      const unavailable = roots.filter(root => !root.available).length
      const summary = {
        id: 'folders:summary',
        text: `${roots.length} folder${roots.length === 1 ? '' : 's'}${unavailable ? ` · ${unavailable} unavailable` : ''}`,
        tone: unavailable ? 'warning' as const : 'accent' as const,
        activate: open,
      }
      const folderRows: TuiSidebarRow[] = roots.map(root => ({
        id: `folder:${root.id}`,
        text: `${root.available ? '●' : '○'} ${root.prefix} · ${root.available ? root.access : 'unavailable'}`,
        ...(root.available
          ? root.access === 'read-only' ? { tone: 'muted' as const } : {}
          : { tone: 'danger' as const }),
        activate: open,
      }))
      return {
        rows: [
          summary,
          ...folderRows,
        ],
        compactRows: [summary],
      }
    },
  })
  ctx.tui.registerSessionHook({
    id: 'deep-tui.sidebar.folders.session', priority: 20,
    start(actions) { return refresh(actions.state.cwd) },
  })
  const unsubscribe = ctx.workspace.subscribe(() => { void refresh() })
  ctx.effect(() => () => {
    active = false
    unsubscribe()
  }, 'sidebar folder updates')
}

export default { name, inject, apply }
