#!/usr/bin/env node
import path from 'node:path'
import { formatUnknownError } from '@flect/sdk'
import {
  CONFIG_FILENAME, configPaths, findConfig, initializeConfig, readConfig, readLayeredConfig,
  initializeConfigFile, redactConfiguration, selectConfig, userConfigPath,
} from './config.js'
import { loadComposition } from './composition.js'
import { addPlugin, createPlugin, removePlugin } from './plugins.js'
import { parseGitHubPluginSpecifier, syncGitHubPlugins } from './remote-plugins.js'

const VERSION = '0.0.0'

function bootstrapHelp(): string {
  return `Flect\n\n` +
    `Usage:\n` +
    `  flect init\n` +
    `  flect plugin add <package-path-or-github-url>\n` +
    `  flect plugin create <name> [--template prompt|slash]\n` +
    `  flect plugin remove <package-or-id>\n` +
    `  flect plugin list\n` +
    `  flect plugin sync [github-url-or-id]\n` +
    `  flect plugin update [github-url-or-id]\n` +
    `  flect config paths|show|explain|validate|init\n` +
    `  flect <plugin-contributed-command> [...args]\n\n` +
    `Global options:\n` +
    `  --config <path>  Use an explicit composition\n` +
    `  --isolated-config Load only the selected composition\n` +
    `  --version        Print the version\n`
}

async function bootstrapConfig(args: string[], cwd: string, explicit?: string, isolated = false): Promise<number> {
  const action = args[0] ?? 'show'
  if (action === 'init') {
    const scopeIndex = args.indexOf('--scope')
    const scope = scopeIndex < 0 ? 'project' : args[scopeIndex + 1]
    if (scope !== 'user' && scope !== 'project') throw new Error('--scope must be user or project')
    const target = scope === 'user' ? userConfigPath() : path.join(cwd, CONFIG_FILENAME)
    await initializeConfigFile(target)
    process.stdout.write(`Created ${target}\n`)
    return 0
  }
  const selected = await selectConfig(cwd, explicit)
  const filename = selected.filename
  if (!filename) throw new Error(`no ${CONFIG_FILENAME} found`)
  if (action === 'paths') {
    const paths = configPaths(filename)
    const layered = await readLayeredConfig(filename, { ...(selected.explicitFile ? { explicitFile: selected.explicitFile } : {}), isolated })
    process.stdout.write(`user     ${paths.user}\nproject  ${selected.userOnly ? '(none)' : paths.project}\n${selected.explicitFile ? `explicit ${selected.explicitFile}\n` : ''}active:\n${layered.sources.map(source => `  ${source}`).join('\n')}\n`)
    return 0
  }
  if (action === 'show') {
    const layered = await readLayeredConfig(filename, { ...(selected.explicitFile ? { explicitFile: selected.explicitFile } : {}), isolated })
    process.stdout.write(`${JSON.stringify(redactConfiguration({ version: layered.version, plugins: layered.plugins.map(({ sourceFile: _source, ...entry }) => entry) }), null, 2)}\n`)
    return 0
  }
  if (action === 'explain') {
    const layered = await readLayeredConfig(filename, { ...(selected.explicitFile ? { explicitFile: selected.explicitFile } : {}), isolated })
    const requested = args[1]
    const entries = layered.plugins.filter(entry => !requested || (entry.id ?? entry.use) === requested)
    if (!entries.length) throw new Error(requested ? `plugin "${requested}" is not configured` : 'no plugins are configured')
    for (const entry of entries) {
      const identity = entry.id ?? entry.use
      process.stdout.write(`${identity}\n${JSON.stringify({ effective: redactConfiguration(entry), provenance: layered.provenance[identity] }, null, 2)}\n`)
    }
    return 0
  }
  if (action === 'validate') {
    const options = { ...(selected.explicitFile ? { explicitFile: selected.explicitFile } : {}), isolated }
    const layered = await readLayeredConfig(filename, options)
    const composition = await loadComposition(filename, 5_000, cwd, {
      ...options,
      ...(selected.userOnly ? { projectRoot: cwd } : {}),
    })
    await composition.close()
    process.stdout.write(`Valid: ${layered.plugins.length} plugins from ${layered.sources.length} configuration file(s).\n`)
    return 0
  }
  throw new Error('usage: flect config <paths|show|explain|validate|init>')
}

function extractConfig(args: string[]): { args: string[]; configPath?: string; isolated: boolean } {
  const copy = [...args]
  if (copy[0] === '--') copy.shift()
  const isolatedIndex = copy.indexOf('--isolated-config')
  const isolated = isolatedIndex >= 0
  if (isolated) copy.splice(isolatedIndex, 1)
  const index = copy.indexOf('--config')
  if (index < 0) return { args: copy, isolated }
  const configPath = copy[index + 1]
  if (!configPath) throw new Error('--config requires a path')
  copy.splice(index, 2)
  return { args: copy, configPath, isolated }
}

