import type { Context } from 'cordis'
import type { PermissionRisk } from '@flect/sdk'

export interface AutoPermissionConfig {
  /** Start in auto mode. Defaults to false. */
  enabled?: boolean
  /** Risk classes approved while auto mode is on. Network is excluded by default. */
  risks?: PermissionRisk[]
}

const validRisks = new Set<PermissionRisk>(['read', 'write', 'execute', 'network'])

export const name = 'permission-auto'
export const inject = ['permissions', 'tui']

export function apply(ctx: Context, config: AutoPermissionConfig = {}): void {
  const configured = config.risks ?? ['read', 'write', 'execute']
  if (!configured.length || configured.some(risk => !validRisks.has(risk))) {
    throw new TypeError('auto permission risks must contain read, write, execute, or network')
  }
  const risks = new Set(configured)
  let enabled = config.enabled ?? false

  const describe = () => [...risks].join(', ')
  const setEnabled = (next: boolean, notify?: (message: string) => void) => {
    enabled = next
    notify?.(enabled
      ? `auto mode on · ${describe()} actions run without prompts for this session`
      : 'auto mode off · guarded actions will ask again')
  }

  ctx.permissions.register({
    id: 'flect.permission.auto',
    priority: 900,
    decide(request) {
      return enabled && risks.has(request.risk) ? 'allow' : 'abstain'
    },
  })

  ctx.tui.registerStatusItem({
    id: 'flect.permission.auto.status',
    priority: 100,
    render(render) {
      return enabled ? render.style('AUTO', 'warning', true) : undefined
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.permission.auto.command',
    name: 'auto',
    description: 'Toggle session-only automatic tool approval.',
    usage: '/auto [on|off|status]',
    complete({ query }) {
      return ['on', 'off', 'status']
        .filter(value => value.startsWith(query.toLowerCase()))
        .map(value => ({ value, label: value, description: value === 'status' ? 'Show the active auto policy.' : `Turn auto mode ${value}.` }))
    },
    run(args, actions) {
      const action = args[0]?.toLowerCase()
      if (args.length > 1 || (action && !['on', 'off', 'status'].includes(action))) {
        throw new Error('usage: /auto [on|off|status]')
      }
      if (action === 'status') {
        actions.showOverlay({
          id: 'auto-status',
          title: 'Auto mode',
          tone: enabled ? 'warning' : 'muted',
          lines: [
            enabled ? 'On for this Flect session.' : 'Off.',
            `Automatic risk classes: ${describe()}`,
            'Network access still asks unless explicitly configured.',
            '',
            'Use /auto on or /auto off to change it.',
          ],
        })
        return
      }
      setEnabled(action ? action === 'on' : !enabled, message => actions.notify(message))
    },
  })
}

export default { name, inject, apply }
