import { createInterface } from 'node:readline/promises'
import type { Context } from 'cordis'
import type {
  AgentEvent,
  CommandEnvironment,
  PermissionRequest,
  PermissionResponse,
  Theme,
  UiRenderer,
} from '@flect/sdk'
import { describeToolCall, formatUnknownError } from '@flect/sdk'
import { fallbackConversationTitle } from '@flect/sdk'

export interface TerminalUiConfig {
  renderer?: string
  theme?: string
  allowCapabilities?: string[]
  denyCapabilities?: string[]
  ask?: boolean
  color?: boolean
}

function matches(capability: string, patterns: string[]): boolean {
  return patterns.some(pattern => pattern.endsWith('*')
    ? capability.startsWith(pattern.slice(0, -1))
    : capability === pattern)
}

function ansi(hex: string, text: string, enabled: boolean, bold = false): string {
  if (!enabled || !/^#[\da-f]{6}$/i.test(hex)) return text
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `\u001b[${bold ? '1;' : ''}38;2;${red};${green};${blue}m${text}\u001b[0m`
}

class TerminalRenderer implements UiRenderer {
  readonly id = 'terminal'

  constructor(private readonly theme: Theme, private readonly color: boolean) {}

  async render(events: AsyncIterable<AgentEvent>, output: { write(chunk: string): void }): Promise<string> {
    const iterator = events[Symbol.asyncIterator]()
    let finalText = ''
    while (true) {
      const next = await iterator.next()
      if (next.done) return typeof next.value === 'string' ? next.value : finalText
      const event = next.value
      const colors = this.theme.tokens.colors
      switch (event.type) {
        case 'start':
          output.write(`${ansi(colors.accent, '›', this.color, true)} ${event.input}\n\n`)
          break
        case 'assistant':
          finalText = event.text
          output.write(`${event.text}\n`)
          break
        case 'assistant-start':
          finalText = ''
          break
        case 'assistant-delta':
          finalText += event.delta
          output.write(event.delta)
          break
        case 'assistant-reasoning-delta':
          break
        case 'assistant-finish':
          finalText = event.text
          output.write('\n')
          break
        case 'tool-call': {
          const label = describeToolCall(event.call)
          const serialized = label === event.call.name ? JSON.stringify(event.call.arguments) : ''
          output.write(`${ansi(colors.muted, `  ↳ ${label}`, this.color)}${serialized ? ` ${serialized}` : ''}\n`)
          break
        }
        case 'tool-result':
          output.write(`${ansi(colors.success, '  ✓', this.color)} ${describeToolCall(event.call)}\n`)
          break
        case 'finish':
          finalText = event.text
          output.write('\n')
          break
      }
    }
  }
}

async function readInput(environment: CommandEnvironment): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of environment.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  }
  return chunks.join('').trim()
}

function parseRunArgs(args: string[]): { prompt: string; model?: string; provider?: string; conversationId?: string; newSession?: boolean } {
  const prompt: string[] = []
  let model: string | undefined
  let provider: string | undefined
  let conversationId: string | undefined
  let newSession = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--model') {
      model = args[++index]
      if (!model) throw new Error('--model requires a value')
    } else if (arg === '--provider') {
      provider = args[++index]
      if (!provider) throw new Error('--provider requires a value')
    } else if (arg === '--session') {
      conversationId = args[++index]
      if (!conversationId) throw new Error('--session requires a value')
    } else if (arg === '--new-session') {
      newSession = true
    } else if (arg) {
      prompt.push(arg)
    }
  }
  return {
    prompt: prompt.join(' ').trim(),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(newSession ? { newSession: true } : {}),
  }
}

async function askPermission(request: PermissionRequest): Promise<PermissionResponse> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { decision: 'deny' }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const candidates = request.remember ?? []
    const remember = candidates[0]
    if (candidates.length > 1) {
      process.stdout.write(`${candidates.map((candidate, index) => `  ${index + 1}. ${candidate.label}`).join('\n')}\n`)
    }
    const choices = remember
      ? `[y] once / [s${candidates.length > 1 ? '#' : ''}] session / [p${candidates.length > 1 ? '#' : ''}] project / [N] deny`
      : '[y/N]'
    const answer = (await readline.question(`Allow ${request.description}? ${choices} `)).trim().toLowerCase()
    if (/^(y|yes)$/.test(answer)) return { decision: 'allow' }
    const matched = answer.match(/^(s|session|p|project)(\d+)?$/)
    const candidate = candidates[Math.max(0, Number(matched?.[2] ?? 1) - 1)]
    if (candidate && /^(s|session)/.test(answer)) {
      return { decision: 'allow', remember: 'session', ruleKey: candidate.key }
    }
    if (candidate && /^(p|project)/.test(answer)) {
      return { decision: 'allow', remember: 'project', ruleKey: candidate.key }
    }
    return { decision: 'deny' }
  } finally {
    readline.close()
  }
}

