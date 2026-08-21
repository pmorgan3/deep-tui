import path from 'node:path'
import type { Context } from 'cordis'
import { fallbackConversationTitle, type AgentRunStatus } from '@flect/sdk'

export interface ZellijTitleConfig {
  label?: string
  idleTitle?: string
  intervalMs?: number
  maxLength?: number
  spinnerFrames?: string[]
  zellijOnly?: boolean
}

interface TitleWriter {
  write(value: string): unknown
}

const defaultFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function sanitize(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return [...normalized].slice(0, maxLength).join('').trimEnd()
}

export class ZellijTitleController {
  private readonly label: string
  private readonly intervalMs: number
  private readonly maxLength: number
  private readonly frames: string[]
  private timer: ReturnType<typeof setInterval> | undefined
  private frame = 0
  private sessionTitle = ''
  private running = false

  constructor(private readonly writer: TitleWriter, config: ZellijTitleConfig = {}) {
    this.intervalMs = config.intervalMs ?? 120
    this.maxLength = config.maxLength ?? 100
    this.frames = config.spinnerFrames?.filter(Boolean) ?? defaultFrames
    this.label = sanitize(config.label ?? 'Flect', this.maxLength) || 'Flect'
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 50 || this.intervalMs > 5_000) {
      throw new TypeError('zellij title intervalMs must be an integer from 50 through 5000')
    }
    if (!Number.isInteger(this.maxLength) || this.maxLength < 20 || this.maxLength > 200) {
      throw new TypeError('zellij title maxLength must be an integer from 20 through 200')
    }
    if (!this.frames.length) throw new TypeError('zellij title spinnerFrames must contain at least one frame')
  }

  idle(sessionTitle: string): void {
    this.running = false
    this.stopTimer()
    this.sessionTitle = sanitize(sessionTitle, this.maxLength)
    this.write()
  }

  start(sessionTitle: string): void {
    this.stopTimer()
    this.running = true
    this.frame = 0
    this.sessionTitle = sanitize(sessionTitle, this.maxLength)
    this.write()
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.frames.length
      this.write()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  update(sessionTitle: string): void {
    this.sessionTitle = sanitize(sessionTitle, this.maxLength)
    this.write()
  }

  finish(status: AgentRunStatus): void {
    this.running = false
    this.stopTimer()
    const marker = status === 'failed' ? '⚠ ' : status === 'limit-reached' ? '■ ' : ''
    this.write(marker)
  }

  dispose(): void {
    this.running = false
    this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private write(prefix = ''): void {
    const spinner = this.running ? `${this.frames[this.frame]} ` : prefix
    const session = this.sessionTitle ? ` · ${this.sessionTitle}` : ''
    const title = sanitize(`${spinner}${this.label}${session}`, this.maxLength)
    this.writer.write(`\u001b]0;${title}\u0007`)
  }
}

export const name = 'zellij-title'
export const inject = ['conversations', 'project']

export function apply(ctx: Context, config: ZellijTitleConfig = {}): void {
  const inZellij = process.env.ZELLIJ !== undefined || process.env.ZELLIJ_SESSION_NAME !== undefined
  if (config.zellijOnly !== false && !inZellij) return

  const controller = new ZellijTitleController(process.stdout, config)
  let conversationId: string | undefined
  let sessionTitle = config.idleTitle ?? path.basename(ctx.project.root) ?? 'workspace'
  controller.idle(sessionTitle)

  ctx.on('harness/agent/start', (input, metadata) => {
    conversationId = metadata.conversationId
    sessionTitle = fallbackConversationTitle(input, 48)
    controller.start(sessionTitle)
    if (conversationId) {
      const requestedId = conversationId
      void ctx.conversations.get(requestedId).then(conversation => {
        if (conversation && conversationId === requestedId) {
          sessionTitle = conversation.title
          controller.update(sessionTitle)
        }
      })
    }
  })
  ctx.on('harness/conversation/title', (updatedId, title) => {
    if (updatedId !== conversationId) return
    sessionTitle = title
    controller.update(sessionTitle)
  })
  ctx.on('harness/agent/finish', (_output, _steps, status) => {
    controller.finish(status)
  })
  ctx.effect(() => () => controller.dispose(), 'zellij title controller')
}

export default { name, inject, apply }
