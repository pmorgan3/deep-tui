import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertRecord } from '@flect/sdk'

export const CONFIG_FILENAME = 'flect.config.json'

export interface PluginEntry {
  id?: string
  use: string
  enabled?: boolean
  config?: unknown
}

export interface HarnessConfig {
  $schema?: string
  version: 1 | 2
  extends?: string[]
  plugins: PluginEntry[]
}

export interface ResolvedPluginEntry extends PluginEntry {
  sourceFile: string
}

export interface LayeredHarnessConfig extends HarnessConfig {
  version: 2
  plugins: ResolvedPluginEntry[]
  sources: string[]
  provenance: Record<string, { use: string; enabled?: string; config?: string; fields?: Record<string, string> }>
}

export interface LayeredConfigOptions {
  explicitFile?: string
  isolated?: boolean
  userFile?: string
}

export const starterConfig: HarnessConfig = {
  version: 2,
  plugins: [
    { use: '@flect/runtime' },
    {
      use: '@flect/plugin-agent',
      config: { provider: 'deepseek', model: 'flash' },
    },
    { use: '@flect/plugin-budget' },
    { use: '@flect/plugin-provider-deepseek' },
    { use: '@flect/plugin-session-title' },
    { use: '@flect/plugin-prompt-coding' },
    { use: '@flect/plugin-theme-default' },
    { use: '@flect/plugin-theme-gruvbox' },
    { use: '@flect/plugin-theme-catppuccin' },
    { use: '@flect/plugin-theme-kanagawa' },
    { use: '@flect/plugin-theme-nord' },
    { use: '@flect/plugin-theme-monokai-pro' },
    { use: '@flect/plugin-slash-theme' },
    { use: '@flect/plugin-permission-rules' },
    { use: '@flect/plugin-permission-auto' },
    { use: '@flect/plugin-mode-plan' },
    { use: '@flect/plugin-compact' },
    { use: '@flect/plugin-auto-compact' },
    { use: '@flect/plugin-workspace-local' },
    { use: '@flect/plugin-workspace-multi-root' },
    { use: '@flect/plugin-workspace-ignore' },
    { use: '@flect/plugin-tool-workspace' },
    { use: '@flect/plugin-tool-search' },
    { use: '@flect/plugin-tool-patch' },
    { use: '@flect/plugin-tool-process' },
    { use: '@flect/plugin-git' },
    { use: '@flect/plugin-audit-redact-default' },
    { use: '@flect/plugin-audit-jsonl' },
    { use: '@flect/plugin-session-files' },
    { use: '@flect/plugin-highlight-shiki' },
    { use: '@flect/plugin-render-markdown' },
    { use: '@flect/plugin-render-read-file' },
    { use: '@flect/plugin-render-files' },
    { use: '@flect/plugin-render-search-text' },
    { use: '@flect/plugin-render-run-command' },
    { use: '@flect/plugin-render-diff' },
    { use: '@flect/plugin-render-diff-pretty' },
    { use: '@flect/plugin-usage-inline' },
    { use: '@flect/plugin-sidebar' },
    { use: '@flect/plugin-sidebar-plan' },
    { use: '@flect/plugin-sidebar-changes' },
    { use: '@flect/plugin-sidebar-context' },
    { use: '@flect/plugin-sidebar-activity' },
    { use: '@flect/plugin-sidebar-verification' },
    { use: '@flect/plugin-sidebar-session' },
    { use: '@flect/plugin-sidebar-folders' },
    { use: '@flect/plugin-sidebar-modes' },
    { use: '@flect/plugin-sidebar-permissions' },
    { use: '@flect/plugin-zellij-title' },
    { use: '@flect/plugin-ui-terminal' },
    { use: '@flect/plugin-welcome-brand' },
    { use: '@flect/plugin-welcome-prompt' },
    {
      use: '@flect/plugin-ui-tui',
      config: { provider: 'deepseek', model: 'flash', models: ['flash', 'pro'] },
    },
  ],
}

