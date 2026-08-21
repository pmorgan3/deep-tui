import type { Context } from 'cordis'
import type { ModelUsage, TuiRenderContext } from '@flect/sdk'

function integer(value: number | undefined): string {
  return Math.max(0, value ?? 0).toLocaleString('en-US')
}

function cost(value: number | undefined): string {
  const amount = Math.max(0, value ?? 0)
  return amount > 0 && amount < 0.000001 ? amount.toFixed(8) : amount.toFixed(6)
}

export function cacheHitPercentage(usage: ModelUsage): number | undefined {
  const cached = Math.max(0, usage.cachedInputTokens ?? 0)
  const total = usage.uncachedInputTokens === undefined
    ? Math.max(0, usage.inputTokens ?? cached)
    : cached + Math.max(0, usage.uncachedInputTokens)
  if (total === 0) return undefined
  return Math.min(100, cached / total * 100)
}

export const name = 'sidebar-context'
export const inject = ['tui']

export function apply(ctx: Context): void {
  ctx.tui.registerSidebarSection({
    id: 'flect.sidebar.context', title: 'Context & cost', order: 20,
    render(render: TuiRenderContext) {
      const usage = render.state.usage
      const latest = render.state.latestUsage
      const sessionCacheHit = cacheHitPercentage(usage)
      const latestCacheHit = latest ? cacheHitPercentage(latest) : undefined
      const cached = Math.max(0, usage.cachedInputTokens ?? 0)
      const totalInput = usage.uncachedInputTokens === undefined
        ? Math.max(0, usage.inputTokens ?? cached)
        : cached + Math.max(0, usage.uncachedInputTokens)
      const latestCached = Math.max(0, latest?.cachedInputTokens ?? 0)
      const latestTotal = latest?.uncachedInputTokens === undefined
        ? Math.max(0, latest?.inputTokens ?? latestCached)
        : latestCached + Math.max(0, latest.uncachedInputTokens)
      const used = usage.contextTokens ?? usage.inputTokens ?? 0
      const maximum = render.state.contextWindow
      const percent = maximum > 0 ? Math.min(100, used / maximum * 100) : 0
      const context = maximum > 0
        ? `context ${percent.toFixed(1)}% · ${integer(used)}/${integer(maximum)}`
        : `context ${integer(used)}`
      const costRow = `cost $${cost(usage.calculatedCostUsd)}`
      const latestCacheRow = latestCacheHit === undefined
        ? 'last cache —'
        : `last cache ${latestCacheHit.toFixed(1)}% · ${integer(latestCached)}/${integer(latestTotal)}`
      const sessionCacheRow = sessionCacheHit === undefined
        ? 'session cache —'
        : `session cache ${sessionCacheHit.toFixed(1)}% · ${integer(cached)}/${integer(totalInput)}`
      const cacheTone = latestCacheHit === undefined
        ? 'muted' as const
        : latestCacheHit >= 50 ? 'success' as const : latestCacheHit > 0 ? 'accent' as const : 'muted' as const
      const prefix = render.state.cachePrefix
      const prefixRow = !prefix
        ? 'prefix —'
        : prefix.status === 'stable'
          ? `prefix stable · ${integer(prefix.stableMessages)} msgs`
          : `${prefix.status === 'cold' ? 'prefix cold' : 'prefix changed'} · ${prefix.reason ?? 'history'}`
      return {
        rows: [
          { text: context, tone: percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'accent' },
          { text: `tok in ${integer(usage.inputTokens)} · out ${integer(usage.outputTokens)}` },
          { text: latestCacheRow, tone: cacheTone },
          { text: sessionCacheRow, tone: sessionCacheHit !== undefined && sessionCacheHit >= 50 ? 'success' : 'muted' },
          { text: prefixRow, tone: prefix?.status === 'stable' ? 'success' : prefix?.status === 'changed' ? 'warning' : 'muted' },
          { text: costRow, bold: true },
        ],
        compactRows: [
          { text: maximum > 0 ? `context ${percent.toFixed(1)}%` : context, tone: percent >= 90 ? 'danger' : 'accent' },
          { text: latestCacheHit === undefined ? latestCacheRow : `last cache ${latestCacheHit.toFixed(1)}%`, tone: cacheTone },
          { text: prefixRow, tone: prefix?.status === 'stable' ? 'success' : 'muted' },
          { text: costRow, bold: true },
        ],
      }
    },
  })
}

export default { name, inject, apply }
