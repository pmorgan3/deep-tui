import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ConversationService, fallbackConversationTitle, ModelService } from '@flect/sdk'
import { generateSessionTitle, normalizeGeneratedTitle } from '../src/index.js'

describe('session title plugin', () => {
  it('generates and persists a concise title for a new conversation', async () => {
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(ConversationService), ctx.plugin(ModelService)])
    let requestedModel = ''
    const provider = await ctx.plugin({ name: 'title-model', inject: ['models'], apply(inner) {
      inner.models.register({ id: 'fake', complete: async request => {
        requestedModel = request.model
        return { text: 'Title: "Fix Zellij Mouse Input."', toolCalls: [] }
      } })
    } })
    const prompt = 'Clicking in the terminal puts weird characters in the text box'
    const conversation = await ctx.conversations.create({
      title: fallbackConversationTitle(prompt), projectRoot: '.', provider: 'deepseek', model: 'flash',
    })
    let emitted = ''
    const listener = ctx.on('harness/conversation/title', (_id, title) => { emitted = title })

    const title = await generateSessionTitle(ctx, prompt, {
      cwd: '.', provider: 'deepseek', model: 'flash', conversationId: conversation.id,
    }, { provider: 'fake', model: 'title-model' })

    expect(title).toBe('Fix Zellij Mouse Input')
    expect(requestedModel).toBe('title-model')
    expect((await ctx.conversations.get(conversation.id))?.title).toBe(title)
    expect(emitted).toBe(title)

    listener()
    await provider.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })

  it('preserves explicit titles and sanitizes model formatting', async () => {
    expect(normalizeGeneratedTitle('## `Repair mouse escapes!`\nExtra', 60)).toBe('Repair mouse escapes')
    const ctx = new Context()
    const services = await Promise.all([ctx.plugin(ConversationService), ctx.plugin(ModelService)])
    let calls = 0
    const provider = await ctx.plugin({ name: 'unused-title-model', inject: ['models'], apply(inner) {
      inner.models.register({ id: 'fake', complete: async () => {
        calls += 1
        return { text: 'Replacement', toolCalls: [] }
      } })
    } })
    const conversation = await ctx.conversations.create({
      title: 'My deliberate title', projectRoot: '.', provider: 'deepseek', model: 'flash',
    })

    await generateSessionTitle(ctx, 'A prompt', {
      cwd: '.', provider: 'deepseek', model: 'flash', conversationId: conversation.id,
    }, { provider: 'fake' })

    expect(calls).toBe(0)
    expect((await ctx.conversations.get(conversation.id))?.title).toBe('My deliberate title')
    await provider.dispose()
    await Promise.all(services.map(service => service.dispose()))
  })
})