async function exists(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function findConfig(start: string, explicit?: string): Promise<string | undefined> {
  if (explicit) {
    const filename = path.resolve(start, explicit)
    if (!await exists(filename)) throw new Error(`configuration not found: ${filename}`)
    return filename
  }
  let directory = path.resolve(start)
  while (true) {
    const candidate = path.join(directory, CONFIG_FILENAME)
    if (await exists(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export function validateConfig(value: unknown): HarnessConfig {
  assertRecord(value, 'configuration')
  if (value.version !== 1 && value.version !== 2) throw new Error('configuration version must be 1 or 2')
  if (!Array.isArray(value.plugins)) throw new TypeError('configuration plugins must be an array')
  if (value.extends !== undefined && (!Array.isArray(value.extends) || !value.extends.every(item => typeof item === 'string' && item))) {
    throw new TypeError('configuration extends must be an array of non-empty strings')
  }
  const plugins = value.plugins.map((entry, index): PluginEntry => {
    assertRecord(entry, `plugins[${index}]`)
    if (typeof entry.use !== 'string' || !entry.use) {
      throw new TypeError(`plugins[${index}].use must be a non-empty string`)
    }
    if (entry.id !== undefined && (typeof entry.id !== 'string' || !entry.id)) {
      throw new TypeError(`plugins[${index}].id must be a non-empty string`)
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new TypeError(`plugins[${index}].enabled must be a boolean`)
    }
    return {
      use: entry.use,
      ...(entry.id === undefined ? {} : { id: entry.id }),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
    }
  })
  return {
    version: value.version,
    ...(typeof value.$schema === 'string' ? { $schema: value.$schema } : {}),
    ...(Array.isArray(value.extends) && value.extends.every(item => typeof item === 'string')
      ? { extends: value.extends as string[] }
      : {}),
    plugins,
  }
}

export async function readConfig(filename: string): Promise<HarnessConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${filename}: ${error.message}`)
    throw error
  }
  return validateConfig(parsed)
}

export function userConfigPath(): string {
  if (process.env.FLECT_USER_CONFIG) return path.resolve(process.env.FLECT_USER_CONFIG)
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'flect', 'config.json')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'flect', 'config.json')
}

export function userDataPath(...segments: string[]): string {
  const root = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'flect')
    : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'flect')
  return path.join(root, ...segments)
}

export interface SelectedConfig {
  filename?: string
  explicitFile?: string
  userOnly?: boolean
}

/** Select project/explicit configuration, falling back to the global user file. */
export async function selectConfig(cwd: string, explicit?: string, userFile = userConfigPath()): Promise<SelectedConfig> {
  const configured = explicit ?? process.env.FLECT_CONFIG
  const projectFile = await findConfig(cwd)
  const explicitFile = configured ? await findConfig(cwd, configured) : undefined
  let fallback: string | undefined
  if (!projectFile && !explicitFile) {
    try {
      await readConfig(userFile)
      fallback = userFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const selected = projectFile ?? explicitFile ?? fallback
  return {
    ...(selected ? { filename: selected } : {}),
    ...(explicitFile ? { explicitFile } : {}),
    ...(fallback ? { userOnly: true } : {}),
  }
}

function mergeObject(base: unknown, next: unknown): unknown {
  if (next === null) return undefined
  if (typeof base !== 'object' || base === null || Array.isArray(base)
    || typeof next !== 'object' || next === null || Array.isArray(next)) return next
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
    const merged = mergeObject(output[key], value)
    if (merged === undefined) delete output[key]
    else output[key] = merged
  }
  return output
}

function configPathsFor(value: unknown, prefix = 'config'): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix]
  const entries = Object.entries(value)
  return entries.length ? entries.flatMap(([key, item]) => configPathsFor(item, `${prefix}.${key}`)) : [prefix]
}

function resolveExtension(source: string, extension: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(extension) && !extension.startsWith('file:')) {
    throw new Error(`configuration extends does not support URLs: ${extension}`)
  }
  if (extension.startsWith('.') || path.isAbsolute(extension) || extension.startsWith('file:')) {
    return extension.startsWith('file:')
      ? fileURLToPath(new URL(extension, pathToFileURL(`${path.dirname(source)}${path.sep}`)))
      : path.resolve(path.dirname(source), extension)
  }
  return createRequire(source).resolve(extension)
}

async function readSourceGraph(filename: string, stack: string[], output: Array<{ filename: string; config: HarnessConfig }>): Promise<void> {
  const resolved = await realpath(path.resolve(filename))
  if (stack.includes(resolved)) throw new Error(`configuration extends cycle: ${[...stack, resolved].join(' -> ')}`)
  if (output.some(source => source.filename === resolved)) return
  const config = await readConfig(resolved)
  for (const extension of config.extends ?? []) {
    await readSourceGraph(resolveExtension(resolved, extension), [...stack, resolved], output)
  }
  output.push({ filename: resolved, config })
}

export async function readLayeredConfig(projectFile: string, options: LayeredConfigOptions = {}): Promise<LayeredHarnessConfig> {
  const sources: Array<{ filename: string; config: HarnessConfig }> = []
  const user = options.userFile ?? userConfigPath()
  if (!options.isolated && path.resolve(user) !== path.resolve(projectFile) && await exists(user)) await readSourceGraph(user, [], sources)
  await readSourceGraph(options.isolated && options.explicitFile ? options.explicitFile : projectFile, [], sources)
  if (!options.isolated && options.explicitFile && path.resolve(options.explicitFile) !== path.resolve(projectFile)) {
    await readSourceGraph(options.explicitFile, [], sources)
  }
  const entries = new Map<string, ResolvedPluginEntry>()
  const provenance: LayeredHarnessConfig['provenance'] = {}
  const order: string[] = []
  for (const source of sources) {
    const duplicates = new Set<string>()
    for (const entry of source.config.plugins) {
      const identity = entry.id ?? entry.use
      if (duplicates.has(identity)) throw new Error(`duplicate plugin "${identity}" in ${source.filename}`)
      duplicates.add(identity)
      const current = entries.get(identity)
      const mergedConfig = entry.config === undefined ? current?.config : mergeObject(current?.config, entry.config)
      const merged: ResolvedPluginEntry = {
        ...(current ?? {} as ResolvedPluginEntry),
        ...entry,
        sourceFile: source.filename,
        ...(mergedConfig === undefined ? {} : { config: mergedConfig }),
      }
      if (mergedConfig === undefined) delete merged.config
      if (!current) order.push(identity)
      entries.set(identity, merged)
      const previous = provenance[identity]
      let fields = previous?.fields ? { ...previous.fields } : undefined
      if (entry.config !== undefined) {
        if (entry.config === null) fields = { config: source.filename }
        else {
          fields ??= {}
          for (const field of configPathsFor(entry.config)) {
            for (const existing of Object.keys(fields)) {
              if (existing === field || existing.startsWith(`${field}.`)) delete fields[existing]
            }
            fields[field] = source.filename
          }
        }
      }
      provenance[identity] = {
        use: source.filename,
        ...(entry.enabled === undefined ? (previous?.enabled ? { enabled: previous.enabled } : {}) : { enabled: source.filename }),
        ...(entry.config === undefined ? (previous?.config ? { config: previous.config } : {}) : { config: source.filename }),
        ...(fields ? { fields } : {}),
      }
    }
  }
  return {
    version: 2,
    plugins: order.map(identity => entries.get(identity)).filter((entry): entry is ResolvedPluginEntry => Boolean(entry)),
    sources: sources.map(source => source.filename),
    provenance,
  }
}

export function configPaths(projectFile: string): { user: string; project: string } {
  return { user: userConfigPath(), project: path.resolve(projectFile) }
}

export function redactConfiguration<T>(value: T): T {
  const secret = /(authorization|api[-_]?key|token|secret|password|cookie)/i
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit)
    if (typeof input !== 'object' || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, secret.test(key) ? '[redacted]' : visit(item)]))
  }
  return visit(value) as T
}

export async function writeConfig(filename: string, config: HarnessConfig): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

export async function initializeConfig(cwd: string): Promise<string> {
  const filename = path.join(path.resolve(cwd), CONFIG_FILENAME)
  return initializeConfigFile(filename)
}

export async function initializeConfigFile(filename: string): Promise<string> {
  if (await exists(filename)) throw new Error(`${CONFIG_FILENAME} already exists`)
  await writeConfig(filename, starterConfig)
  return filename
}
