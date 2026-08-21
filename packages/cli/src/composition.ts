import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin } from 'cordis'
import '@flect/sdk'
import { ProjectService } from '@flect/sdk'
import { readLayeredConfig, type LayeredConfigOptions } from './config.js'
import { ensureGitHubPlugin, parseGitHubPluginSpecifier, type GitHubPluginOptions } from './remote-plugins.js'

const hostRequire = createRequire(import.meta.url)

function pluginFromModule(module: Record<string, unknown>): Plugin {
  const candidate = module.default ?? module
  if (typeof candidate === 'function') return candidate as Plugin
  if (typeof candidate === 'object' && candidate !== null && typeof (candidate as { apply?: unknown }).apply === 'function') {
    return candidate as Plugin
  }
  if (typeof module.apply === 'function') return module as unknown as Plugin
  throw new TypeError('module does not export a Cordis plugin')
}

export function resolveSpecifier(specifier: string, configDirectory: string): string {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(configDirectory, specifier)).href
  }
  if (specifier.startsWith('file:')) return new URL(specifier, pathToFileURL(`${configDirectory}/`)).href

  const projectRequire = createRequire(path.join(configDirectory, 'package.json'))
  try {
    return pathToFileURL(projectRequire.resolve(specifier)).href
  } catch (projectError) {
    try {
      return pathToFileURL(hostRequire.resolve(specifier)).href
    } catch {
      throw new Error(`cannot resolve plugin "${specifier}" from ${configDirectory}`, { cause: projectError })
    }
  }
}

async function resolveConfiguredPlugin(specifier: string, configDirectory: string, options?: GitHubPluginOptions): Promise<string> {
  if (parseGitHubPluginSpecifier(specifier)) {
    const installed = await ensureGitHubPlugin(specifier, {
      ...options,
      onStatus: options?.onStatus ?? (message => process.stderr.write(`${message}\n`)),
    })
    return pathToFileURL(installed.entryFile).href
  }
  return resolveSpecifier(specifier, configDirectory)
}

function pendingMessage(fibers: Fiber[]): string {
  // Cordis publishes FiberState as an ambient const enum; PENDING is 0.
  const pending = fibers.filter(fiber => fiber.state === 0)
  if (!pending.length) return 'plugin activation timed out'
  return `plugins are waiting for missing services: ${pending.map(fiber => {
    const dependencies = Object.keys(fiber.inject).join(', ') || 'unknown'
    return `${fiber.name} (${dependencies})`
  }).join('; ')}`
}

async function settle(fibers: Fiber[], timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.all(fibers),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(pendingMessage(fibers))), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface Composition {
  ctx: Context
  close(): Promise<void>
}

export interface LoadCompositionOptions extends LayeredConfigOptions {
  githubPlugins?: GitHubPluginOptions
  projectRoot?: string
}

export async function loadComposition(
  filename: string,
  timeoutMs = 5_000,
  invocationCwd = path.dirname(filename),
  options: LoadCompositionOptions = {},
): Promise<Composition> {
  const config = await readLayeredConfig(filename, options)
  const directory = path.resolve(options.projectRoot ?? path.dirname(filename))
  const ctx = new Context()
  const fibers: Fiber[] = [ctx.plugin(ProjectService, {
    root: directory,
    invocationCwd,
    configFiles: config.sources,
  })]

  try {
    for (const entry of config.plugins) {
      if (entry.enabled === false) continue
      const resolved = await resolveConfiguredPlugin(entry.use, path.dirname(entry.sourceFile), options.githubPlugins)
      const module = await import(resolved) as Record<string, unknown>
      const plugin = pluginFromModule(module)
      fibers.push(ctx.plugin(plugin, entry.config))
    }
    await settle(fibers, timeoutMs)
    return {
      ctx,
      close: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
