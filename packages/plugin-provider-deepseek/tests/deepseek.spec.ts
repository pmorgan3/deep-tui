import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { BillingService, ModelService, type ModelRequest } from '@deep-tui/sdk'
import deepseek, { deepSeekPricingPeriod, resolveDeepSeekModel } from '../src/index.js'

const previousApiKey = process.env.DEEPSEEK_API_KEY

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (previousApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY
  } else {
    process.env.DEEPSEEK_API_KEY = previousApiKey
  }
})

function request(model: string): ModelRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
  }
}

describe('DeepSeek provider', () => {
  it('uses the documented UTC peak windows with exclusive end boundaries', () => {
    expect(deepSeekPricingPeriod(new Date('2026-08-21T00:59:59Z'))).toBe('off-peak')
    expect(deepSeekPricingPeriod(new Date('2026-08-21T01:00:00Z'))).toBe('peak')
    expect(deepSeekPricingPeriod(new Date('2026-08-21T03:59:59Z'))).toBe('peak')
    expect(deepSeekPricingPeriod(new Date('2026-08-21T04:00:00Z'))).toBe('off-peak')
    expect(deepSeekPricingPeriod(new Date('2026-08-21T06:00:00Z'))).toBe('peak')
    expect(deepSeekPricingPeriod(new Date('2026-08-21T10:00:00Z'))).toBe('off-peak')
  })

  it('maps the friendly model aliases to official model ids', () => {
    expect(resolveDeepSeekModel('flash')).toBe('deepseek-v4-flash')
    expect(resolveDeepSeekModel('pro')).toBe('deepseek-v4-pro')
    expect(resolveDeepSeekModel('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(() => resolveDeepSeekModel('chat')).toThrow('unknown DeepSeek model')
  })

  it('reads DEEPSEEK_API_KEY and sends the resolved model', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T02:00:00Z'))
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    const fetchMock = vi.fn(async () => {
      // Billing uses the request-start period even when the response completes in another window.
      vi.setSystemTime(new Date('2026-08-21T05:00:00Z'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Hi from DeepSeek' } }],
          usage: {
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 40,
            prompt_cache_miss_tokens: 60,
            completion_tokens: 10,
          },
        }),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const models = await ctx.plugin(ModelService)
    const billing = await ctx.plugin(BillingService)
    const provider = await ctx.plugin(deepseek, { baseUrl: 'https://deepseek.test/v1' })

    const response = await ctx.models.complete('deepseek', request('pro'))

    expect(response.text).toBe('Hi from DeepSeek')
    expect(response.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 40,
      uncachedInputTokens: 60,
      outputTokens: 10,
      contextTokens: 100,
    })
    expect(response.usage?.calculatedCostUsd).toBeCloseTo(0.00012056, 12)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://deepseek.test/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer test-deepseek-key',
    })
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })

    await provider.dispose()
    await billing.dispose()
    await models.dispose()
  })

  it('uses off-peak pricing and keeps flat proxy overrides fixed across periods', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T05:00:00Z'))
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      choices: [{ message: { content: 'done' } }],
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 60,
        completion_tokens: 10,
      },
    })))
    const ctx = new Context()
    const models = await ctx.plugin(ModelService)
    const billing = await ctx.plugin(BillingService)
    const provider = await ctx.plugin(deepseek)

    const response = await ctx.models.complete('deepseek', request('pro'))
    expect(response.usage?.calculatedCostUsd).toBeCloseTo(0.00006028, 12)

    await provider.dispose()
    const fixed = await ctx.plugin(deepseek, {
      pricing: {
        'deepseek-v4-pro': {
          cachedInputPerMillion: 1,
          uncachedInputPerMillion: 1,
          outputPerMillion: 1,
        },
      },
    })
    expect((await ctx.models.complete('deepseek', request('pro'))).usage?.calculatedCostUsd)
      .toBeCloseTo(0.00011, 12)

    await fixed.dispose()
    await billing.dispose()
    await models.dispose()
  })

  it('allows thinking effort to be lowered or thinking to be disabled explicitly', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return Response.json({ choices: [{ message: { content: 'done' } }] })
    }))
    const ctx = new Context()
    const models = await ctx.plugin(ModelService)
    const billing = await ctx.plugin(BillingService)

    const high = await ctx.plugin(deepseek, { id: 'deepseek-high', reasoningEffort: 'high' })
    await ctx.models.complete('deepseek-high', request('flash'))
    expect(bodies.at(-1)).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    await high.dispose()

    const disabled = await ctx.plugin(deepseek, { id: 'deepseek-disabled', thinking: false })
    await ctx.models.complete('deepseek-disabled', request('flash'))
    expect(bodies.at(-1)).toMatchObject({ thinking: { type: 'disabled' } })
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort')

    await disabled.dispose()
    await billing.dispose()
    await models.dispose()
  })

  it('fails clearly at request time when the environment key is absent', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const ctx = new Context()
    const models = await ctx.plugin(ModelService)
    const billing = await ctx.plugin(BillingService)
    const provider = await ctx.plugin(deepseek)

    await expect(ctx.models.complete('deepseek', request('flash')))
      .rejects.toThrow('DEEPSEEK_API_KEY is not set')

    await provider.dispose()
    await billing.dispose()
    await models.dispose()
  })

  it('reads the authoritative live account balance', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{
          currency: 'USD',
          total_balance: '12.34',
          granted_balance: '2.34',
          topped_up_balance: '10.00',
        }],
      }),
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    const models = await ctx.plugin(ModelService)
    const billing = await ctx.plugin(BillingService)
    const provider = await ctx.plugin(deepseek, { baseUrl: 'https://deepseek.test' })

    await expect(ctx.billing.balances('deepseek')).resolves.toEqual([{
      currency: 'USD',
      total: '12.34',
      granted: '2.34',
      toppedUp: '10.00',
    }])
    expect(fetchMock).toHaveBeenCalledWith('https://deepseek.test/user/balance', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-deepseek-key' }),
    }))

    await provider.dispose()
    await billing.dispose()
    await models.dispose()
  })
})
