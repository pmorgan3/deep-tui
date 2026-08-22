import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadComposition } from '../src/composition.js'
import { initializeConfig, readConfig } from '../src/config.js'
import { createPlugin } from '../src/plugins.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('composition workflow', () => {
  it('initializes, creates, enables, and loads a local plugin', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-composition-'))
    temporaryDirectories.push(cwd)
    const configPath = await initializeConfig(cwd)
    const pluginPath = await createPlugin(cwd, 'concise prompt')
    const slashPluginPath = await createPlugin(cwd, 'hello slash', configPath, 'slash')

    expect(await readFile(pluginPath, 'utf8')).toContain("export const inject = ['prompts']")
    expect(await readFile(slashPluginPath, 'utf8')).toContain('registerSlashCommand')
    const config = await readConfig(configPath)
    expect(config.plugins.slice(-2).map(plugin => plugin.use)).toEqual([
      './.deep-tui/plugins/concise-prompt.mjs',
      './.deep-tui/plugins/hello-slash.mjs',
    ])

    const composition = await loadComposition(configPath)
    try {
      const prompt = await composition.ctx.prompts.render({ cwd, model: 'test' })
      expect(prompt).toContain('Add your prompt, policy, or persona here.')
      expect(composition.ctx.commands.get('run')).toBeDefined()
      expect(composition.ctx.commands.defaultName()).toBe('tui')
      expect(composition.ctx.tui.component('composer')?.id).toBe('deep-tui.default.composer')
      expect(composition.ctx.tui.slashCommand('theme')?.id).toBe('deep-tui.theme.select')
      expect(composition.ctx.tui.slashCommand('auto')?.id).toBe('deep-tui.permission.auto.command')
      expect(composition.ctx.tui.slashCommand('plan')?.id).toBe('deep-tui.mode.plan.command')
      expect(composition.ctx.tui.slashCommand('folders')?.id).toBe('deep-tui.workspace.folders.command')
      expect(composition.ctx.commands.get('folders')).toBeDefined()
      expect(composition.ctx.tui.slashCommand('skills')?.id).toBe('deep-tui.skills.manage')
      expect(composition.ctx.commands.get('skills')).toBeDefined()
      expect(composition.ctx.tools.get('skill')).toBeDefined()
      expect(composition.ctx.tui.listStatusItems().map(item => item.id)).toContain('deep-tui.usage.session-cost')
      expect(composition.ctx.tui.listEventRenderers().map(item => item.id)).toContain('deep-tui.diff.tool-result')
      expect(composition.ctx.tui.listEventRenderers().map(item => item.id)).toContain('deep-tui.read-file.tool-result')
      expect(composition.ctx.tui.listEventRenderers().map(item => item.id)).toContain('deep-tui.files.tool-result')
      expect(composition.ctx.tui.listEventRenderers().map(item => item.id)).toContain('deep-tui.search-text.tool-result')
      expect(composition.ctx.tui.component('sidebar')?.id).toBe('deep-tui.sidebar.compositor')
      expect(composition.ctx.tui.listSidebarSections().map(section => section.id)).toEqual([
        'deep-tui.sidebar.plan',
        'deep-tui.sidebar.changes',
        'deep-tui.sidebar.context',
        'deep-tui.sidebar.activity',
        'deep-tui.sidebar.verification',
        'deep-tui.sidebar.session',
        'deep-tui.sidebar.folders',
        'deep-tui.sidebar.modes',
        'deep-tui.sidebar.permissions',
      ])
      expect(composition.ctx.tui.slashCommand('sidebar')?.id).toBe('deep-tui.sidebar.command')
      expect(composition.ctx.themes.list()).toHaveLength(14)
      expect(composition.ctx.billing.get('deepseek')).toBeDefined()
      expect(composition.ctx.tui.slashCommand('hello-slash')?.id).toBe('local.hello-slash')
    } finally {
      await composition.close()
    }
  })
})
