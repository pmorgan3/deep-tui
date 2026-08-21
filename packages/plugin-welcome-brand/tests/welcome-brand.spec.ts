import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { TuiService, type TuiRenderContext } from '@deep-tui/sdk'
import welcomeBrand from '../src/index.js'

describe('welcome brand', () => {
  it('renders the Deep TUI wordmark', async () => {
    const ctx = new Context()
    const service = await ctx.plugin(TuiService)
    const contribution = await ctx.plugin(welcomeBrand)
    const section = ctx.tui.listEmptyStateSections().find(item => item.id === 'deep-tui.empty.brand')
    const render = {
      state: { events: [] },
      width: 80,
      style: (text: string) => text,
    } as unknown as TuiRenderContext

    expect(section?.render(render)?.join('\n')).toContain('D E E P  T U I')
    expect(section?.render(render)?.join('\n')).not.toContain('F L E C T')

    await contribution.dispose()
    await service.dispose()
  })
})
