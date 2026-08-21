import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import {
  ThemeService,
  TuiService,
  ProjectService,
  type TuiActions,
  type TuiState,
} from '@deep-tui/sdk'
import themeSlash from '../src/index.js'

async function mountThemeContext(config: { persist?: boolean } = {}, root = process.cwd()) {
  const ctx = new Context()
  const project = await ctx.plugin(ProjectService, { root })
  const themes = await ctx.plugin(ThemeService)
  const tui = await ctx.plugin(TuiService)
  const base = await ctx.plugin({
    name: 'base-theme',
    inject: ['themes'],
    apply(inner) {
      inner.themes.register({
        id: 'default',
        label: 'Default',
        tokens: {
          fontFamily: 'monospace', fontSize: 14,
          colors: {
            background: '#000000', foreground: '#ffffff', muted: '#888888', accent: '#00aaff',
            success: '#00ff00', warning: '#ffff00', danger: '#ff0000',
          },
          spacing: { compact: 4, normal: 8, relaxed: 16 },
        },
      })
      inner.themes.select('default')
    },
  })
  const plugin = await ctx.plugin(themeSlash, config)
  return {
    ctx,
    plugin,
    async dispose() {
      await plugin.dispose()
      await base.dispose()
      await tui.dispose()
      await themes.dispose()
      await project.dispose()
    },
  }
}

function makeActions(cwd: string): { actions: TuiActions; state: TuiState; notices: string[] } {
  const notices: string[] = []
  const state: TuiState = {
    cwd, width: 80, height: 24, provider: 'test', model: 'test', models: ['test'],
    theme: 'default', contextWindow: 0, usage: {}, input: '/theme', cursor: 6,
    slashSelection: 0, viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
  const actions: TuiActions = {
    state,
    setInput() {}, async submit() {}, exit() {}, cancel: () => false, clear() {}, cycleModel() {}, setModel() {},
    notify(message) { notices.push(message) },
    showOverlay(overlay) { state.overlay = overlay },
    closeOverlay() { delete state.overlay },
    moveSlashSelection() {}, acceptSlashSuggestion: () => false, answerPermission() {},
    scrollViewport() {}, pageViewport() {}, followViewport() {}, toggleReasoning() {}, selectPermissionCandidate() {},
    async newConversation() {}, async openConversation() {}, async forkConversation() {}, async renameConversation() {},
  }
  return { actions, state, notices }
}

async function press(ctx: Context, name: string, actions: TuiActions): Promise<void> {
  const event = { name, sequence: '' }
  for (const binding of ctx.tui.bindings(event)) {
    if (await binding.handle(event, actions)) return
  }
}

describe('theme slash plugin', () => {
  it('loads theme plugins, switches live, and falls back when unloaded', async () => {
    const mounted = await mountThemeContext({ persist: false })
    const { ctx, plugin } = mounted
    const { actions, state } = makeActions('.')
    state.input = '/theme nord'
    state.cursor = 11

    expect(ctx.themes.list()).toHaveLength(14)
    expect(ctx.tui.slashSuggestions('/theme gr', state).some(item => item.value.endsWith('gruvbox-dark-hard'))).toBe(true)
    await ctx.tui.executeSlash('/theme nord', actions)
    expect(ctx.themes.current()?.id).toBe('nord')

    await plugin.dispose()
    expect(ctx.themes.list().map(theme => theme.id)).toEqual(['default'])
    expect(ctx.themes.current()?.id).toBe('default')
    expect(ctx.tui.slashCommand('theme')).toBeUndefined()

    await mounted.dispose()
  })

  it('previews with arrows, cancels with Escape, and persists an accepted theme', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-theme-'))
    try {
      const first = await mountThemeContext({}, cwd)
      const firstSession = makeActions(cwd)
      await first.ctx.tui.startSession(firstSession.actions)

      await first.ctx.tui.executeSlash('/theme', firstSession.actions)
      expect(firstSession.state.overlay?.id).toBe('deep-tui.theme.picker')
      await press(first.ctx, 'down', firstSession.actions)
      const previewed = first.ctx.themes.current()?.id
      expect(previewed).toBeTruthy()
      expect(previewed).not.toBe('default')
      expect(firstSession.state.overlay?.lines.some(line => line.startsWith(`› ${previewed}`))).toBe(true)

      await press(first.ctx, 'escape', firstSession.actions)
      expect(first.ctx.themes.current()?.id).toBe('default')
      await expect(readFile(path.join(cwd, '.deep-tui/theme.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      await first.ctx.tui.executeSlash('/theme', firstSession.actions)
      await press(first.ctx, 'down', firstSession.actions)
      const accepted = first.ctx.themes.current()?.id
      await press(first.ctx, 'enter', firstSession.actions)
      expect(firstSession.state.overlay).toBeUndefined()
      expect(JSON.parse(await readFile(path.join(cwd, '.deep-tui/theme.json'), 'utf8'))).toEqual({ theme: accepted })
      await first.ctx.tui.stopSession(firstSession.actions)
      await first.dispose()

      const second = await mountThemeContext({}, cwd)
      const secondSession = makeActions(cwd)
      await second.ctx.tui.startSession(secondSession.actions)
      expect(second.ctx.themes.current()?.id).toBe(accepted)
      await second.ctx.tui.stopSession(secondSession.actions)
      await second.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
