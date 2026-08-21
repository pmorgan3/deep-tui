import type { Context } from 'cordis'
import { OpenAiCompatibleProvider } from '@deep-tui/plugin-provider-openai-compatible'
import type {
  BillingBalance,
  BillingProvider,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ModelStreamEvent,
} from '@deep-tui/sdk'

export type DeepSeekModelAlias = 'pro' | 'flash'
export type DeepSeekModelId = 'deepseek-v4-pro' | 'deepseek-v4-flash'
export type DeepSeekModel = DeepSeekModelAlias | DeepSeekModelId
export type DeepSeekReasoningEffort = 'high' | 'max'

export interface DeepSeekConfig {
  /** Provider id used by the agent. */
  id?: string
  /** Override only for an OpenAI-compatible DeepSeek proxy. */
  baseUrl?: string
  /** Additional non-secret headers sent with every request. */
  headers?: Record<string, string>
  streaming?: boolean
  streamUsage?: boolean
  /** Enable thinking mode. Defaults to true. */
  thinking?: boolean
  /** Thinking effort sent to DeepSeek. Defaults to max. */
  reasoningEffort?: DeepSeekReasoningEffort
  /**
   * Override per-million-token tariffs used for local charge calculation.
   * Each supplied field is treated as a fixed proxy/vendor rate in both pricing periods.
   */
  pricing?: Partial<Record<DeepSeekModelId, Partial<DeepSeekPricing>>>
}

export interface DeepSeekPricing {
  cachedInputPerMillion: number
  uncachedInputPerMillion: number
  outputPerMillion: number
}

export type DeepSeekPricingPeriod = 'peak' | 'off-peak'

const modelAliases: Record<DeepSeekModelAlias, DeepSeekModelId> = {
  pro: 'deepseek-v4-pro',
  flash: 'deepseek-v4-flash',
}

/** Official peak API prices checked 2026-08-21; configurable because vendor prices can change. */
export const defaultDeepSeekPricing: Record<DeepSeekModelId, DeepSeekPricing> = {
  'deepseek-v4-flash': {
    cachedInputPerMillion: 0.014,
    uncachedInputPerMillion: 0.44,
    outputPerMillion: 1.32,
  },
  'deepseek-v4-pro': {
    cachedInputPerMillion: 0.044,
    uncachedInputPerMillion: 1.32,
    outputPerMillion: 3.96,
  },
}

/** Official off-peak API prices checked 2026-08-21. */
export const defaultDeepSeekOffPeakPricing: Record<DeepSeekModelId, DeepSeekPricing> = {
  'deepseek-v4-flash': {
    cachedInputPerMillion: 0.007,
    uncachedInputPerMillion: 0.22,
    outputPerMillion: 0.66,
  },
  'deepseek-v4-pro': {
    cachedInputPerMillion: 0.022,
    uncachedInputPerMillion: 0.66,
    outputPerMillion: 1.98,
  },
}

/** DeepSeek peak windows are 01:00-04:00 and 06:00-10:00 UTC, with end times exclusive. */
export function deepSeekPricingPeriod(at: Date | number = Date.now()): DeepSeekPricingPeriod {
  const hour = new Date(at).getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 'peak' : 'off-peak'
}

function calculateCost(usage: ModelUsage, pricing: DeepSeekPricing): number {
  const input = usage.inputTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  const uncached = usage.uncachedInputTokens ?? Math.max(0, input - cached)
  const output = usage.outputTokens ?? 0
  return (
    cached * pricing.cachedInputPerMillion
    + uncached * pricing.uncachedInputPerMillion
    + output * pricing.outputPerMillion
  ) / 1_000_000
}

export function resolveDeepSeekModel(model: string): DeepSeekModelId {
  if (model === 'pro' || model === 'flash') return modelAliases[model]
  if (model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash') return model
  throw new Error(
    `unknown DeepSeek model "${model}"; use "pro", "flash", ` +
    `"deepseek-v4-pro", or "deepseek-v4-flash"`,
  )
}

interface DeepSeekBalanceResponse {
  balance_infos?: Array<{
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }>
  error?: { message?: string }
}

class DeepSeekProvider implements ModelProvider, BillingProvider {
  readonly id: string
  private readonly upstream: OpenAiCompatibleProvider
  private readonly pricing: Record<DeepSeekModelId, Record<DeepSeekPricingPeriod, DeepSeekPricing>>
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(config: DeepSeekConfig) {
    const reasoningEffort = config.reasoningEffort ?? 'max'
    if (reasoningEffort !== 'high' && reasoningEffort !== 'max') {
      throw new TypeError('DeepSeek reasoningEffort must be "high" or "max"')
    }
    this.id = config.id ?? 'deepseek'
    this.baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')
    this.headers = config.headers ?? {}
    this.upstream = new OpenAiCompatibleProvider({
      id: this.id,
      baseUrl: this.baseUrl,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.streaming === undefined ? {} : { streaming: config.streaming }),
      ...(config.streamUsage === undefined ? {} : { streamUsage: config.streamUsage }),
      extraBody: config.thinking === false
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, reasoning_effort: reasoningEffort },
    })
    this.pricing = Object.fromEntries(
      (['deepseek-v4-flash', 'deepseek-v4-pro'] as const).map(model => {
        const override = config.pricing?.[model]
        return [model, {
          peak: { ...defaultDeepSeekPricing[model], ...override },
          'off-peak': { ...defaultDeepSeekOffPeakPricing[model], ...override },
        }]
      }),
    ) as Record<DeepSeekModelId, Record<DeepSeekPricingPeriod, DeepSeekPricing>>
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY is not set in the environment')
    }
    const model = resolveDeepSeekModel(request.model)
    const pricingPeriod = deepSeekPricingPeriod()
    const response = await this.upstream.complete({
      ...request,
      model,
    })
    if (!response.usage) return response
    return {
      ...response,
      usage: {
        ...response.usage,
        calculatedCostUsd: calculateCost(response.usage, this.pricing[model][pricingPeriod]),
      },
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set in the environment')
    const model = resolveDeepSeekModel(request.model)
    const pricingPeriod = deepSeekPricingPeriod()
    for await (const event of this.upstream.stream({ ...request, model })) {
      if (event.type === 'usage') {
        yield {
          type: 'usage',
          usage: { ...event.usage, calculatedCostUsd: calculateCost(event.usage, this.pricing[model][pricingPeriod]) },
        }
      } else {
        yield event
      }
    }
  }

  async balances(): Promise<readonly BillingBalance[]> {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set in the environment')
    const response = await fetch(`${this.baseUrl}/user/balance`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...this.headers,
      },
    })
    const payload = await response.json() as DeepSeekBalanceResponse
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `DeepSeek balance request failed with HTTP ${response.status}`)
    }
    return (payload.balance_infos ?? []).map(balance => ({
      currency: balance.currency ?? 'unknown',
      total: balance.total_balance ?? '0',
      ...(balance.granted_balance === undefined ? {} : { granted: balance.granted_balance }),
      ...(balance.topped_up_balance === undefined ? {} : { toppedUp: balance.topped_up_balance }),
    }))
  }
}

export const name = 'deepseek-provider'
export const inject = ['billing', 'models']

export function apply(ctx: Context, config: DeepSeekConfig = {}): void {
  const provider = new DeepSeekProvider(config)
  ctx.models.register(provider)
  ctx.billing.register(provider)
}

export default { name, inject, apply }
