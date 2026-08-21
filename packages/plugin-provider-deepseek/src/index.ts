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
  /** Override per-million-token tariffs used for local charge calculation. */
  pricing?: Partial<Record<DeepSeekModelId, Partial<DeepSeekPricing>>>
}

export interface DeepSeekPricing {
  cachedInputPerMillion: number
  uncachedInputPerMillion: number
  outputPerMillion: number
}

const modelAliases: Record<DeepSeekModelAlias, DeepSeekModelId> = {
  pro: 'deepseek-v4-pro',
  flash: 'deepseek-v4-flash',
}

/** Official public API prices checked 2026-08-17; configurable because vendor prices can change. */
export const defaultDeepSeekPricing: Record<DeepSeekModelId, DeepSeekPricing> = {
  'deepseek-v4-flash': {
    cachedInputPerMillion: 0.0028,
    uncachedInputPerMillion: 0.14,
    outputPerMillion: 0.28,
  },
  'deepseek-v4-pro': {
    cachedInputPerMillion: 0.003625,
    uncachedInputPerMillion: 0.435,
    outputPerMillion: 0.87,
  },
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
  private readonly pricing: Record<DeepSeekModelId, DeepSeekPricing>
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
    this.pricing = {
      'deepseek-v4-flash': { ...defaultDeepSeekPricing['deepseek-v4-flash'], ...config.pricing?.['deepseek-v4-flash'] },
      'deepseek-v4-pro': { ...defaultDeepSeekPricing['deepseek-v4-pro'], ...config.pricing?.['deepseek-v4-pro'] },
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY is not set in the environment')
    }
    const model = resolveDeepSeekModel(request.model)
    const response = await this.upstream.complete({
      ...request,
      model,
    })
    if (!response.usage) return response
    return {
      ...response,
      usage: {
        ...response.usage,
        calculatedCostUsd: calculateCost(response.usage, this.pricing[model]),
      },
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set in the environment')
    const model = resolveDeepSeekModel(request.model)
    for await (const event of this.upstream.stream({ ...request, model })) {
      if (event.type === 'usage') {
        yield { type: 'usage', usage: { ...event.usage, calculatedCostUsd: calculateCost(event.usage, this.pricing[model]) } }
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
