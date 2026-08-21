import type { Context } from 'cordis'
import type { PermissionRisk } from '@flect/sdk'

export interface PlanModeConfig {
  /** Start in plan mode. Defaults to false. */
  enabled?: boolean
  /** Permission risk classes denied in plan mode. */
  blockedRisks?: PermissionRisk[]
  /** Replace the default planning instruction. */
  prompt?: string
}

const validRisks = new Set<PermissionRisk>(['read', 'write', 'execute', 'network'])

const defaultPrompt = [
  'PLAN MODE IS ACTIVE.',
  'Investigate the request and produce an implementation plan only.',
  'Use workspace read and search tools when evidence is needed.',
  'Do not modify files, execute commands, access the network, or perform other side effects.',
  'Resolve details from the available code instead of asking questions that the workspace can answer.',
  'The final response should identify scope, relevant files and contracts, ordered implementation steps, risks, and verification criteria.',
].join('\n')

const inactivePrompt = [
  'PLAN MODE IS OFF.',
  'Normal implementation behavior and the configured permission policies apply.',
].join('\n')

export const name = 'plan-mode'
export const inject = ['permissions', 'prompts', 'tui']

export function apply(ctx: Context, config: PlanModeConfig = {}): void {
  const configured = config.blockedRisks ?? ['write', 'execute', 'network']
  if (configured.some(risk => !validRisks.has(risk))) {
    throw new TypeError('plan mode blockedRisks must contain read, write, execute, or network')
  }
  const blockedRisks = new Set(configured)
  let enabled = false
  let suppressAutoStatus: (() => void) | undefined
  const releaseAutoSuppression = () => {
    const dispose = suppressAutoStatus
    suppressAutoStatus = undefined
    dispose?.()
  }

  const setEnabled = (next: boolean, notify?: (message: string) => void) => {
    enabled = next
    if (enabled && !suppressAutoStatus) {
      suppressAutoStatus = ctx.tui.registerStatusItem({
        id: 'flect.permission.auto.status',
        priority: 10_000,
        render: () => undefined,
      })
    } else if (!enabled && suppressAutoStatus) {
      releaseAutoSuppression()
    }
    notify?.(enabled
      ? 'plan mode on · workspace exploration is read-only'
      : 'plan mode off · normal tool permissions restored')
  }

  ctx.prompts.register({
    id: 'flect.mode.plan.prompt',
    order: 1_000,
    placement: 'context',
    render: () => enabled ? (config.prompt ?? defaultPrompt) : inactivePrompt,
  })

  ctx.permissions.register({
    id: 'flect.mode.plan.permissions',
    priority: 2_000,
    decide(request) {
      return enabled && blockedRisks.has(request.risk) ? 'deny' : 'abstain'
    },
  })

  ctx.tui.registerStatusItem({
    id: 'flect.mode.plan.status',
    priority: 200,
    render(render) {
      return enabled ? render.style('PLAN', 'accent', true) : undefined
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.mode.plan.command',
    name: 'plan',
    description: 'Enter read-only planning mode.',
    usage: '/plan [on|off|status]',
    complete({ query }) {
      return ['on', 'off', 'status']
        .filter(value => value.startsWith(query.toLowerCase()))
        .map(value => ({
          value,
          label: value,
          description: value === 'status' ? 'Show the active plan policy.' : `Turn plan mode ${value}.`,
        }))
    },
    run(args, actions) {
      const action = args[0]?.toLowerCase() ?? 'on'
      if (args.length > 1 || !['on', 'off', 'status'].includes(action)) {
        throw new Error('usage: /plan [on|off|status]')
      }
      if (action === 'status') {
        actions.showOverlay({
          id: 'plan-status',
          title: 'Plan mode',
          tone: enabled ? 'accent' : 'muted',
          lines: [
            enabled ? 'On for this Flect session.' : 'Off.',
            `Blocked risk classes: ${[...blockedRisks].join(', ') || 'none'}`,
            'Read-only workspace tools remain available.',
            'Auto approval is overridden while plan mode is active.',
            '',
            'Use /plan to enter or /plan off to leave.',
          ],
        })
        return
      }
      setEnabled(action === 'on', message => actions.notify(message))
    },
  })

  if (config.enabled) setEnabled(true)
  ctx.effect(() => releaseAutoSuppression, 'plan mode status cleanup')
}

export default { name, inject, apply }
