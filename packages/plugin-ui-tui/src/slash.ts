import type { BillingService, TuiService, TuiSlashCommand } from '@deep-tui/sdk'

function integer(value: number | undefined): string {
  return Math.max(0, value ?? 0).toLocaleString('en-US')
}

function dollars(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(6)}`
  return `$${value.toFixed(4)}`
}

export function defaultSlashCommands(tui: TuiService, billing?: BillingService): TuiSlashCommand[] {
  return [
    {
      id: 'deep-tui.default.slash.thinking',
      name: 'thinking',
      aliases: ['reasoning', 'thoughts'],
      description: 'Expand or collapse the latest model reasoning.',
      priority: -100,
      run(_args, actions) {
        actions.toggleReasoning()
      },
    },
    {
      id: 'deep-tui.default.slash.context',
      name: 'context',
      aliases: ['ctx'],
      description: 'Show current context-window and token usage.',
      priority: -100,
      run(_args, actions) {
        const used = actions.state.usage.contextTokens ?? 0
        const limit = actions.state.contextWindow
        const percentage = limit > 0 ? `${(used / limit * 100).toFixed(2)}%` : 'unknown'
        const latest = actions.state.latestUsage
        const latestCached = latest?.cachedInputTokens ?? 0
        const latestTotal = latest?.uncachedInputTokens === undefined
          ? latest?.inputTokens ?? 0
          : latestCached + latest.uncachedInputTokens
        const latestRate = latestTotal > 0 ? `${(latestCached / latestTotal * 100).toFixed(2)}%` : '—'
        const prefix = actions.state.cachePrefix
        const prefixStatus = !prefix
          ? '—'
          : `${prefix.status}${prefix.reason ? ` (${prefix.reason})` : ''} · ${integer(prefix.stableMessages)} stable messages`
        actions.showOverlay({
          id: 'context',
          title: 'Context',
          lines: [
            `${actions.state.provider}/${actions.state.model}`,
            limit > 0
              ? `${integer(used)} / ${integer(limit)} tokens (${percentage})`
              : `${integer(used)} tokens · context limit not reported`,
            '',
            `Session input     ${integer(actions.state.usage.inputTokens)}`,
            `Cache hits        ${integer(actions.state.usage.cachedInputTokens)}`,
            `Latest cache      ${latestRate}`,
            `Prompt prefix     ${prefixStatus}`,
            `Session output    ${integer(actions.state.usage.outputTokens)}`,
          ],
        })
      },
    },
    {
      id: 'deep-tui.default.slash.cost',
      name: 'cost',
      description: 'Show billable tokens, calculated charges, and live balance.',
      priority: -100,
      async run(_args, actions) {
        const cost = actions.state.usage.calculatedCostUsd
        const hasUsage = (actions.state.usage.inputTokens ?? 0) + (actions.state.usage.outputTokens ?? 0) > 0
        let balanceLines: string[]
        const billingProvider = billing?.get(actions.state.provider)
        if (billingProvider) {
          actions.showOverlay({
            id: 'cost-loading',
            title: 'Session cost',
            tone: 'success',
            lines: ['Fetching live account balance'],
          })
          try {
            const balances = await billingProvider.balances()
            balanceLines = balances.length
              ? [
                  'Live account balance',
                  ...balances.map(balance => {
                    const breakdown = [
                      balance.granted === undefined ? undefined : `granted ${balance.granted}`,
                      balance.toppedUp === undefined ? undefined : `topped up ${balance.toppedUp}`,
                    ].filter((value): value is string => Boolean(value)).join(', ')
                    return `${balance.currency} ${balance.total}${breakdown ? ` (${breakdown})` : ''}`
                  }),
                ]
              : ['Live account balance unavailable']
          } catch (error) {
            balanceLines = [`Live balance error: ${error instanceof Error ? error.message : String(error)}`]
          }
        } else {
          balanceLines = ['The active provider has no live balance endpoint.']
        }
        actions.showOverlay({
          id: 'cost',
          title: 'Session cost',
          tone: 'success',
          lines: [
            !hasUsage
              ? 'No model usage yet'
              : cost === undefined
                ? 'Session charge unavailable'
                : `${dollars(cost)} session cost`,
            '',
            `Input tokens      ${integer(actions.state.usage.inputTokens)}`,
            `  cache hit       ${integer(actions.state.usage.cachedInputTokens)}`,
            `  cache miss      ${integer(actions.state.usage.uncachedInputTokens)}`,
            `Output tokens     ${integer(actions.state.usage.outputTokens)}`,
            '',
            ...balanceLines,
            '',
            !hasUsage
              ? 'Run a prompt to begin tracking this session.'
              : cost === undefined
              ? 'The active provider did not contribute pricing.'
              : 'Calculated from actual API token classes; balance is authoritative.',
          ],
        })
      },
    },
    {
      id: 'deep-tui.default.slash.model',
      name: 'model',
      aliases: ['models'],
      description: 'Show or switch the active model.',
      usage: '/model [name]',
      priority: -100,
      complete({ query, state }) {
        const normalized = query.toLowerCase()
        return state.models
          .filter(model => model.toLowerCase().startsWith(normalized))
          .map(model => ({
            value: model,
            label: model,
            description: model === state.model ? 'current model' : 'switch model',
          }))
      },
      run(args, actions) {
        const requested = args[0]
        if (!requested) {
          actions.showOverlay({
            id: 'models',
            title: 'Models',
            lines: [
              ...actions.state.models.map(model => `${model === actions.state.model ? '›' : ' '} ${model}`),
              '',
              'Use /model <name> or Ctrl+P to switch.',
            ],
          })
          return
        }
        if (!actions.state.models.includes(requested)) {
          actions.showOverlay({
            id: 'model-not-found',
            title: 'Unknown model',
            tone: 'danger',
            lines: [
              `"${requested}" is not configured.`,
              `Available: ${actions.state.models.join(', ')}`,
            ],
          })
          return
        }
        actions.setModel(requested)
      },
    },
    {
      id: 'deep-tui.default.slash.help',
      name: 'help',
      aliases: ['commands'],
      description: 'List slash commands contributed by active plugins.',
      priority: -100,
      run(_args, actions) {
        const commands = tui.listSlashCommands().sort((left, right) => left.name.localeCompare(right.name))
        actions.showOverlay({
          id: 'slash-help',
          title: 'Slash commands',
          lines: commands.map(command => {
            const usage = command.usage ?? `/${command.name}`
            return `${usage.padEnd(22)} ${command.description}`
          }),
        })
      },
    },
    {
      id: 'deep-tui.default.slash.plugins',
      name: 'plugins',
      description: 'Show active TUI contribution counts.',
      priority: -100,
      run(_args, actions) {
        actions.showOverlay({
          id: 'plugins',
          title: 'TUI composition',
          lines: [
            `${tui.listComponents().length} visual components`,
            `${tui.listKeybindings().length} keybindings`,
            `${tui.listSlashCommands().length} slash commands`,
            `Shell: ${tui.shell()?.id ?? 'none'}`,
          ],
        })
      },
    },
    {
      id: 'deep-tui.default.slash.clear',
      name: 'clear',
      aliases: ['new'],
      description: 'Clear the visible transcript while keeping session totals.',
      priority: -100,
      run(_args, actions) {
        actions.clear()
      },
    },
    {
      id: 'deep-tui.default.slash.exit',
      name: 'exit',
      aliases: ['quit'],
      description: 'Exit the TUI.',
      priority: -100,
      run(_args, actions) {
        actions.exit()
      },
    },
  ]
}
