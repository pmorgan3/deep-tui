import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { userDataPath } from './config.js'

export interface GitHubPluginSource {
  owner: string
  repository: string
  ref?: string
  specifier: string
  cloneUrl: string
}

export interface InstalledGitHubPlugin {
  source: GitHubPluginSource
  directory: string
  entryFile: string
  status: 'cached' | 'installed' | 'updated'
}

export type CommandRunner = (command: string, args: string[], cwd?: string) => Promise<void>

export interface GitHubPluginOptions {
  root?: string
  refresh?: boolean
  gitBinary?: string
  npmBinary?: string
  run?: CommandRunner
  onStatus?: (message: string) => void
}

function validSegment(value: string, label: string): string {
  if (!/^[a-z\d](?:[a-z\d._-]{0,98}[a-z\d])?$/i.test(value)) {
    throw new Error(`invalid GitHub plugin ${label}: ${value}`)
  }
  return value
}

function validRef(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`invalid percent-encoding in GitHub plugin ref: ${value}`)
  }
  if (!/^[a-z\d][a-z\d._/-]{0,199}$/i.test(decoded)
    || decoded.includes('..') || decoded.includes('//') || decoded.includes('@{')
    || decoded.endsWith('/') || decoded.endsWith('.') || decoded.split('/').some(part => part === '.' || part === '..' || part.endsWith('.lock'))) {
    throw new Error(`invalid GitHub plugin ref: ${decoded}`)
  }
  return decoded
}

/** Parse the declarative GitHub forms accepted in `plugins[].use`. */
export function parseGitHubPluginSpecifier(specifier: string): GitHubPluginSource | undefined {
  let owner: string | undefined
  let repository: string | undefined
  let ref: string | undefined

  if (specifier.startsWith('github:')) {
    const match = /^github:([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/.exec(specifier)
    if (!match) throw new Error(`invalid GitHub plugin specifier: ${specifier}`)
    owner = match[1]
    repository = match[2]
    ref = match[3]
  } else {
    const input = specifier.startsWith('git+https://') ? specifier.slice(4) : specifier
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return undefined
    }
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    if (url.protocol !== 'https:' || url.username || url.password || url.search) {
      throw new Error(`GitHub plugins must use an uncredentialed HTTPS URL: ${specifier}`)
    }
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 2) throw new Error(`GitHub plugin URL must name one repository: ${specifier}`)
    owner = segments[0]
    repository = segments[1]?.replace(/\.git$/i, '')
    ref = url.hash ? url.hash.slice(1) : undefined
  }

  if (!owner || !repository) throw new Error(`invalid GitHub plugin specifier: ${specifier}`)
  const normalizedOwner = validSegment(owner, 'owner').toLowerCase()
  const normalizedRepository = validSegment(repository, 'repository').toLowerCase()
  const normalizedRef = ref ? validRef(ref) : undefined
  const normalized = `https://github.com/${normalizedOwner}/${normalizedRepository}${normalizedRef ? `#${normalizedRef}` : ''}`
  return {
    owner: normalizedOwner,
    repository: normalizedRepository,
    ...(normalizedRef ? { ref: normalizedRef } : {}),
    specifier: normalized,
    cloneUrl: `https://github.com/${normalizedOwner}/${normalizedRepository}.git`,
  }
}

export function githubPluginDirectory(source: GitHubPluginSource, root = userDataPath('plugins', 'github')): string {
  const digest = createHash('sha256').update(source.specifier).digest('hex').slice(0, 12)
  return path.join(root, `${source.owner}-${source.repository}-${digest}`)
}

async function isDirectory(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { ...(cwd ? { cwd } : {}), shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorOutput = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (errorOutput.length < 64_000) errorOutput += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}${errorOutput.trim() ? `: ${errorOutput.trim()}` : ''}`))
    })
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function conditionalExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(conditionalExport).find(Boolean)
  const object = record(value)
  if (!object) return undefined
  for (const key of ['import', 'node', 'default', 'require']) {
    const selected = conditionalExport(object[key])
    if (selected) return selected
  }
  return undefined
}

async function packageMetadata(directory: string): Promise<Record<string, unknown> | undefined> {
  const filename = path.join(directory, 'package.json')
  if (!await isFile(filename)) return undefined
  let value: unknown
  try {
    value = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid plugin package.json in ${directory}: ${error.message}`)
    throw error
  }
  const metadata = record(value)
  if (!metadata) throw new Error(`plugin package.json must contain an object: ${filename}`)
  return metadata
}

