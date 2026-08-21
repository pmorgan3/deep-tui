import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CONFIG_FILENAME, findConfig, readConfig, userConfigPath, userDataPath, writeConfig, type PluginEntry } from './config.js'
import { ensureGitHubPlugin, parseGitHubPluginSpecifier } from './remote-plugins.js'

export type ConfigScope = 'user' | 'project'

async function mutationConfig(cwd: string, explicit: string | undefined, scope: ConfigScope): Promise<string | undefined> {
  if (scope === 'user') return userConfigPath()
  return findConfig(cwd, explicit)
}

function sanitizeName(input: string): string {
  const name = input.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('plugin name must contain a letter or number')
  return name
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const separator = specifier.indexOf('/')
    if (separator < 0) throw new Error(`invalid scoped package specifier: ${specifier}`)
    const version = specifier.indexOf('@', separator)
    return version < 0 ? specifier : specifier.slice(0, version)
  }
  const version = specifier.indexOf('@')
  return version < 0 ? specifier : specifier.slice(0, version)
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function detectPackageManager(directory: string): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  const candidates = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ] as const
  for (const [lockfile, manager] of candidates) {
    if (await isFile(path.join(directory, lockfile))) return manager
  }
  return 'pnpm'
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code ?? 'unknown'}`)))
  })
}

export async function addPlugin(
  cwd: string,
  specifier: string,
  options: { configPath?: string; install?: boolean; scope?: ConfigScope } = {},
): Promise<{ configPath: string; entry: PluginEntry }> {
  const configPath = await mutationConfig(cwd, options.configPath, options.scope ?? 'project')
  if (!configPath) throw new Error(`no ${CONFIG_FILENAME} found; run "deep-tui init" first`)
  const config = await readConfig(configPath)
  const remote = parseGitHubPluginSpecifier(specifier)
  const local = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
  const use = remote?.specifier ?? (local ? specifier : packageName(specifier))
  if (config.plugins.some(entry => entry.use === use)) throw new Error(`plugin "${use}" is already configured`)

  if (remote && options.install !== false) {
    await ensureGitHubPlugin(use)
  } else if (!remote && !local && options.install !== false) {
    const directory = path.dirname(configPath)
    const manager = await detectPackageManager(directory)
    const args = manager === 'npm'
      ? ['install', '--save-dev', specifier]
      : manager === 'yarn'
        ? ['add', '--dev', specifier]
        : manager === 'bun'
          ? ['add', '--dev', specifier]
          : ['add', '--save-dev', specifier]
    await run(manager, args, directory)
  }

  const entry = { use }
  config.plugins.push(entry)
  await writeConfig(configPath, config)
  return { configPath, entry }
}

export async function removePlugin(cwd: string, specifier: string, configPath?: string, scope: ConfigScope = 'project'): Promise<string> {
  const filename = await mutationConfig(cwd, configPath, scope)
  if (!filename) throw new Error(`no ${CONFIG_FILENAME} found`)
  const config = await readConfig(filename)
  const normalized = parseGitHubPluginSpecifier(specifier)?.specifier ?? specifier
  const index = config.plugins.findIndex(entry => entry.use === normalized || entry.id === specifier)
  if (index < 0) throw new Error(`plugin "${specifier}" is not configured`)
  config.plugins.splice(index, 1)
  await writeConfig(filename, config)
  return filename
}

export type PluginTemplate = 'prompt' | 'slash'

export async function createPlugin(
  cwd: string,
  requestedName: string,
  configPath?: string,
  template: PluginTemplate = 'prompt',
  scope: ConfigScope = 'project',
): Promise<string> {
  const filename = await mutationConfig(cwd, configPath, scope)
  if (!filename) throw new Error(`no ${CONFIG_FILENAME} found; run "deep-tui init" first`)
  const name = sanitizeName(requestedName)
  const directory = scope === 'user' ? userDataPath('plugins') : path.join(path.dirname(filename), '.deep-tui', 'plugins')
  const pluginPath = path.join(directory, `${name}.mjs`)
  if (await isFile(pluginPath)) throw new Error(`plugin already exists: ${pluginPath}`)

  await mkdir(directory, { recursive: true })
  const source = template === 'slash'
    ? `// Created by Deep TUI. This is an ordinary Cordis plugin.\n` +
      `export const name = ${JSON.stringify(name)}\n` +
      `export const inject = ['tui']\n\n` +
      `export function apply(ctx) {\n` +
      `  ctx.tui.registerSlashCommand({\n` +
      `    id: ${JSON.stringify(`local.${name}`)},\n` +
      `    name: ${JSON.stringify(name)},\n` +
      `    description: 'Describe what this command does.',\n` +
      `    run(args, actions) {\n` +
      `      actions.showOverlay({\n` +
      `        id: ${JSON.stringify(name)},\n` +
      `        title: ${JSON.stringify(name)},\n` +
      `        lines: [\`Arguments: \${args.join(' ') || '(none)'}\`],\n` +
      `      })\n` +
      `    },\n` +
      `  })\n` +
      `}\n`
    : `// Created by Deep TUI. This is an ordinary Cordis plugin.\n` +
      `export const name = ${JSON.stringify(name)}\n` +
      `export const inject = ['prompts']\n\n` +
      `export function apply(ctx) {\n` +
      `  ctx.prompts.register({\n` +
      `    id: ${JSON.stringify(`local.${name}`)},\n` +
      `    order: 50,\n` +
      `    render: () => 'Add your prompt, policy, or persona here.',\n` +
      `  })\n` +
      `}\n`
  await writeFile(pluginPath, source, { encoding: 'utf8', flag: 'wx' })

  const relative = `./${path.relative(path.dirname(filename), pluginPath).split(path.sep).join('/')}`
  try {
    await addPlugin(cwd, relative, { configPath: filename, install: false, scope })
  } catch (error) {
    throw new Error(`created ${pluginPath}, but could not add it to the composition`, { cause: error })
  }
  return pluginPath
}
