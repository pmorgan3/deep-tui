import type { Context } from 'cordis'
import { formatUnknownError, type Awaitable, type TuiActions, type TuiKeyEvent } from '@flect/sdk'
import { defaultComponents, defaultEventRenderers, reasoningMessageAt } from './frame.js'
import { DefaultTuiShell } from './shell.js'
import { defaultSlashCommands } from './slash.js'

export { background, decodeKeys, fit, renderRichText, stripAnsi, TuiInputDecoder, visibleWidth, wrap, wrapAnsi } from './ansi.js'
export { activityGlyph, activityLabel, defaultComponents, defaultEventRenderers, layoutTuiFrame, reasoningMessageAt, renderTuiFrame } from './frame.js'
export {
  coalesceMouseMoves,
  DefaultTuiShell,
  mergeUsage,
  renderFrameUpdate,
  unaccountedUsage,
  type DefaultTuiShellConfig,
} from './shell.js'
export { defaultSlashCommands } from './slash.js'

export interface TuiPluginConfig {
  theme?: string
  provider?: string
  model?: string
  models?: string[]
  contextWindow?: number
  contextWindows?: Record<string, number>
  color?: boolean
  requireTty?: boolean
  mouse?: boolean
  scrollLines?: number
  renderFps?: number
}

function insertText(event: TuiKeyEvent, actions: TuiActions): boolean {
  if (!event.text || actions.state.approval) return Boolean(actions.state.approval)
  const { input, cursor } = actions.state
  actions.setInput(`${input.slice(0, cursor)}${event.text}${input.slice(cursor)}`, cursor + event.text.length)
  return true
}

function parseArgs(args: string[]): { provider?: string; model?: string; initialPrompt?: string; conversationId?: string } {
  const prompt: string[] = []
  let provider: string | undefined
  let model: string | undefined
  let conversationId: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--provider') {
      provider = args[++index]
      if (!provider) throw new Error('--provider requires a value')
    } else if (value === '--model') {
      model = args[++index]
      if (!model) throw new Error('--model requires a value')
    } else if (value === '--session') {
      conversationId = args[++index]
      if (!conversationId) throw new Error('--session requires a value')
    } else if (value) {
      prompt.push(value)
    }
  }
  const initialPrompt = prompt.join(' ').trim()
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
  }
}

export const name = 'composable-tui'
export const inject = ['agent', 'billing', 'commands', 'conversations', 'permissionRules', 'permissions', 'project', 'themes', 'tui']