function declaredEntry(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  if (typeof metadata.flect === 'string') return metadata.flect
  const exports = record(metadata.exports)
  const exported = conditionalExport(exports?.['.'] ?? metadata.exports)
  if (exported) return exported
  if (typeof metadata.module === 'string') return metadata.module
  if (typeof metadata.main === 'string') return metadata.main
  return undefined
}

async function resolveEntryFile(directory: string): Promise<string> {
  const metadata = await packageMetadata(directory)
  const declared = declaredEntry(metadata)
  const candidates = declared ? [declared] : ['index.mjs', 'index.js']
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) throw new Error(`GitHub plugin entry must be relative to its repository: ${candidate}`)
    const filename = path.resolve(directory, candidate)
    const relative = path.relative(directory, filename)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`GitHub plugin entry escapes its repository: ${candidate}`)
    }
    if (!await isFile(filename)) continue
    const resolvedDirectory = await realpath(directory)
    const resolvedFile = await realpath(filename)
    const resolvedRelative = path.relative(resolvedDirectory, resolvedFile)
    if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
      throw new Error(`GitHub plugin entry resolves outside its repository: ${candidate}`)
    }
    return resolvedFile
  }
  throw new Error(`GitHub plugin has no loadable entry; declare "flect", "exports", "module", or "main" in package.json, or provide index.mjs`)
}

function hasProductionDependencies(metadata: Record<string, unknown> | undefined): boolean {
  for (const key of ['dependencies', 'optionalDependencies']) {
    const dependencies = record(metadata?.[key])
    if (dependencies && Object.keys(dependencies).length) return true
  }
  return false
}

async function cloneInto(source: GitHubPluginSource, directory: string, options: GitHubPluginOptions): Promise<void> {
  const run = options.run ?? runCommand
  const git = options.gitBinary ?? 'git'
  if (source.ref) {
    await run(git, ['clone', '--filter=blob:none', '--depth', '1', '--no-checkout', '--', source.cloneUrl, directory])
    await run(git, ['-C', directory, 'fetch', '--depth', '1', 'origin', source.ref])
    await run(git, ['-C', directory, 'checkout', '--detach', 'FETCH_HEAD'])
  } else {
    await run(git, ['clone', '--filter=blob:none', '--depth', '1', '--', source.cloneUrl, directory])
  }

  const metadata = await packageMetadata(directory)
  if (hasProductionDependencies(metadata)) {
    options.onStatus?.(`Installing production dependencies for ${source.specifier}`)
    await run(options.npmBinary ?? 'npm', [
      'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    ], directory)
  }
  await resolveEntryFile(directory)
}

async function replaceDirectory(staged: string, target: string): Promise<void> {
  if (!await isDirectory(target)) {
    await rename(staged, target)
    return
  }
  const backup = `${target}.previous-${process.pid}-${randomUUID()}`
  await rename(target, backup)
  try {
    await rename(staged, target)
  } catch (error) {
    await rename(backup, target)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

/** Ensure a GitHub plugin is present in the managed user-data cache. */
export async function ensureGitHubPlugin(specifier: string, options: GitHubPluginOptions = {}): Promise<InstalledGitHubPlugin> {
  const source = parseGitHubPluginSpecifier(specifier)
  if (!source) throw new Error(`not a GitHub plugin specifier: ${specifier}`)
  const root = options.root ?? userDataPath('plugins', 'github')
  const directory = githubPluginDirectory(source, root)
  if (!options.refresh && await isDirectory(directory)) {
    return { source, directory, entryFile: await resolveEntryFile(directory), status: 'cached' }
  }

  await mkdir(root, { recursive: true })
  const staged = path.join(root, `.${path.basename(directory)}-${process.pid}-${randomUUID()}`)
  const existed = await isDirectory(directory)
  options.onStatus?.(`${existed ? 'Updating' : 'Installing'} ${source.specifier}`)
  try {
    await cloneInto(source, staged, options)
    await replaceDirectory(staged, directory)
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
  return {
    source,
    directory,
    entryFile: await resolveEntryFile(directory),
    status: existed ? 'updated' : 'installed',
  }
}

export async function syncGitHubPlugins(specifiers: readonly string[], options: GitHubPluginOptions = {}): Promise<InstalledGitHubPlugin[]> {
  const unique = new Map<string, string>()
  for (const specifier of specifiers) {
    const source = parseGitHubPluginSpecifier(specifier)
    if (source) unique.set(source.specifier, source.specifier)
  }
  const installed: InstalledGitHubPlugin[] = []
  for (const specifier of unique.values()) installed.push(await ensureGitHubPlugin(specifier, options))
  return installed
}
