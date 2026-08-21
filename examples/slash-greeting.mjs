// Add this in one command: deep-tui plugin add ./examples/slash-greeting.mjs
export const name = 'slash-greeting-example'
export const inject = ['tui']

export function apply(ctx) {
  ctx.tui.registerSlashCommand({
    id: 'example.greeting',
    name: 'greet',
    aliases: ['hello'],
    description: 'Open a greeting supplied by a plugin.',
    usage: '/greet [name]',
    priority: 10,
    complete({ query }) {
      return ['world', 'friend', 'plugin author']
        .filter(value => value.startsWith(query.toLowerCase()))
        .map(value => ({ value, description: `Greet ${value}` }))
    },
    run(args, actions) {
      const target = args.join(' ') || 'world'
      actions.showOverlay({
        id: 'example-greeting',
        title: 'Plugin command',
        lines: [`Hello, ${target}!`, 'This entire slash command came from a local plugin.'],
      })
    },
  })
}