export const name = 'terminal-ui'
export const inject = ['agent', 'commands', 'conversations', 'permissionRules', 'permissions', 'project', 'themes', 'ui']

export function apply(ctx: Context, config: TerminalUiConfig = {}): void {
  const themeId = config.theme ?? 'default'
  const theme = ctx.themes.get(themeId)
  if (!theme) throw new Error(`theme "${themeId}" is not registered`)
  const color = config.color ?? !process.env.NO_COLOR
  const renderer = new TerminalRenderer(theme, color)
  ctx.ui.register(renderer)

  const allow = config.allowCapabilities ?? ['fs.read']
  const deny = config.denyCapabilities ?? []
  ctx.permissions.register({
    id: 'terminal.approval',
    priority: -100,
    decide: async (request, context) => {
      if (matches(request.capability, deny)) return 'deny'
      if (matches(request.capability, allow)) return 'allow'
      if (config.ask === false) return 'deny'
      while (true) {
        const response = await askPermission(request)
        if (response.decision !== 'allow' || !response.remember || !response.ruleKey) return response.decision
        const candidate = request.remember?.find(item => item.key === response.ruleKey)
        if (!candidate) return 'deny'
        const rule = ctx.permissionRules.add({
          key: candidate.key,
          label: candidate.label,
          scope: response.remember,
          projectRoot: ctx.project.root,
          ...(response.remember === 'session' ? { sessionId: context.sessionId ?? 'terminal' } : {}),
        })
        try {
          if (response.remember === 'project') await ctx.permissionRules.persist()
          return { decision: 'allow', ruleId: rule.id }
        } catch (error) {
          ctx.permissionRules.remove(rule.id)
          process.stderr.write(`Could not save the project permission: ${formatUnknownError(error)}\n`)
        }
      }
    },
  })

  ctx.commands.register({
    name: 'run',
    description: 'Run the configured agent.',
    usage: 'run [--provider id] [--model id] [--session id|--new-session] <prompt>',
    run: async (args, environment) => {
      const parsed = parseRunArgs(args)
      const prompt = parsed.prompt || await readInput(environment)
      if (!prompt) throw new Error('run requires a prompt argument or piped input')
      const selected = ctx.ui.get(config.renderer ?? renderer.id)
      if (!selected) throw new Error(`UI renderer "${config.renderer}" is not registered`)
      if (parsed.newSession && parsed.conversationId) throw new Error('--session and --new-session cannot be combined')
      const conversation = parsed.newSession ? await ctx.conversations.create({
        title: fallbackConversationTitle(prompt), projectRoot: environment.cwd,
        provider: parsed.provider ?? 'deepseek', model: parsed.model ?? 'flash',
      }) : undefined
      if (conversation) environment.stderr.write(`Session: ${conversation.id}\n`)
      await selected.render(ctx.agent.run(prompt, {
        cwd: environment.cwd,
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.provider ? { provider: parsed.provider } : {}),
        ...(conversation?.id || parsed.conversationId ? { conversationId: conversation?.id ?? parsed.conversationId as string } : {}),
      }), environment.stdout)
    },
  })

  ctx.commands.register({
    name: 'help',
    description: 'List commands contributed by the active plugins.',
    default: true,
    priority: -100,
    run: (_args, environment) => {
      environment.stdout.write('Commands:\n')
      for (const command of ctx.commands.list().sort((left, right) => left.name.localeCompare(right.name))) {
        environment.stdout.write(`  ${command.usage ?? command.name.padEnd(18)} ${command.description}\n`)
      }
    },
  })

  ctx.commands.register({
    name: 'theme',
    description: 'Print the active theme tokens.',
    run: (_args, environment) => {
      environment.stdout.write(`${JSON.stringify(theme, null, 2)}\n`)
    },
  })
}

export default { name, inject, apply }
