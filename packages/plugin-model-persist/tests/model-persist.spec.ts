import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { ProjectService, TuiService, type TuiActions, type TuiState } from '@deep-tui/sdk'
import modelPersist from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function mountModelContext(config: Record<string, unknown> = {}, root = process.cwd()) {
  const ctx = new Context()
  const project = await ctx.plugin(ProjectService, { root })
  const tui = await ctx.plugin(TuiService)
  const plugin = await ctx.plugin(modelPersist, config)
  return {
    ctx,
    async dispose() {
      await plugin.dispose()
      await tui.dispose()
      await project.dispose()
    },
  }
}

function makeActions(cwd: string, models: string[]): { actions: TuiActions; state: TuiState; notices: string[] } {
  const notices: string[] = []
  const state: TuiState = {
    cwd, width: 80, height: 24, provider: 'test', model: models[0] ?? 'flash', models: [...models],
    theme: 'default', contextWindow: 1_000_000, usage: {}, input: '/model', cursor: 6,
    slashSelection: 0, viewports: { transcript: { top: 0, follow: true, unseen: 0 } }, busy: false, status: 'ready', events: [], startedAt: 0,
  }
  const actions: TuiActions = {
    state,
    setInput() {},
    async submit() {},
    exit() {},
    cancel: () => false,
    clear() {},
    cycleModel(offset = 1) {
      const current = Math.max(0, state.models.indexOf(state.model))
      const next = (current + offset + state.models.length) % state.models.length
      state.model = state.models[next] ?? state.model
    },
    setModel(model: string) {
      if (!model) return
      state.model = model
      if (!state.models.includes(model)) state.models = [model, ...state.models]
    },
    notify(message) { notices.push(message) },
    showOverlay(overlay) { state.overlay = overlay },
    closeOverlay() { delete state.overlay },
    moveSlashSelection() {},
    acceptSlashSuggestion: () => false,
    answerPermission() {},
    scrollViewport() {},
    pageViewport() {},
    followViewport() {},
    toggleReasoning() {},
    revealEvent() {},
    selectPermissionCandidate() {},
    async newConversation() {},
    async openConversation() {},
    async forkConversation() {},
    async renameConversation() {},
  }
  return { actions, state, notices }
}

async function press(ctx: Context, name: string, actions: TuiActions): Promise<void> {
  const event = { name, sequence: '' }
  for (const binding of ctx.tui.bindings(event)) {
    if (await binding.handle(event, actions)) return
  }
}

describe('model persistence plugin', () => {
  it('persists /model switches and restores them before the next session draws', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-model-'))
    directories.push(cwd)
    const first = await mountModelContext({}, cwd)
    const firstSession = makeActions(cwd, ['flash', 'pro'])
    await first.ctx.tui.startSession(firstSession.actions)
    expect(firstSession.state.model).toBe('flash')

    await first.ctx.tui.executeSlash('/model pro', firstSession.actions)
    expect(firstSession.state.model).toBe('pro')
    expect(JSON.parse(await readFile(path.join(cwd, '.deep-tui/model.json'), 'utf8'))).toEqual({ model: 'pro' })

    await first.ctx.tui.stopSession(firstSession.actions)
    await first.dispose()

    const second = await mountModelContext({}, cwd)
    const secondSession = makeActions(cwd, ['flash', 'pro'])
    await second.ctx.tui.startSession(secondSession.actions)
    expect(secondSession.state.model).toBe('pro')
    await second.ctx.tui.stopSession(secondSession.actions)
    await second.dispose()
  })

  it('persists Ctrl+P model cycling', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-model-cycle-'))
    directories.push(cwd)
    const mounted = await mountModelContext({}, cwd)
    const session = makeActions(cwd, ['flash', 'pro'])
    await mounted.ctx.tui.startSession(session.actions)

    await press(mounted.ctx, 'ctrl+p', session.actions)
    expect(session.state.model).toBe('pro')
    expect(JSON.parse(await readFile(path.join(cwd, '.deep-tui/model.json'), 'utf8'))).toEqual({ model: 'pro' })

    await mounted.ctx.tui.stopSession(session.actions)
    await mounted.dispose()
  })

  it('keeps model selection session-only when persist is disabled', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-model-ephemeral-'))
    directories.push(cwd)
    const mounted = await mountModelContext({ persist: false }, cwd)
    const session = makeActions(cwd, ['flash', 'pro'])

    await mounted.ctx.tui.executeSlash('/model pro', session.actions)
    expect(session.state.model).toBe('pro')
    await expect(readFile(path.join(cwd, '.deep-tui/model.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await mounted.dispose()
  })

  it('rejects unknown models without writing state', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-model-unknown-'))
    directories.push(cwd)
    const mounted = await mountModelContext({}, cwd)
    const session = makeActions(cwd, ['flash', 'pro'])

    await mounted.ctx.tui.executeSlash('/model claude', session.actions)
    expect(session.state.model).toBe('flash')
    expect(session.state.overlay?.id).toBe('model-not-found')
    await expect(readFile(path.join(cwd, '.deep-tui/model.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await mounted.dispose()
  })

  it('warns when the saved model is no longer configured', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'deep-tui-model-stale-'))
    directories.push(cwd)
    await mkdir(path.join(cwd, '.deep-tui'), { recursive: true })
    await writeFile(path.join(cwd, '.deep-tui/model.json'), `${JSON.stringify({ model: 'retired' }, null, 2)}\n`, 'utf8')
    const mounted = await mountModelContext({}, cwd)
    const session = makeActions(cwd, ['flash', 'pro'])

    await mounted.ctx.tui.startSession(session.actions)
    expect(session.state.model).toBe('flash')
    expect(session.notices).toContain('saved model "retired" is not currently configured')

    await mounted.ctx.tui.stopSession(session.actions)
    await mounted.dispose()
  })
})
