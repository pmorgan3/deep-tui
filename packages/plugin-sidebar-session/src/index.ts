import path from 'node:path'
import type { Context } from 'cordis'
import type { TuiActions } from '@deep-tui/sdk'

function duration(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s open`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m open`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m open`
}

export const name = 'sidebar-session'
export const inject = ['tui']

export function apply(ctx: Context): void {
  const openSessions = async (actions: TuiActions) => {
    await ctx.tui.executeSlash('/sessions', actions)
  }
  ctx.tui.registerSidebarSection({
    id: 'deep-tui.sidebar.session', title: 'Session', order: 50,
    render(render) {
      const title = render.state.conversationTitle ?? 'New conversation'
      const titleRow = { id: 'session:current', text: title, bold: true, activate: openSessions }
      return {
        rows: [
          titleRow,
          { text: `${render.state.provider}/${render.state.model}`, tone: 'accent' },
          { text: `${render.state.conversationPersistence ?? 'ephemeral'} · ${duration(render.state.startedAt)}`, tone: 'muted' },
          { text: `theme ${render.state.theme}`, tone: 'muted' },
          { text: path.basename(render.state.cwd) || render.state.cwd, tone: 'muted' },
        ],
        compactRows: [titleRow, { text: render.state.model, tone: 'accent' }],
      }
    },
  })
}

export default { name, inject, apply }
