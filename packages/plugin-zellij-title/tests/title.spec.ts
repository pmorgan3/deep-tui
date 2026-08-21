import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZellijTitleController } from '../src/index.js'

describe('Zellij title controller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('animates while running and settles on the session title', () => {
    const writes: string[] = []
    const controller = new ZellijTitleController({ write: value => writes.push(value) }, {
      label: 'Deep TUI', spinnerFrames: ['a', 'b'], intervalMs: 100,
    })

    controller.start('Repair mouse input')
    vi.advanceTimersByTime(100)
    controller.finish('complete')

    expect(writes).toEqual([
      '\u001b]0;a Deep TUI · Repair mouse input\u0007',
      '\u001b]0;b Deep TUI · Repair mouse input\u0007',
      '\u001b]0;Deep TUI · Repair mouse input\u0007',
    ])
    controller.dispose()
  })

  it('strips control sequences from generated session names', () => {
    const writes: string[] = []
    const controller = new ZellijTitleController({ write: value => writes.push(value) })
    controller.idle('safe\u001b]0;hijack\u0007 title')
    expect(writes.at(-1)).toBe('\u001b]0;Deep TUI · safe ]0;hijack title\u0007')
  })
})
