import type { Context } from 'cordis'
import type {
  AgentLifecycleFinishContext,
  AgentLifecycleModelContext,
  AgentLifecycleRunContext,
  AgentLifecycleStepContext,
  ModelUsage,
} from '@flect/sdk'

export interface BudgetConfig {
  enabled?: boolean
  maxSteps?: number
  maxDurationMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxCostUsd?: number
}

export interface BudgetSnapshot {
  runId: string
  startedAt: number
  elapsedMs: number
  steps: number
  usage: ModelUsage
  status?: AgentLifecycleFinishContext['status']
  stoppedReason?: string
}

interface ActiveBudget extends BudgetSnapshot {
  context: AgentLifecycleRunContext
}

function positiveInteger(value: number | undefined, fallback: number | undefined, label: string): number | undefined {
  const resolved = value ?? fallback
  if (resolved === undefined) return undefined
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return resolved
}

function positiveNumber(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number`)
  return value
}

function usageValue(usage: ModelUsage, key: keyof ModelUsage): number {
  return Math.max(0, usage[key] ?? 0)
}

function reasonFor(snapshot: BudgetSnapshot, limits: ResolvedLimits, nextStep: number): string | undefined {
  if (limits.maxDurationMs !== undefined && snapshot.elapsedMs >= limits.maxDurationMs) {
    return `run time budget reached (${limits.maxDurationMs}ms)`
  }
  if (limits.maxSteps !== undefined && nextStep > limits.maxSteps) {
    return `model-step budget reached (${limits.maxSteps})`
  }
  const input = usageValue(snapshot.usage, 'inputTokens')
  if (limits.maxInputTokens !== undefined && input >= limits.maxInputTokens) {
    return `input-token budget reached (${limits.maxInputTokens})`
  }
  const output = usageValue(snapshot.usage, 'outputTokens')
  if (limits.maxOutputTokens !== undefined && output >= limits.maxOutputTokens) {
    return `output-token budget reached (${limits.maxOutputTokens})`
  }
  if (limits.maxTotalTokens !== undefined && input + output >= limits.maxTotalTokens) {
    return `total-token budget reached (${limits.maxTotalTokens})`
  }
  const cost = usageValue(snapshot.usage, 'calculatedCostUsd')
  if (limits.maxCostUsd !== undefined && cost >= limits.maxCostUsd) {
    return `cost budget reached ($${limits.maxCostUsd})`
  }
  return undefined
}

export interface ResolvedLimits {
  maxSteps?: number
  maxDurationMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxCostUsd?: number
}

function resolveLimits(config: BudgetConfig): ResolvedLimits {
  const maxSteps = positiveInteger(config.maxSteps, 64, 'budget maxSteps')
  const maxDurationMs = positiveInteger(config.maxDurationMs, 30 * 60_000, 'budget maxDurationMs')
  const maxInputTokens = positiveInteger(config.maxInputTokens, undefined, 'budget maxInputTokens')
  const maxOutputTokens = positiveInteger(config.maxOutputTokens, undefined, 'budget maxOutputTokens')
  const maxTotalTokens = positiveInteger(config.maxTotalTokens, undefined, 'budget maxTotalTokens')
  const maxCostUsd = positiveNumber(config.maxCostUsd, 'budget maxCostUsd')
  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  }
}

function formatLimit(label: string, value: number | undefined, suffix = ''): string {
  return `${label.padEnd(13)} ${value === undefined ? 'off' : `${value.toLocaleString('en-US')}${suffix}`}`
}

function cloneSnapshot(value: BudgetSnapshot): BudgetSnapshot {
  return {
    runId: value.runId,
    startedAt: value.startedAt,
    elapsedMs: value.elapsedMs,
    steps: value.steps,
    usage: { ...value.usage },
    ...(value.status ? { status: value.status } : {}),
    ...(value.stoppedReason ? { stoppedReason: value.stoppedReason } : {}),
  }
}

export class BudgetController {
  private readonly active = new Map<string, ActiveBudget>()
  private latestValue: BudgetSnapshot | undefined
  private enabledValue: boolean

  constructor(
    private readonly ctx: Context,
    readonly limits: ResolvedLimits,
    enabled = true,
  ) {
    this.enabledValue = enabled
  }

  get enabled(): boolean { return this.enabledValue }
  setEnabled(value: boolean): void { this.enabledValue = value; this.ctx.tui.invalidate() }
  latest(): BudgetSnapshot | undefined { return this.latestValue ? cloneSnapshot(this.latestValue) : undefined }
  current(): BudgetSnapshot | undefined {
    const value = [...this.active.values()].at(-1)
    if (!value) return undefined
    return cloneSnapshot({ ...value, elapsedMs: Date.now() - value.startedAt })
  }

  beforeRun(context: AgentLifecycleRunContext): void {
    if (!this.enabledValue) return
    const startedAt = Date.now()
    this.active.set(context.runId, { context, runId: context.runId, startedAt, elapsedMs: 0, steps: 0, usage: {} })
    this.ctx.tui.invalidate()
  }

  beforeStep(context: AgentLifecycleStepContext): string | undefined {
    if (!this.enabledValue) return undefined
    const active = this.active.get(context.runId)
    if (!active) return undefined
    active.elapsedMs = Date.now() - active.startedAt
    active.steps = context.step - 1
    active.usage = { ...context.usage }
    const reason = reasonFor(active, this.limits, context.step)
    if (reason) active.stoppedReason = reason
    else delete active.stoppedReason
    this.ctx.tui.invalidate()
    return reason
  }

  afterModel(context: AgentLifecycleModelContext): void {
    const active = this.active.get(context.runId)
    if (!active) return
    active.elapsedMs = Date.now() - active.startedAt
    active.steps = context.step
    active.usage = { ...context.usage }
    this.ctx.tui.invalidate()
  }

  afterRun(context: AgentLifecycleFinishContext): void {
    const active = this.active.get(context.runId)
    if (!active) return
    active.elapsedMs = Date.now() - active.startedAt
    active.steps = context.steps
    active.usage = { ...context.usage }
    active.status = context.status
    this.latestValue = cloneSnapshot(active)
    this.active.delete(context.runId)
    this.ctx.tui.invalidate()
  }
}

export const name = 'run-budget'
export const inject = ['agentHooks', 'tui']

export function apply(ctx: Context, config: BudgetConfig = {}): void {
  const controller = new BudgetController(ctx, resolveLimits(config), config.enabled !== false)
  ctx.agentHooks.register({
    id: 'flect.budget.policy',
    priority: 100,
    beforeRun: context => controller.beforeRun(context),
    beforeStep: context => controller.beforeStep(context),
    afterModel: context => controller.afterModel(context),
    afterRun: context => controller.afterRun(context),
  })

  ctx.tui.registerStatusItem({
    id: 'flect.budget.status', priority: 180,
    render(render) {
      if (!controller.enabled) return render.style('BUDGET OFF', 'warning', true)
      const current = controller.current()
      if (!current) return undefined
      return render.style(`BUDGET ${current.steps}/${controller.limits.maxSteps ?? '∞'}`, current.stoppedReason ? 'danger' : 'accent', true)
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.budget.command', name: 'budget', description: 'Inspect or toggle per-run safety budgets.',
    usage: '/budget [status|on|off]',
    complete({ query }) {
      return ['status', 'on', 'off'].filter(value => value.startsWith(query.toLowerCase())).map(value => ({ value }))
    },
    run(args, actions) {
      const action = args[0]?.toLowerCase() ?? 'status'
      if (args.length > 1 || !['status', 'on', 'off'].includes(action)) throw new Error('usage: /budget [status|on|off]')
      if (action === 'on' || action === 'off') {
        controller.setEnabled(action === 'on')
        actions.notify(`run budget ${action}`)
        return
      }
      const current = controller.current() ?? controller.latest()
      actions.showOverlay({
        id: 'flect.budget.status', title: 'Run budget', tone: controller.enabled ? 'accent' : 'warning',
        lines: [
          controller.enabled ? 'Enabled.' : 'Disabled for this Flect process.',
          '',
          formatLimit('model steps', controller.limits.maxSteps),
          formatLimit('duration', controller.limits.maxDurationMs, 'ms'),
          formatLimit('input tokens', controller.limits.maxInputTokens),
          formatLimit('output tokens', controller.limits.maxOutputTokens),
          formatLimit('total tokens', controller.limits.maxTotalTokens),
          formatLimit('cost', controller.limits.maxCostUsd, ' USD'),
          ...(current ? [
            '', `Last/current run: ${current.steps} steps · ${current.elapsedMs}ms`,
            `Usage: ${(current.usage.inputTokens ?? 0).toLocaleString('en-US')} in · ${(current.usage.outputTokens ?? 0).toLocaleString('en-US')} out · $${(current.usage.calculatedCostUsd ?? 0).toFixed(6)}`,
            ...(current.stoppedReason ? [`Stopped: ${current.stoppedReason}`] : []),
          ] : []),
        ],
      })
    },
  })
}

export default { name, inject, apply }
