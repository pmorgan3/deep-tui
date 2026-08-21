import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandService,
  ProjectService,
  PromptService,
  ToolService,
  TuiService,
  WorkspaceService,
  type CommandEnvironment,
  type Theme,
  type ToolPresentation,
  type TuiActions,
  type TuiOverlay,
  type TuiRenderContext,
  type TuiState,
} from '@flect/sdk'
import localWorkspace from '../../plugin-workspace-local/src/index.js'
import workspaceTools from '../../plugin-tool-workspace/src/index.js'
import searchTools from '../../plugin-tool-search/src/index.js'
import patchTool from '../../plugin-tool-patch/src/index.js'
import processTool from '../../plugin-tool-process/src/index.js'
import foldersSidebar from '../../plugin-sidebar-folders/src/index.js'
import multiRoot, { type MultiRootWorkspaceConfig } from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function projectFolders(): Promise<{ container: string; primary: string; api: string; docs: string; outside: string }> {
  const container = await mkdtemp(path.join(os.tmpdir(), 'flect-multi-root-'))
  temporaryDirectories.push(container)
  const primary = path.join(container, 'primary')
  const api = path.join(container, 'api')
  const docs = path.join(container, 'docs')
  const outside = path.join(container, 'outside')
  await Promise.all([primary, api, docs, outside].map(directory => mkdir(directory)))
  return { container, primary, api, docs, outside }
}

async function composition(root: string, config: MultiRootWorkspaceConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(ProjectService, { root })
  await Promise.all([
    ctx.plugin(CommandService),
    ctx.plugin(PromptService),
    ctx.plugin(ToolService),
    ctx.plugin(TuiService),
    ctx.plugin(WorkspaceService),
  ])
  await ctx.plugin(localWorkspace)
  const multiRootPlugin = await ctx.plugin(multiRoot, config)
  await Promise.all([
    ctx.plugin(workspaceTools),
    ctx.plugin(searchTools),
    ctx.plugin(patchTool),
    ctx.plugin(processTool),
    ctx.plugin(foldersSidebar),
  ])
  return { ctx, multiRootPlugin, close: () => ctx.fiber.dispose() }
}

function state(cwd: string, input = '', busy = false): TuiState {
  return {
    cwd, width: 130, height: 30, provider: 'test', model: 'test', models: ['test'],
    theme: 'test', contextWindow: 1_000, usage: {}, input, cursor: input.length,
    slashSelection: 0, viewports: {}, busy, status: 'ready', events: [], startedAt: Date.now(),
  }
}

function actions(value: TuiState, capture: { notifications: string[]; overlays: TuiOverlay[] }): TuiActions {
  return {
    state: value,
    setInput() {}, async submit() {}, exit() {}, clear() {}, cycleModel() {}, setModel() {},
    notify(message) { capture.notifications.push(message) },
    showOverlay(overlay) { capture.overlays.push(overlay) },
    closeOverlay() {}, moveSlashSelection() {}, acceptSlashSuggestion: () => false,
    scrollViewport() {}, pageViewport() {}, followViewport() {}, revealEvent() {},
    selectPermissionCandidate() {}, cancel: () => false,
    async newConversation() {}, async openConversation() {}, async forkConversation() {}, async renameConversation() {},
    answerPermission() {},
  }
}

const theme: Theme = {
  id: 'test', label: 'Test', tokens: {
    fontFamily: 'monospace', fontSize: 14,
    colors: {
      background: '#000', foreground: '#fff', muted: '#888', accent: '#0af',
      success: '#0f0', warning: '#ff0', danger: '#f00',
    },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
  },
}

function renderContext(value: TuiState): TuiRenderContext {
  return {
    state: value, theme, width: 40, height: 24, color: false,
    style: text => text, fit: text => text, wrap: text => [text],
    renderRich: lines => lines.map(line => line.spans.map(span => span.text).join('')),
  }
}

function commandEnvironment(cwd: string, output: string[]): CommandEnvironment {
  return {
    cwd,
    stdin: (async function* () {})(),
    stdout: { write: chunk => { output.push(chunk) } },
    stderr: { write: chunk => { output.push(chunk) } },
  }
}

