import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadComposition } from '../src/composition.js'
import { readConfig } from '../src/config.js'
import { addPlugin, removePlugin } from '../src/plugins.js'
import {
  ensureGitHubPlugin, githubPluginDirectory, parseGitHubPluginSpecifier, type CommandRunner,
} from '../src/remote-plugins.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), label))
  temporaryDirectories.push(directory)
  return directory
}

function fakeClone(commands: Array<{ command: string; args: string[]; cwd?: string }>, source: string): CommandRunner {
  return async (command, args, cwd) => {
    commands.push({ command, args, ...(cwd ? { cwd } : {}) })
    if (command !== 'git' || args[0] !== 'clone') return
    const destination = args.at(-1)
    if (!destination) throw new Error('clone destination missing')
    await mkdir(path.join(destination, 'dist'), { recursive: true })
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({
      type: 'module',
      flect: './dist/index.mjs',
      dependencies: { example: '^1.0.0' },
    }))
    await writeFile(path.join(destination, 'dist', 'index.mjs'), source)
  }
}

describe('GitHub plugin sources', () => {
  it('normalizes URL and shorthand forms and rejects unsafe URLs and refs', () => {
    expect(parseGitHubPluginSpecifier('https://github.com/FlectHQ/Concise.git#v1.2.0')).toMatchObject({
      owner: 'flecthq', repository: 'concise', ref: 'v1.2.0',
      specifier: 'https://github.com/flecthq/concise#v1.2.0',
    })
    expect(parseGitHubPluginSpecifier('github:flecthq/concise')).toMatchObject({
      owner: 'flecthq', repository: 'concise',
    })
    expect(parseGitHubPluginSpecifier('@flect/plugin-example')).toBeUndefined()
    expect(() => parseGitHubPluginSpecifier('https://token@github.com/flecthq/concise')).toThrow(/uncredentialed HTTPS/)
    expect(() => parseGitHubPluginSpecifier('https://github.com/flecthq/concise/tree/main')).toThrow(/one repository/)
    expect(() => parseGitHubPluginSpecifier('github:flecthq/concise#../unsafe')).toThrow(/invalid GitHub plugin ref/)
  })

  it('installs once, uses the cache, and atomically refreshes', async () => {
    const root = await temporaryDirectory('flect-github-cache-')
    const commands: Array<{ command: string; args: string[]; cwd?: string }> = []
    const specifier = 'https://github.com/flecthq/concise#v1'
    const first = await ensureGitHubPlugin(specifier, {
      root,
      run: fakeClone(commands, 'export function apply() {}\n'),
    })
    expect(first.status).toBe('installed')
    expect(first.directory).toBe(githubPluginDirectory(first.source, root))
    expect(commands.map(command => command.command)).toEqual(['git', 'git', 'git', 'npm'])

    const cached = await ensureGitHubPlugin(specifier, {
      root,
      run: async () => { throw new Error('the cache should not run commands') },
    })
    expect(cached.status).toBe('cached')

    commands.length = 0
    const refreshed = await ensureGitHubPlugin(specifier, {
      root,
      refresh: true,
      run: fakeClone(commands, 'export function apply() {}\n'),
    })
    expect(refreshed.status).toBe('updated')
    expect(commands.map(command => command.command)).toEqual(['git', 'git', 'git', 'npm'])
  })

  it('adds and removes a normalized GitHub URL without treating it as an npm package', async () => {
    const directory = await temporaryDirectory('flect-remote-config-')
    const config = path.join(directory, 'flect.config.json')
    await writeFile(config, JSON.stringify({ version: 2, plugins: [] }))

    const added = await addPlugin(directory, 'github:FlectHQ/Concise.git#stable', { install: false })
    expect(added.entry.use).toBe('https://github.com/flecthq/concise#stable')
    expect((await readConfig(config)).plugins).toEqual([
      { use: 'https://github.com/flecthq/concise#stable' },
    ])

    await removePlugin(directory, 'github:flecthq/concise#stable')
    expect((await readConfig(config)).plugins).toEqual([])
  })

  it('loads a cached GitHub plugin directly from composition', async () => {
    const directory = await temporaryDirectory('flect-remote-composition-')
    const configDirectory = path.join(directory, 'config')
    const workspace = path.join(directory, 'workspace')
    const root = path.join(directory, 'managed')
    const config = path.join(configDirectory, 'flect.config.json')
    await mkdir(configDirectory)
    await mkdir(workspace)
    await writeFile(config, JSON.stringify({
      version: 2,
      plugins: [
        { use: '@flect/runtime' },
        { use: 'https://github.com/flecthq/remote-command#stable' },
      ],
    }))

    const composition = await loadComposition(config, 5_000, workspace, {
      isolated: true,
      projectRoot: workspace,
      githubPlugins: {
        root,
        run: fakeClone([], `export const inject = ['commands']
        export function apply(ctx) {
          ctx.commands.register({ name: 'remote', run: async () => 0 })
        }\n`),
      },
    })
    try {
      expect(composition.ctx.commands.get('remote')).toBeDefined()
      expect(composition.ctx.project.root).toBe(workspace)
    } finally {
      await composition.close()
    }
  })
})
