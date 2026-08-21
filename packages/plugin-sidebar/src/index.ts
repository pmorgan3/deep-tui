import type { Context } from 'cordis'
import type { TuiActions, TuiRenderContext, TuiSidebarRow } from '@flect/sdk'

export interface SidebarConfig {
  visible?: boolean
  minWidth?: number
  fullWidth?: number
  width?: number
  minSidebarWidth?: number
  maxSidebarWidth?: number
  minMainWidth?: number
}

interface RenderedLine {
  text: string
  interactive?: number
}

export const name = 'sidebar-compositor'
export const inject = ['tui']

export function apply(ctx: Context, config: SidebarConfig = {}): void {
  const minWidth = Math.max(80, config.minWidth ?? 96)
  const fullWidth = Math.max(minWidth, config.fullWidth ?? 120)
  const minSidebarWidth = Math.max(16, Math.round(config.minSidebarWidth ?? 22))
  const maxSidebarWidth = Math.max(minSidebarWidth, Math.round(config.maxSidebarWidth ?? 60))
  const minMainWidth = Math.max(30, Math.round(config.minMainWidth ?? 40))
  if (config.width !== undefined && (!Number.isFinite(config.width) || config.width < 1)) {
    throw new TypeError('sidebar width must be a positive number')
  }
  let visible = config.visible !== false
  let focused = false
  let dragging = false
  let resizedWidth = config.width === undefined ? undefined : Math.round(config.width)
  let selected = 0
  let interactive: TuiSidebarRow[] = []

  const clampSidebarWidth = (totalWidth: number, requested: number) => {
    const maximum = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, totalWidth - minMainWidth - 1))
    return Math.max(minSidebarWidth, Math.min(maximum, requested))
  }
  const sidebarWidth = (totalWidth: number) => clampSidebarWidth(
    totalWidth,
    resizedWidth ?? Math.min(34, Math.floor(totalWidth * 0.32)),
  )

  const invalidate = () => ctx.tui.invalidate()
  const setVisible = (next: boolean) => {
    visible = next
    if (!visible) {
      focused = false
      dragging = false
    }
    invalidate()
  }

  const crop = (lines: RenderedLine[], render: TuiRenderContext): string[] => {
    if (lines.length <= render.height) return lines.map(line => line.text)
    const selectedLine = focused
      ? Math.max(0, lines.findIndex(line => line.interactive === selected))
      : 0
    const room = Math.max(1, render.height)
    const start = Math.max(0, Math.min(lines.length - room, selectedLine - Math.floor(room / 2)))
    const output = lines.slice(start, start + room).map(line => line.text)
    if (start > 0) output[0] = render.style('  ↑ more', 'muted')
    if (start + room < lines.length) output[output.length - 1] = render.style('  ↓ more', 'muted')
    return output
  }

  ctx.tui.registerComponent({
    id: 'flect.sidebar.compositor',
    slot: 'sidebar',
    priority: 500,
    preferredWidth: state => sidebarWidth(state.width),
    render(render) {
      if (!visible || render.state.width < minWidth) {
        interactive = []
        return []
      }
      const compact = render.state.width < fullWidth
      const lines: RenderedLine[] = []
      const nextInteractive: TuiSidebarRow[] = []
      for (const section of ctx.tui.listSidebarSections()) {
        const view = section.render(render)
        const rows = view && compact && view.compactRows ? view.compactRows : view?.rows
        if (!rows?.length) continue
        if (lines.length) lines.push({ text: '' })
        lines.push({ text: render.style(`  ${section.title.toUpperCase()}`, 'muted', true) })
        for (const row of rows) {
          if (!row.text) continue
          const canActivate = Boolean(row.activate)
          const index = canActivate ? nextInteractive.push(row) - 1 : undefined
          const marker = canActivate && focused && index === selected
            ? render.style('›', 'accent', true)
            : ' '
          const wrapped = render.wrap(row.text, Math.max(1, render.width - 2))
          wrapped.forEach((text, lineIndex) => {
            const value = row.tone || row.bold
              ? render.style(text, row.tone, row.bold)
              : text
            lines.push({
              text: render.fit(`${lineIndex === 0 ? marker : ' '} ${value}`, render.width),
              ...(index === undefined ? {} : { interactive: index }),
            })
          })
        }
      }
      interactive = nextInteractive
      selected = interactive.length ? (selected + interactive.length) % interactive.length : 0
      if (!lines.length) return []
      lines.push({ text: '' })
      lines.push({
        text: dragging
          ? render.style('  dragging · release to set', 'accent', true)
          : focused
            ? render.style('  ↑↓ select · enter · esc', 'accent')
            : render.style('  tab focus · drag edge · ctrl+b', 'muted'),
      })
      return crop(lines, render)
    },
  })

  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.resize-start', keys: ['mouse-left'], priority: 2_000,
    description: 'Grab the sidebar divider for resizing.',
    handle(event, actions) {
      const mouse = event.mouse
      if (!visible || !mouse || actions.state.width < minWidth) return false
      const divider = actions.state.width - sidebarWidth(actions.state.width)
      const inBody = mouse.y >= 3 && mouse.y <= Math.max(3, actions.state.height - 4)
      if (!inBody || Math.abs(mouse.x - divider) > 1) return false
      dragging = true
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.resize-drag', keys: ['mouse-drag'], priority: 2_000,
    description: 'Resize the sidebar while its divider is grabbed.',
    handle(event, actions) {
      if (!dragging || !event.mouse) return false
      resizedWidth = clampSidebarWidth(actions.state.width, actions.state.width - event.mouse.x)
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.resize-end', keys: ['mouse-release'], priority: 2_000,
    description: 'Finish resizing the sidebar.',
    handle() {
      if (!dragging) return false
      dragging = false
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.toggle', keys: ['ctrl+b'], priority: 1_000,
    description: 'Show or hide the composable sidebar.',
    handle(_event, actions) {
      if (visible) setVisible(false)
      else {
        visible = true
        focused = actions.state.width >= minWidth
        invalidate()
      }
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.focus', keys: ['tab'], priority: 500,
    description: 'Move keyboard focus into or out of the sidebar.',
    handle(_event, actions) {
      if (!visible || actions.state.width < minWidth || actions.state.input
        || actions.state.approval || actions.state.overlay) return false
      focused = !focused
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.previous', keys: ['up'], priority: 1_000,
    description: 'Select the previous interactive sidebar row.',
    handle() {
      if (!focused || !interactive.length) return false
      selected = (selected - 1 + interactive.length) % interactive.length
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.next', keys: ['down'], priority: 1_000,
    description: 'Select the next interactive sidebar row.',
    handle() {
      if (!focused || !interactive.length) return false
      selected = (selected + 1) % interactive.length
      invalidate()
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.activate', keys: ['enter'], priority: 1_000,
    description: 'Activate the selected sidebar row.',
    async handle(_event, actions) {
      if (!focused) return false
      const row = interactive[selected]
      if (!row?.activate) return true
      try {
        await row.activate(actions)
      } catch (error) {
        actions.notify(error instanceof Error ? error.message : String(error))
      }
      return true
    },
  })
  ctx.tui.registerKeybinding({
    id: 'flect.sidebar.blur', keys: ['escape'], priority: 1_000,
    description: 'Return keyboard focus to the prompt.',
    handle() {
      if (!focused) return false
      focused = false
      invalidate()
      return true
    },
  })

  const focus = (actions: TuiActions) => {
    visible = true
    focused = actions.state.width >= minWidth
    invalidate()
    if (!focused) actions.notify(`sidebar requires a terminal at least ${minWidth} columns wide`)
  }
  ctx.tui.registerSlashCommand({
    id: 'flect.sidebar.command', name: 'sidebar',
    description: 'Show, hide, or focus the composable sidebar.',
    usage: '/sidebar [show|hide|focus|status|reset]',
    complete({ query }) {
      return ['show', 'hide', 'focus', 'status', 'reset']
        .filter(value => value.startsWith(query.toLowerCase()))
        .map(value => ({ value, label: value, description: `${value} the sidebar.` }))
    },
    run(args, actions) {
      const action = args[0]?.toLowerCase() ?? 'focus'
      if (args.length > 1 || !['show', 'hide', 'focus', 'status', 'reset'].includes(action)) {
        throw new Error('usage: /sidebar [show|hide|focus|status|reset]')
      }
      if (action === 'hide') setVisible(false)
      else if (action === 'show') setVisible(true)
      else if (action === 'focus') focus(actions)
      else if (action === 'reset') {
        resizedWidth = undefined
        invalidate()
        actions.notify(`sidebar width reset to ${sidebarWidth(actions.state.width)} columns`)
      } else actions.notify(
        `sidebar ${visible ? 'shown' : 'hidden'}${focused ? ' and focused' : ''} · ${sidebarWidth(actions.state.width)} columns`,
      )
    },
  })
}

export default { name, inject, apply }