export function apply(ctx: Context, config: TuiPluginConfig = {}): void {
  const themeId = config.theme ?? 'default'
  const theme = ctx.themes.get(themeId)
  if (!theme) throw new Error(`theme "${themeId}" is not registered`)
  ctx.themes.select(themeId)
  const model = config.model ?? 'flash'
  const models = [...new Set(config.models ?? ['flash', 'pro'])]
  if (!models.includes(model)) models.unshift(model)
  const color = config.color ?? !process.env.NO_COLOR
  const shell = new DefaultTuiShell(ctx, theme, {
    provider: config.provider ?? 'deepseek',
    model,
    models,
    contextWindows: {
      default: config.contextWindow ?? 1_000_000,
      flash: 1_000_000,
      pro: 1_000_000,
      'deepseek-v4-flash': 1_000_000,
      'deepseek-v4-pro': 1_000_000,
      ...config.contextWindows,
    },
    color,
    requireTty: config.requireTty ?? true,
    mouse: config.mouse ?? true,
    scrollLines: config.scrollLines ?? 3,
    renderFps: config.renderFps ?? 45,
  })

  ctx.tui.registerShell(shell)
  ctx.on('harness/conversation/title', (conversationId, title) => {
    shell.updateConversationTitle(conversationId, title)
  })
  for (const component of defaultComponents(ctx.tui)) ctx.tui.registerComponent(component)
  for (const renderer of defaultEventRenderers()) ctx.tui.registerEventRenderer(renderer)
  for (const command of defaultSlashCommands(ctx.tui, ctx.billing)) ctx.tui.registerSlashCommand(command)

  const binding = (
    id: string,
    keys: string[],
    description: string,
    handle: (event: TuiKeyEvent, actions: TuiActions) => Awaitable<boolean | void>,
    priority = -100,
  ) => ctx.tui.registerKeybinding({ id, keys, description, priority, handle })

  binding('flect.permission.allow', ['y', 'Y'], 'Allow the pending permission request.', (_event, actions) => {
    if (!actions.state.approval) return false
    actions.answerPermission('allow')
    return true
  }, -50)
  binding('flect.permission.deny', ['n', 'N', 'escape'], 'Deny the pending permission request.', (_event, actions) => {
    if (!actions.state.approval) return false
    actions.answerPermission('deny')
    return true
  }, -50)
  binding('flect.permission.session', ['s', 'S'], 'Allow this permission type for the session.', (_event, actions) => {
    const candidates = actions.state.approval?.remember ?? []
    const candidate = candidates[(actions.state.permissionSelection ?? 0) % Math.max(1, candidates.length)]
    if (!candidate) return false
    actions.answerPermission({ decision: 'allow', remember: 'session', ruleKey: candidate.key })
    return true
  }, -50)
  binding('flect.permission.project', ['p', 'P'], 'Allow this permission type for the project.', (_event, actions) => {
    const candidates = actions.state.approval?.remember ?? []
    const candidate = candidates[(actions.state.permissionSelection ?? 0) % Math.max(1, candidates.length)]
    if (!candidate) return false
    actions.answerPermission({ decision: 'allow', remember: 'project', ruleKey: candidate.key })
    return true
  }, -50)
  binding('flect.permission.candidate-next', ['tab'], 'Select the next remembered permission scope.', (_event, actions) => {
    if (!actions.state.approval?.remember?.length) return false
    actions.selectPermissionCandidate(1)
    return true
  }, 0)
  binding('flect.permission.candidate-previous', ['shift+tab'], 'Select the previous remembered permission scope.', (_event, actions) => {
    if (!actions.state.approval?.remember?.length) return false
    actions.selectPermissionCandidate(-1)
    return true
  }, 0)
  binding('flect.slash.up', ['up'], 'Select the previous slash-command suggestion.', (_event, actions) => {
    if (!ctx.tui.slashSuggestions(actions.state.input, actions.state).length) return false
    actions.moveSlashSelection(-1)
    return true
  }, -50)
  binding('flect.slash.down', ['down'], 'Select the next slash-command suggestion.', (_event, actions) => {
    if (!ctx.tui.slashSuggestions(actions.state.input, actions.state).length) return false
    actions.moveSlashSelection(1)
    return true
  }, -50)
  binding('flect.slash.accept', ['tab'], 'Complete the selected slash-command suggestion.', (_event, actions) => {
    return actions.acceptSlashSuggestion()
  }, -50)
  const canScroll = (actions: TuiActions) => !actions.state.approval
    && !actions.state.overlay
    && !ctx.tui.slashSuggestions(actions.state.input, actions.state).length
  binding('flect.transcript.wheel-up', ['wheel-up'], 'Scroll the transcript up.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.scrollViewport('transcript', -(config.scrollLines ?? 3))
    return true
  }, -75)
  binding('flect.transcript.wheel-down', ['wheel-down'], 'Scroll the transcript down.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.scrollViewport('transcript', config.scrollLines ?? 3)
    return true
  }, -75)
  binding('flect.reasoning.mouse-toggle', ['mouse-left'], 'Expand or collapse the clicked model reasoning.', (event, actions) => {
    const mouse = event.mouse
    if (!mouse) return false
    const target = reasoningMessageAt(
      ctx.tui, actions.state, ctx.themes.current() ?? theme, color, mouse.x, mouse.y,
    )
    if (!target) return false
    actions.toggleReasoning(target)
    return true
  }, 1_000)
  binding('flect.reasoning.mouse-hover', ['mouse-move'], 'Highlight model reasoning under the pointer.', (event, actions) => {
    const mouse = event.mouse
    if (!mouse || !actions.setHoveredReasoning) return false
    const target = reasoningMessageAt(
      ctx.tui, actions.state, ctx.themes.current() ?? theme, color, mouse.x, mouse.y,
    )
    actions.setHoveredReasoning(target)
    return Boolean(target)
  }, 1_000)
  binding('flect.transcript.page-up', ['pageup'], 'Scroll the transcript up one page.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.pageViewport('transcript', -1)
    return true
  }, -75)
  binding('flect.transcript.page-down', ['pagedown'], 'Scroll the transcript down one page.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.pageViewport('transcript', 1)
    return true
  }, -75)
  binding('flect.transcript.half-page-up', ['ctrl+u'], 'Scroll the transcript up half a page.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.pageViewport('transcript', -0.5)
    return true
  }, -75)
  binding('flect.transcript.half-page-down', ['ctrl+d'], 'Scroll the transcript down half a page.', (_event, actions) => {
    if (!canScroll(actions)) return false
    actions.pageViewport('transcript', 0.5)
    return true
  }, -75)
  binding('flect.transcript.home', ['home'], 'Jump to the first transcript line.', (_event, actions) => {
    if (!canScroll(actions) || actions.state.input) return false
    actions.scrollViewport('transcript', -Number.MAX_SAFE_INTEGER)
    return true
  }, -75)
  binding('flect.transcript.follow', ['end'], 'Follow the latest transcript output.', (_event, actions) => {
    if (!canScroll(actions) || actions.state.input) return false
    actions.followViewport('transcript')
    return true
  }, -75)
  binding('flect.dismiss', ['escape'], 'Close a slash menu or overlay.', (_event, actions) => {
    if (actions.state.overlay) {
      actions.closeOverlay()
      return true
    }
    if (!ctx.tui.slashSuggestions(actions.state.input, actions.state).length) return false
    actions.setInput('')
    return true
  }, -100)
  binding('flect.exit', ['ctrl+c'], 'Exit Flect.', (_event, actions) => {
    if (actions.cancel()) return true
    actions.exit()
    return true
  })
  binding('flect.clear', ['ctrl+l'], 'Clear the current transcript.', (_event, actions) => {
    actions.clear()
    return true
  })
  binding('flect.model.cycle', ['ctrl+p'], 'Switch to the next configured model.', (_event, actions) => {
    actions.cycleModel()
    return true
  })
  binding('flect.reasoning.toggle', ['ctrl+t'], 'Expand or collapse the latest model reasoning.', (_event, actions) => {
    actions.toggleReasoning()
    return true
  })
  binding('flect.submit', ['enter'], 'Send the current prompt.', async (_event, actions) => {
    await actions.submit()
    return true
  })
  binding('flect.cursor.left', ['left'], 'Move the prompt cursor left.', (_event, actions) => {
    actions.setInput(actions.state.input, actions.state.cursor - 1)
    return true
  })
  binding('flect.cursor.right', ['right'], 'Move the prompt cursor right.', (_event, actions) => {
    actions.setInput(actions.state.input, actions.state.cursor + 1)
    return true
  })
  binding('flect.cursor.home', ['home'], 'Move to the start of the prompt.', (_event, actions) => {
    actions.setInput(actions.state.input, 0)
    return true
  })
  binding('flect.cursor.end', ['end'], 'Move to the end of the prompt.', (_event, actions) => {
    actions.setInput(actions.state.input)
    return true
  })
  binding('flect.edit.backspace', ['backspace'], 'Delete before the prompt cursor.', (_event, actions) => {
    const { input, cursor } = actions.state
    if (cursor > 0) actions.setInput(`${input.slice(0, cursor - 1)}${input.slice(cursor)}`, cursor - 1)
    return true
  })
  binding('flect.edit.delete', ['delete'], 'Delete after the prompt cursor.', (_event, actions) => {
    const { input, cursor } = actions.state
    if (cursor < input.length) actions.setInput(`${input.slice(0, cursor)}${input.slice(cursor + 1)}`, cursor)
    return true
  })
  binding('flect.edit.text', ['text'], 'Insert text into the prompt.', insertText, -200)

  ctx.permissions.register({
    id: 'tui.approval',
    priority: 100,
    async decide(request, context) {
      let presented = request
      while (true) {
        const response = shell.requestPermission(presented)
        if (response === 'abstain') return response
        const resolved = await response
        if (resolved.decision !== 'allow' || !resolved.remember || !resolved.ruleKey) return resolved.decision
        const candidate = request.remember?.find(item => item.key === resolved.ruleKey)
        if (!candidate) return 'deny'
        const rule = ctx.permissionRules.add({
          key: candidate.key,
          label: candidate.label,
          scope: resolved.remember,
          projectRoot: ctx.project.root,
          ...(resolved.remember === 'session' ? { sessionId: context.sessionId ?? 'tui' } : {}),
        })
        try {
          if (resolved.remember === 'project') await ctx.permissionRules.persist()
          return { decision: 'allow', ruleId: rule.id }
        } catch (error) {
          ctx.permissionRules.remove(rule.id)
          presented = {
            ...request,
            description: `${request.description}\n\nCould not save the project rule: ${formatUnknownError(error)}. Choose again.`,
          }
        }
      }
    },
  })

  ctx.commands.register({
    name: 'tui',
    description: 'Launch the composable full-screen interface.',
    usage: 'tui [--provider id] [--model id] [--session id] [initial prompt]',
    default: true,
    priority: 100,
    run: (args, environment) => ctx.tui.run(environment, parseArgs(args)),
  })
}

export default { name, inject, apply }