describe('multi-root workspace plugin', () => {
  it('routes reads, listings, search, writes, patches, and command cwd through aliases', async () => {
    const { primary, api } = await projectFolders()
    await writeFile(path.join(primary, 'main.txt'), 'needle primary\n', 'utf8')
    await writeFile(path.join(api, 'api.txt'), 'needle api\n', 'utf8')
    const { ctx, multiRootPlugin, close } = await composition(primary, { folders: [{ alias: 'api', path: '../api' }] })
    const execution = { cwd: primary }

    const roots = await ctx.workspace.roots(execution)
    expect(roots).toMatchObject([
      { prefix: '.', primary: true, access: 'read-write', available: true },
      { prefix: '@api', primary: false, access: 'read-write', available: true },
    ])
    expect(ctx.project.root).toBe(primary)
    expect(await ctx.workspace.displayPath(path.join(api, 'api.txt'), execution)).toBe('@api/api.txt')
    expect(await ctx.prompts.render({ cwd: primary, model: 'test' })).toContain('@api/')

    expect(await ctx.tools.get('read_file')?.execute({ path: 'main.txt' }, execution)).toBe('needle primary\n')
    expect(await ctx.tools.get('read_file')?.execute({ path: '@api/api.txt' }, execution)).toBe('needle api\n')
    const listed = await ctx.tools.get('list_files')?.execute({}, execution) as string[]
    expect(listed).toEqual(expect.arrayContaining(['main.txt', '@api/', '@api/api.txt']))
    const files = await ctx.tools.get('find_files')?.execute({ pattern: '**/*.txt' }, execution) as { files: string[] }
    expect(files.files).toEqual(expect.arrayContaining(['main.txt', '@api/api.txt']))
    const found = await ctx.tools.get('search_text')?.execute({ query: 'needle', pattern: '**/*.txt' }, execution) as {
      matches: Array<{ path: string }>
    }
    expect(found.matches.map(match => match.path)).toEqual(expect.arrayContaining(['main.txt', '@api/api.txt']))

    let presentation: ToolPresentation | undefined
    await ctx.tools.get('write_file')?.execute({ path: '@api/new.txt', content: 'created\n' }, {
      ...execution, present: value => { presentation = value },
    })
    expect(await readFile(path.join(api, 'new.txt'), 'utf8')).toBe('created\n')
    expect(presentation).toMatchObject({ type: 'diff', data: { files: ['@api/new.txt'] } })

    const rejectedPatch = [
      '--- a/main.txt', '+++ b/main.txt', '@@ -1,1 +1,1 @@', '-needle primary', '+not committed',
      '--- a/@api/api.txt', '+++ b/@api/api.txt', '@@ -1,1 +1,1 @@', '-wrong context', '+not committed', '',
    ].join('\n')
    await expect(ctx.tools.get('apply_patch')?.execute({ patch: rejectedPatch }, execution)).rejects.toThrow('context mismatch')
    expect(await readFile(path.join(primary, 'main.txt'), 'utf8')).toBe('needle primary\n')
    expect(await readFile(path.join(api, 'api.txt'), 'utf8')).toBe('needle api\n')

    const patch = [
      '--- a/main.txt', '+++ b/main.txt', '@@ -1,1 +1,1 @@', '-needle primary', '+changed primary',
      '--- a/@api/api.txt', '+++ b/@api/api.txt', '@@ -1,1 +1,1 @@', '-needle api', '+changed api', '',
    ].join('\n')
    await ctx.tools.get('apply_patch')?.execute({ patch }, execution)
    expect(await readFile(path.join(primary, 'main.txt'), 'utf8')).toBe('changed primary\n')
    expect(await readFile(path.join(api, 'api.txt'), 'utf8')).toBe('changed api\n')

    const ran = await ctx.tools.get('run_command')?.execute({
      argv: ['/bin/pwd'], cwd: '@api',
    }, execution) as { code: number; stdout: string }
    expect(ran).toMatchObject({ code: 0, stdout: `${api}\n` })

    const sidebar = ctx.tui.listSidebarSections().find(section => section.id === 'flect.sidebar.folders')
    const rows = sidebar?.render(renderContext(state(primary)))?.rows.map(row => row.text).join('\n')
    expect(rows).toContain('@api · read-write')
    const capture = { notifications: [] as string[], overlays: [] as TuiOverlay[] }
    await expect(ctx.tui.executeSlash('/folders remove api', actions(state(primary), capture))).rejects.toThrow('configured workspace folder')
    await multiRootPlugin.dispose()
    expect(await ctx.workspace.roots(execution)).toMatchObject([{ prefix: '.', primary: true }])
    await close()
  })

  it('enforces read-only mounts and rejects traversal and symlink escapes', async () => {
    const { primary, api, docs, outside } = await projectFolders()
    await writeFile(path.join(docs, 'guide.txt'), 'read me\n', 'utf8')
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8')
    await symlink(outside, path.join(api, 'escape'), 'dir')
    const { ctx, close } = await composition(primary, { folders: [
      { alias: 'api', path: '../api' },
      { alias: 'docs', path: '../docs', access: 'read-only' },
    ] })
    const execution = { cwd: primary }

    expect(await ctx.tools.get('read_file')?.execute({ path: '@docs/guide.txt' }, execution)).toBe('read me\n')
    await expect(ctx.tools.get('write_file')?.execute({ path: '@docs/new.txt', content: 'no' }, execution)).rejects.toThrow('read-only')
    await expect(ctx.tools.get('apply_patch')?.execute({
      patch: '--- a/@docs/guide.txt\n+++ b/@docs/guide.txt\n@@ -1,1 +1,1 @@\n-read me\n+changed\n',
    }, execution)).rejects.toThrow('read-only')
    await expect(ctx.tools.get('run_command')?.execute({ argv: [process.execPath, '-e', '0'], cwd: '@docs' }, execution)).rejects.toThrow('read-only')
    await expect(ctx.tools.get('read_file')?.execute({ path: '@api/../outside/secret.txt' }, execution)).rejects.toThrow('escapes workspace')
    await expect(ctx.tools.get('read_file')?.execute({ path: '@api/escape/secret.txt' }, execution)).rejects.toThrow('symlink')
    await expect(ctx.tools.get('write_file')?.execute({ path: '@api/escape/new.txt', content: 'no' }, execution)).rejects.toThrow('symlink')
    await expect(ctx.tools.get('read_file')?.execute({ path: '@missing/file.txt' }, execution)).rejects.toThrow('unknown workspace folder')
    await expect(ctx.workspace.displayPath(path.join(outside, 'secret.txt'), execution)).rejects.toThrow('outside configured workspace folders')
    await close()
  })

  it('persists CLI additions, reports unavailable roots, refreshes them, and removes them via slash command', async () => {
    const { primary, api } = await projectFolders()
    const first = await composition(primary)
    const output: string[] = []
    await first.ctx.commands.execute('folders', ['add', '../api', 'server', '--read-only'], commandEnvironment(primary, output))
    expect(output.join('')).toContain('Mounted @server')
    await expect(first.ctx.commands.execute('folders', ['add', '.', 'nested'], commandEnvironment(primary, []))).rejects.toThrow('overlaps')
    expect(JSON.parse(await readFile(path.join(primary, '.flect', 'folders.json'), 'utf8'))).toMatchObject({
      version: 1, folders: [{ alias: 'server', access: 'read-only' }],
    })
    await first.close()

    const missingApi = path.join(path.dirname(api), 'api-away')
    await rename(api, missingApi)
    const second = await composition(primary)
    expect(await second.ctx.workspace.roots({ cwd: primary })).toMatchObject([
      { prefix: '.', available: true }, { prefix: '@server', available: false },
    ])
    await expect(second.ctx.tools.get('read_file')?.execute({ path: '@server/file.txt' }, { cwd: primary })).rejects.toThrow('unavailable')
    await rename(missingApi, api)

    const capture = { notifications: [] as string[], overlays: [] as TuiOverlay[] }
    const ready = actions(state(primary), capture)
    await second.ctx.tui.executeSlash('/folders status', ready)
    expect(capture.overlays.at(-1)?.lines.join('\n')).toContain('@server')
    expect((await second.ctx.workspace.roots({ cwd: primary }))[1]).toMatchObject({ prefix: '@server', available: true })
    const completionState = state(primary, '/folders remove ')
    expect(second.ctx.tui.slashSuggestions(completionState.input, completionState).map(item => item.label)).toContain('@server')
    await expect(second.ctx.tui.executeSlash('/folders add ../docs other', actions(state(primary, '', true), capture))).rejects.toThrow('current agent run')
    await second.ctx.tui.executeSlash('/folders remove @server', ready)
    expect(capture.notifications).toContain('removed @server')
    expect(JSON.parse(await readFile(path.join(primary, '.flect', 'folders.json'), 'utf8'))).toMatchObject({ folders: [] })
    await second.close()

    const third = await composition(primary)
    expect(await third.ctx.workspace.roots({ cwd: primary })).toHaveLength(1)
    expect(third.ctx.tools.definitions().map(tool => tool.name)).not.toContain('add_workspace_folder')
    await third.close()
  })
})