async function bootstrapPlugin(args: string[], cwd: string, configPath?: string): Promise<number> {
  const [action, ...rawOptions] = args
  const options = [...rawOptions]
  const scopeIndex = options.indexOf('--scope')
  const scope = scopeIndex < 0 ? 'project' : options[scopeIndex + 1]
  if (scope !== 'user' && scope !== 'project') throw new Error('--scope must be user or project')
  if (scopeIndex >= 0) options.splice(scopeIndex, 2)
  const value = options[0]
  if (action === 'add' && value) {
    const result = await addPlugin(cwd, value, { ...(configPath ? { configPath } : {}), scope })
    process.stdout.write(`Added ${result.entry.use} to ${result.configPath}\n`)
    return 0
  }
  if (action === 'create' && value) {
    const templateIndex = options.indexOf('--template')
    const template = templateIndex < 0 ? 'prompt' : options[templateIndex + 1]
    if (template !== 'prompt' && template !== 'slash') {
      throw new Error('--template must be "prompt" or "slash"')
    }
    const created = await createPlugin(cwd, value, configPath, template, scope)
    process.stdout.write(`Created and enabled ${created}\n`)
    return 0
  }
  if (action === 'remove' && value) {
    const filename = await removePlugin(cwd, value, configPath, scope)
    process.stdout.write(`Removed ${value} from ${filename}\n`)
    return 0
  }
  if (action === 'list') {
    const filename = scope === 'user' ? userConfigPath() : await findConfig(cwd, configPath)
    if (!filename) throw new Error(`no ${CONFIG_FILENAME} found`)
    const config = await readConfig(filename)
    for (const entry of config.plugins) {
      process.stdout.write(`${entry.enabled === false ? 'off' : 'on '}  ${entry.id ? `${entry.id}: ` : ''}${entry.use}\n`)
    }
    return 0
  }
  if (action === 'sync' || action === 'update') {
    const filename = scope === 'user' ? userConfigPath() : await findConfig(cwd, configPath)
    if (!filename) throw new Error(`no ${CONFIG_FILENAME} found`)
    const config = await readConfig(filename)
    const requested = value ? parseGitHubPluginSpecifier(value)?.specifier ?? value : undefined
    const entries = config.plugins.filter(entry => entry.enabled !== false && (!requested || entry.id === value || entry.use === requested))
    if (value && !entries.length) throw new Error(`plugin "${value}" is not configured in ${filename}`)
    const specifiers = entries.map(entry => entry.use).filter(use => parseGitHubPluginSpecifier(use))
    if (!specifiers.length) {
      if (value) throw new Error(`plugin "${value}" is not a GitHub plugin`)
      process.stdout.write(`No GitHub plugins configured in ${filename}\n`)
      return 0
    }
    const installed = await syncGitHubPlugins(specifiers, {
      refresh: action === 'update',
      onStatus: message => process.stderr.write(`${message}\n`),
    })
    for (const plugin of installed) process.stdout.write(`${plugin.status}  ${plugin.source.specifier}\n`)
    return 0
  }
  throw new Error('usage: flect plugin <add|create|remove|list|sync|update> [value] [--template prompt|slash] [--scope user|project]')
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const extracted = extractConfig(argv)
  const [command, ...args] = extracted.args
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command === 'init') {
    const filename = await initializeConfig(cwd)
    process.stdout.write(`Created ${filename}\n`)
    return 0
  }
  if (command === 'plugin') return bootstrapPlugin(args, cwd, extracted.configPath)
  if (command === 'config') return bootstrapConfig(args, cwd, extracted.configPath, extracted.isolated)

  const selected = await selectConfig(cwd, extracted.configPath)
  const filename = selected.filename
  if (!filename) {
    process.stdout.write(bootstrapHelp())
    return command ? 1 : 0
  }

  const composition = await loadComposition(filename, 5_000, cwd, {
    ...(selected.explicitFile ? { explicitFile: selected.explicitFile } : {}),
    isolated: extracted.isolated,
    ...(selected.userOnly ? { projectRoot: cwd } : {}),
  })
  try {
    const commandName = command ?? composition.ctx.commands.defaultName()
    if (!commandName) throw new Error('no default command is registered by the active plugins')
    return await composition.ctx.commands.execute(commandName, args, {
      cwd: selected.userOnly ? cwd : path.dirname(filename),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    })
  } finally {
    await composition.close()
  }
}

main().then(
  code => { process.exitCode = code },
  error => {
    process.stderr.write(`error: ${formatUnknownError(error)}\n`)
    process.exitCode = 1
  },
)
