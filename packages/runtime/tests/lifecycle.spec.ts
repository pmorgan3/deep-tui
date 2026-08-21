import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { PromptService } from '@flect/sdk'

describe('Cordis contribution lifecycle', () => {
  it('removes a contribution when its plugin unloads', async () => {
    const ctx = new Context()
    const serviceFiber = await ctx.plugin(PromptService)
    const contributionFiber = await ctx.plugin({
      name: 'test-prompt',
      inject: ['prompts'],
      apply(inner) {
        inner.prompts.register({ id: 'test', render: () => 'hello' })
      },
    })

    expect(await ctx.prompts.render({ cwd: '.', model: 'test' })).toBe('hello')
    await contributionFiber.dispose()
    expect(await ctx.prompts.render({ cwd: '.', model: 'test' })).toBe('')
    await serviceFiber.dispose()
  })
})
