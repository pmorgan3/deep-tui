// Add this in one command: flect plugin add ./examples/compact-tui.mjs
export const name = 'compact-tui-example'
export const inject = ['tui']

export function apply(ctx) {
  ctx.tui.registerComponent({
    id: 'example.compact-header',
    slot: 'header',
    priority: 10,
    render({ state, style }) {
      return [
        `${style('flect', 'accent', true)}  ${state.provider}/${state.model}`,
        style(state.cwd, 'muted'),
      ]
    },
  })

  ctx.tui.registerKeybinding({
    id: 'example.model-shortcut',
    keys: ['escape'],
    description: 'Use Escape to switch models.',
    priority: 10,
    handle(_event, actions) {
      if (actions.state.approval) return false
      actions.cycleModel()
      return true
    },
  })
}
