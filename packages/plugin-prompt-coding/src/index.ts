import type { Context } from 'cordis'
import '@flect/sdk'

export interface CodingPromptConfig {
  text?: string
}

export const name = 'coding-prompt'
export const inject = ['prompts']

export function apply(ctx: Context, config: CodingPromptConfig = {}): void {
  ctx.prompts.register({
    id: 'core.coding',
    order: 0,
    render: ({ cwd }) => config.text ?? [
      'You are a careful coding agent working with the user as a collaborator.',
      `Your workspace root is ${cwd}.`,
      'Inspect relevant files before changing them. Use tools when evidence is needed.',
      'Keep changes scoped, preserve unrelated work, and report verification honestly.',
    ].join('\n'),
  })
}

export default { name, inject, apply }
