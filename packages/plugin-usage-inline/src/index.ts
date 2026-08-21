import type { Context } from 'cordis'
import type { ModelUsage } from '@flect/sdk'

export interface InlineUsageConfig {
  inline?: boolean
  footer?: boolean
  costPrecision?: number
}

function tokens(value: number | undefined): string {
  return Math.max(0, value ?? 0).toLocaleString('en-US')
}

function dollars(value: number | undefined, precision: number): string {
  const amount = Math.max(0, value ?? 0)
  if (amount > 0 && amount < 10 ** -precision) return amount.toFixed(Math.min(10, precision + 2))
  return amount.toFixed(precision)
}

function hasUsage(usage: ModelUsage | undefined): usage is ModelUsage {
  return Boolean(usage && Object.values(usage).some(value => typeof value === 'number'))
}

export function formatMessageUsage(usage: ModelUsage, precision = 6): string {
  return [
    `cost $${dollars(usage.calculatedCostUsd, precision)}`,
    `tok in ${tokens(usage.inputTokens)}`,
    `out ${tokens(usage.outputTokens)}`,
    `cache ${tokens(usage.cachedInputTokens)}`,
  ].join(' · ')
}

export function formatSessionCost(usage: ModelUsage, precision = 6): string {
  return `session cost $${dollars(usage.calculatedCostUsd, precision)}`
}

export const name = 'inline-usage'
export const inject = ['tui']

export function apply(ctx: Context, config: InlineUsageConfig = {}): void {
  const precision = config.costPrecision ?? 6
  if (!Number.isInteger(precision) || precision < 2 || precision > 10) {
    throw new TypeError('inline usage costPrecision must be an integer from 2 through 10')
  }

  if (config.inline !== false) {
    ctx.tui.registerEventRenderer({
      id: 'flect.usage.inline',
      mode: 'append',
      priority: 100,
      render(event, render) {
        if ((event.type !== 'assistant' && event.type !== 'assistant-finish') || !hasUsage(event.usage)) return undefined
        return [render.style(`  ↳ ${formatMessageUsage(event.usage, precision)}`, 'muted')]
      },
    })
  }

  if (config.footer !== false) {
    ctx.tui.registerStatusItem({
      id: 'flect.usage.session-cost',
      priority: 50,
      render(render) {
        return hasUsage(render.state.usage)
          ? render.style(formatSessionCost(render.state.usage, precision), 'accent', true)
          : undefined
      },
    })
  }
}

export default { name, inject, apply }
