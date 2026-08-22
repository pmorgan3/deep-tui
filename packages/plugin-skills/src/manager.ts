import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { CURATED_SKILL_SOURCES, VOLTAGENT_CATALOG_URL, type SkillSourceDefinition } from './catalog.js'
import { parseAwesomeCatalog } from './awesome.js'

const SOURCE_METADATA = '.deep-tui-skill-source.json'

export interface SkillsPluginConfig {
  /** Managed installation directory. Relative paths resolve from the project root. */
  directory?: string
  /** Additional directories containing skill folders, in highest-precedence order. */
  paths?: string[]
  /** Scan ~/.agents/skills in addition to project-local locations. Defaults to true. */
  includeUserSkills?: boolean
  /** Scan project and user .claude/skills compatibility directories. Defaults to true. */
  includeClaudeSkills?: boolean
  /** Include Deep TUI's reviewed catalog. Defaults to true. */
  includeCuratedCatalog?: boolean
  /** Include searchable entries from VoltAgent/awesome-agent-skills. Defaults to true. */
  includeAwesomeCatalog?: boolean
  /** Additional or replacement catalog entries, keyed by id. */
  catalog?: SkillSourceDefinition[]
  gitBinary?: string
  installTimeoutMs?: number
  catalogTimeoutMs?: number
  maxSkills?: number
  maxSkillBytes?: number
  maxResourceBytes?: number
}

export interface SkillRecord {
  name: string
  description: string
  location: string
  directory: string
  source: string
}

export interface SkillDiagnostic {
  location: string
  message: string
}

export interface SkillDiscovery {
  skills: SkillRecord[]
  diagnostics: SkillDiagnostic[]
}

export interface InstalledSkillSource extends SkillSourceDefinition {
  directory: string
}

export interface SkillSourceChange {
  source: InstalledSkillSource
  skills: SkillRecord[]
  status: 'installed' | 'updated'
}

export type SkillCommandRunner = (command: string, args: readonly string[], cwd?: string) => Promise<void>
export type SkillCatalogFetch = (input: string, init?: RequestInit) => Promise<Response>

interface SkillManagerRuntime {
  homeDirectory?: string
  run?: SkillCommandRunner
  fetch?: SkillCatalogFetch
}

interface StoredSource extends SkillSourceDefinition {
  version: 1
  skillsPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

function safeId(value: string): string {
  if (!/^[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?$/i.test(value)) throw new Error(`invalid skill source id: ${value}`)
  return value.toLowerCase()
}

function safeRelativeDirectory(value: string | undefined): string {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`invalid skills path: ${String(value)}`)
  const candidate = value ?? 'skills'
  if (!candidate || path.isAbsolute(candidate) || candidate.includes('\0')) throw new Error(`invalid skills path: ${candidate}`)
  const normalized = path.normalize(candidate)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`skills path escapes its repository: ${candidate}`)
  return normalized
}

function safeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`invalid skill source ref: ${String(value)}`)
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`invalid percent-encoding in skill source ref: ${value}`)
  }
  if (!/^[a-z\d][a-z\d._/-]{0,199}$/i.test(decoded)
    || decoded.includes('..') || decoded.includes('//') || decoded.includes('@{')
    || decoded.endsWith('/') || decoded.endsWith('.')
    || decoded.split('/').some(part => part === '.' || part === '..' || part.endsWith('.lock'))) {
    throw new Error(`invalid skill source ref: ${decoded}`)
  }
  return decoded
}

function githubRepository(value: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`invalid skill source repository: ${String(value)}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid skill source repository: ${value}`)
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`skill sources must use an uncredentialed GitHub HTTPS URL: ${value}`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2 || segments.some(segment => !/^[a-z\d](?:[a-z\d._-]{0,98}[a-z\d])?$/i.test(segment.replace(/\.git$/i, '')))) {
    throw new Error(`skill source URL must name one GitHub repository: ${value}`)
  }
  const owner = segments[0]?.toLowerCase()
  const repository = segments[1]?.replace(/\.git$/i, '').toLowerCase()
  return `https://github.com/${owner}/${repository}`
}

function normalizeSource(source: SkillSourceDefinition): SkillSourceDefinition {
  if (!source || typeof source.id !== 'string') throw new Error('skill source must have an id')
  const id = safeId(source.id)
  if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100) throw new Error(`skill source ${id} must have a bounded name`)
  if (typeof source.description !== 'string' || !source.description.trim() || source.description.length > 1_024) throw new Error(`skill source ${id} must have a bounded description`)
  const ref = safeRef(source.ref)
  const skillName = source.skillName
  if (skillName !== undefined && (typeof skillName !== 'string' || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(skillName) || skillName.length > 64)) {
    throw new Error(`skill source ${id} has an invalid skillName`)
  }
  if (source.stars !== undefined && (!Number.isInteger(source.stars) || source.stars < 0)) throw new Error(`skill source ${id} has an invalid star count`)
  if (source.starsAsOf !== undefined && (typeof source.starsAsOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.starsAsOf))) {
    throw new Error(`skill source ${id} has an invalid starsAsOf date`)
  }
  if (source.catalogUrl !== undefined) {
    let catalogUrl: URL
    try { catalogUrl = new URL(source.catalogUrl) } catch { throw new Error(`skill source ${id} has an invalid catalogUrl`) }
    if (catalogUrl.protocol !== 'https:' || catalogUrl.username || catalogUrl.password) throw new Error(`skill source ${id} has an invalid catalogUrl`)
  }
  return {
    id,
    name: source.name.trim(),
    description: source.description.trim(),
    repository: githubRepository(source.repository),
    ...(ref ? { ref } : {}),
    skillsPath: safeRelativeDirectory(source.skillsPath).split(path.sep).join('/'),
    ...(skillName ? { skillName } : {}),
    ...(source.stars !== undefined ? { stars: source.stars } : {}),
    ...(source.starsAsOf ? { starsAsOf: source.starsAsOf } : {}),
    ...(source.catalogUrl ? { catalogUrl: source.catalogUrl } : {}),
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function isDirectory(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isDirectory()
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await stat(filename)).isFile()
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function readBounded(filename: string, maximum: number, label: string): Promise<string> {
  const information = await stat(filename)
  if (!information.isFile()) throw new Error(`${label} is not a file: ${filename}`)
  if (information.size > maximum) throw new Error(`${label} exceeds the ${maximum} byte limit: ${filename}`)
  const buffer = await readFile(filename)
  if (buffer.includes(0)) throw new Error(`${label} is not UTF-8 text: ${filename}`)
  return buffer.toString('utf8')
}

export async function readSkillFile(filename: string, maximum = 256_000, source = path.dirname(filename)): Promise<SkillRecord> {
  const content = await readBounded(filename, maximum, 'SKILL.md')
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  if (!frontmatter) throw new Error('SKILL.md must begin with YAML frontmatter')
  const document = parseDocument(frontmatter[1] ?? '')
  if (document.errors.length) throw new Error(`invalid YAML frontmatter: ${document.errors.map(error => error.message).join('; ')}`)
  const metadata: unknown = document.toJS({ maxAliasCount: 0 })
  if (!isRecord(metadata)) throw new Error('SKILL.md frontmatter must be an object')
  const name = metadata.name
  const description = metadata.description
  if (typeof name !== 'string' || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(name) || name.length > 64) {
    throw new Error('skill name must contain at most 64 lowercase letters, numbers, and single hyphens')
  }
  if (typeof description !== 'string' || !description.trim() || description.length > 1_024) {
    throw new Error('skill description must contain 1 through 1024 characters')
  }
  const resolved = await realpath(filename)
  return {
    name,
    description: description.trim(),
    location: resolved,
    directory: path.dirname(resolved),
    source,
  }
}

async function defaultRun(command: string, args: readonly string[], cwd: string | undefined, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`${command} exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.length < 64_000) stderr += String(chunk)
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    })
  })
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

export class SkillManager {
  readonly root: string
  private readonly projectRoot: string
  private readonly homeDirectory: string
  private readonly configuredPaths: string[]
  private readonly includeUserSkills: boolean
  private readonly includeClaudeSkills: boolean
  private readonly includeAwesomeCatalog: boolean
  private readonly gitBinary: string
  private readonly maxSkills: number
  private readonly maxSkillBytes: number
  private readonly maxResourceBytes: number
  private readonly installTimeoutMs: number
  private readonly catalogTimeoutMs: number
  private readonly run: SkillCommandRunner
  private readonly fetchCatalog: SkillCatalogFetch
  private readonly sources: Map<string, SkillSourceDefinition>
  private awesomeEntries: Promise<SkillSourceDefinition[]> | undefined
  private readonly starCache = new Map<string, Promise<{ stars: number; starsAsOf: string }>>()

  constructor(projectRoot: string, config: SkillsPluginConfig = {}, runtime: SkillManagerRuntime = {}) {
    this.projectRoot = path.resolve(projectRoot)
    this.homeDirectory = path.resolve(runtime.homeDirectory ?? homedir())
    if (config.directory !== undefined && (typeof config.directory !== 'string' || !config.directory.trim() || config.directory.includes('\0'))) {
      throw new TypeError('directory must be a non-empty path')
    }
    if (config.paths !== undefined && (!Array.isArray(config.paths)
      || config.paths.some(value => typeof value !== 'string' || !value.trim() || value.includes('\0')))) {
      throw new TypeError('paths must contain non-empty paths')
    }
    if (config.catalog !== undefined && !Array.isArray(config.catalog)) throw new TypeError('catalog must be an array')
    if (config.gitBinary !== undefined && (typeof config.gitBinary !== 'string' || !config.gitBinary || /[\u0000-\u001f\u007f]/.test(config.gitBinary))) {
      throw new TypeError('gitBinary must be a non-empty string without control characters')
    }
    this.root = path.isAbsolute(config.directory ?? '')
      ? path.resolve(config.directory as string)
      : path.resolve(this.projectRoot, config.directory ?? '.deep-tui/skills')
    this.configuredPaths = (config.paths ?? []).map(value => path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.projectRoot, value))
    this.includeUserSkills = config.includeUserSkills !== false
    this.includeClaudeSkills = config.includeClaudeSkills !== false
    this.includeAwesomeCatalog = config.includeAwesomeCatalog !== false
    this.gitBinary = config.gitBinary ?? 'git'
    this.maxSkills = boundedInteger(config.maxSkills, 500, 1, 5_000, 'maxSkills')
    this.maxSkillBytes = boundedInteger(config.maxSkillBytes, 256_000, 1_024, 5_000_000, 'maxSkillBytes')
    this.maxResourceBytes = boundedInteger(config.maxResourceBytes, 1_000_000, 1_024, 20_000_000, 'maxResourceBytes')
    this.installTimeoutMs = boundedInteger(config.installTimeoutMs, 120_000, 1_000, 900_000, 'installTimeoutMs')
    this.catalogTimeoutMs = boundedInteger(config.catalogTimeoutMs, 15_000, 1_000, 120_000, 'catalogTimeoutMs')
    this.run = runtime.run ?? ((command, args, cwd) => defaultRun(command, args, cwd, this.installTimeoutMs))
    this.fetchCatalog = runtime.fetch ?? ((input, init) => fetch(input, init))
    const catalog = config.includeCuratedCatalog === false ? [] : CURATED_SKILL_SOURCES
    this.sources = new Map([...catalog, ...(config.catalog ?? [])].map(entry => {
      const normalized = normalizeSource(entry)
      return [normalized.id, normalized]
    }))
  }

  catalog(): SkillSourceDefinition[] {
    return [...this.sources.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`catalog request exceeded ${this.catalogTimeoutMs}ms`)), this.catalogTimeoutMs)
    try {
      const response = await this.fetchCatalog(url, { ...init, signal: controller.signal })
      if (!response.ok) throw new Error(`catalog request failed with HTTP ${response.status}: ${url}`)
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  private awesomeCatalog(): Promise<SkillSourceDefinition[]> {
    if (!this.includeAwesomeCatalog) return Promise.resolve([])
    this.awesomeEntries ??= this.request(VOLTAGENT_CATALOG_URL, {
      headers: { Accept: 'text/plain', 'User-Agent': 'deep-tui-plugin-skills' },
    }).then(async response => {
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > 2_000_000) throw new Error('VoltAgent catalog exceeds the 2000000 byte limit')
      const markdown = await response.text()
      if (Buffer.byteLength(markdown) > 2_000_000) throw new Error('VoltAgent catalog exceeds the 2000000 byte limit')
      return parseAwesomeCatalog(markdown).map(normalizeSource)
    }).catch(error => {
      this.awesomeEntries = undefined
      throw error
    })
    return this.awesomeEntries
  }

  private async stars(source: SkillSourceDefinition): Promise<SkillSourceDefinition> {
    if (source.stars !== undefined) return source
    const repository = new URL(source.repository).pathname.split('/').filter(Boolean).join('/').toLowerCase()
    let pending = this.starCache.get(repository)
    if (!pending) {
      pending = (async () => {
        const token = process.env.GITHUB_TOKEN
        const response = await this.request(`https://api.github.com/repos/${repository}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'deep-tui-plugin-skills',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })
        const value: unknown = await response.json()
        if (!isRecord(value) || !Number.isInteger(value.stargazers_count) || (value.stargazers_count as number) < 0) {
          throw new Error(`GitHub returned no star count for ${repository}`)
        }
        return { stars: value.stargazers_count as number, starsAsOf: new Date().toISOString().slice(0, 10) }
      })()
      this.starCache.set(repository, pending)
    }
    try {
      return { ...source, ...await pending }
    } catch (error) {
      this.starCache.delete(repository)
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`could not retrieve GitHub stars for ${repository}: ${reason}`)
    }
  }

  async searchCatalog(query: string, limit = 20): Promise<SkillSourceDefinition[]> {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return this.catalog()
    if (normalizedQuery.length < 2 || normalizedQuery.length > 200) throw new Error('catalog search must contain 2 through 200 characters')
    const maximum = boundedInteger(limit, 20, 1, 50, 'catalog search limit')
    const tokens = normalizedQuery.split(/\s+/)
    const available = new Map((await this.awesomeCatalog()).map(source => [source.id, source]))
    for (const source of this.sources.values()) available.set(source.id, source)
    const candidates = [...available.values()]
      .filter(source => tokens.every(token => `${source.name}\n${source.description}`.toLowerCase().includes(token)))
      .map(source => ({
        source,
        score: source.name.toLowerCase() === normalizedQuery ? 0
          : source.name.toLowerCase().startsWith(normalizedQuery) ? 1
            : source.name.toLowerCase().includes(normalizedQuery) ? 2 : 3,
      }))
      .sort((left, right) => left.score - right.score || left.source.name.localeCompare(right.source.name))
      .slice(0, maximum)
      .map(item => item.source)
    const results = await Promise.all(candidates.map(source => this.stars(source)))
    for (const source of results) this.sources.set(source.id, source)
    return results
  }

  private async source(id: string): Promise<SkillSourceDefinition | undefined> {
    const normalized = safeId(id)
    const configured = this.sources.get(normalized)
    if (configured) return configured
    if (!normalized.startsWith('awesome-')) return undefined
    const source = (await this.awesomeCatalog()).find(entry => entry.id === normalized)
    if (source) this.sources.set(source.id, source)
    return source
  }

  private sourcesDirectory(): string {
    return path.join(this.root, 'sources')
  }

  private sourceDirectory(id: string): string {
    return path.join(this.sourcesDirectory(), safeId(id))
  }

  private async storedSource(directory: string): Promise<StoredSource> {
    const filename = path.join(directory, SOURCE_METADATA)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBounded(filename, 64_000, 'skill source metadata'))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`invalid skill source metadata: ${filename}`)
      throw error
    }
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.id !== 'string'
      || typeof parsed.name !== 'string' || typeof parsed.description !== 'string'
      || typeof parsed.repository !== 'string' || typeof parsed.skillsPath !== 'string'
      || (parsed.ref !== undefined && typeof parsed.ref !== 'string')
      || (parsed.skillName !== undefined && typeof parsed.skillName !== 'string')
      || (parsed.stars !== undefined && typeof parsed.stars !== 'number')
      || (parsed.starsAsOf !== undefined && typeof parsed.starsAsOf !== 'string')
      || (parsed.catalogUrl !== undefined && typeof parsed.catalogUrl !== 'string')) {
      throw new Error(`invalid skill source metadata: ${filename}`)
    }
    const normalized = normalizeSource({
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      repository: parsed.repository,
      ...(typeof parsed.ref === 'string' ? { ref: parsed.ref } : {}),
      skillsPath: parsed.skillsPath,
      ...(typeof parsed.skillName === 'string' ? { skillName: parsed.skillName } : {}),
      ...(typeof parsed.stars === 'number' ? { stars: parsed.stars } : {}),
      ...(typeof parsed.starsAsOf === 'string' ? { starsAsOf: parsed.starsAsOf } : {}),
      ...(typeof parsed.catalogUrl === 'string' ? { catalogUrl: parsed.catalogUrl } : {}),
    })
    return { version: 1, ...normalized, skillsPath: normalized.skillsPath ?? 'skills' }
  }

  async installedSources(): Promise<InstalledSkillSource[]> {
    let entries
    try {
      entries = await readdir(this.sourcesDirectory(), { withFileTypes: true })
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const installed: InstalledSkillSource[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      const directory = path.join(this.sourcesDirectory(), entry.name)
      try {
        installed.push({ ...await this.storedSource(directory), directory })
      } catch {
        // Discovery reports invalid skills; incomplete source directories are ignored here.
      }
    }
    return installed
  }

  private async scanRoot(root: string, source: string): Promise<SkillDiscovery> {
    const skills: SkillRecord[] = []
    const diagnostics: SkillDiagnostic[] = []
    const candidates: string[] = []
    try {
      if (await isFile(path.join(root, 'SKILL.md'))) candidates.push(root)
      else {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(path.join(root, entry.name))
        }
      }
    } catch (error) {
      if (missing(error)) return { skills, diagnostics }
      diagnostics.push({ location: root, message: error instanceof Error ? error.message : String(error) })
      return { skills, diagnostics }
    }
    for (const directory of candidates) {
      const filename = path.join(directory, 'SKILL.md')
      try {
        if (!await isFile(filename)) continue
        const skill = await readSkillFile(filename, this.maxSkillBytes, source)
        skills.push(skill)
        if (path.basename(directory) !== skill.name) {
          diagnostics.push({ location: skill.location, message: `skill name "${skill.name}" does not match directory "${path.basename(directory)}"` })
        }
      } catch (error) {
        diagnostics.push({ location: filename, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { skills, diagnostics }
  }

  private async findNamedSkill(root: string, name: string, source: string): Promise<SkillRecord | undefined> {
    const resolvedRoot = await realpath(root)
    const queue: Array<{ directory: string; depth: number }> = [{ directory: resolvedRoot, depth: 0 }]
    let visited = 0
    while (queue.length) {
      const current = queue.shift()
      if (!current || visited >= 10_000) break
      visited += 1
      const filename = path.join(current.directory, 'SKILL.md')
      if (await isFile(filename)) {
        try {
          const skill = await readSkillFile(filename, this.maxSkillBytes, source)
          if (contained(resolvedRoot, skill.directory) && skill.name === name) return skill
        } catch {
          // Continue looking for another valid skill with this name.
        }
      }
      if (current.depth >= 6) continue
      let entries
      try { entries = await readdir(current.directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory() || ['.git', 'node_modules', 'vendor'].includes(entry.name)) continue
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 })
      }
    }
    return undefined
  }

  async discover(): Promise<SkillDiscovery> {
    const installed = await this.installedSources()
    const roots: Array<{ directory: string; source: string }> = [
      ...this.configuredPaths.map(directory => ({ directory, source: directory })),
      { directory: path.join(this.projectRoot, '.agents', 'skills'), source: 'project .agents' },
      { directory: this.root, source: 'Deep TUI managed skills' },
      ...(this.includeClaudeSkills ? [{ directory: path.join(this.projectRoot, '.claude', 'skills'), source: 'project .claude' }] : []),
      ...installed.map(source => ({ directory: path.resolve(source.directory, source.skillsPath ?? 'skills'), source: source.name })),
      ...(this.includeUserSkills ? [{ directory: path.join(this.homeDirectory, '.agents', 'skills'), source: 'user .agents' }] : []),
      ...(this.includeUserSkills && this.includeClaudeSkills ? [{ directory: path.join(this.homeDirectory, '.claude', 'skills'), source: 'user .claude' }] : []),
    ]
    const selected = new Map<string, SkillRecord>()
    const diagnostics: SkillDiagnostic[] = []
    for (const root of roots) {
      const result = await this.scanRoot(root.directory, root.source)
      diagnostics.push(...result.diagnostics)
      for (const skill of result.skills) {
        const existing = selected.get(skill.name)
        if (existing) {
          if (existing.location !== skill.location) diagnostics.push({
            location: skill.location,
            message: `duplicate skill "${skill.name}" is shadowed by ${existing.location}`,
          })
          continue
        }
        if (selected.size >= this.maxSkills) {
          diagnostics.push({ location: root.directory, message: `skill discovery reached the ${this.maxSkills} skill limit` })
          break
        }
        selected.set(skill.name, skill)
      }
    }
    return { skills: [...selected.values()].sort((left, right) => left.name.localeCompare(right.name)), diagnostics }
  }

  async load(name: string): Promise<{ skill: SkillRecord; content: string }> {
    const skill = (await this.discover()).skills.find(candidate => candidate.name === name)
    if (!skill) throw new Error(`skill "${name}" is not installed`)
    return { skill, content: await readBounded(skill.location, this.maxSkillBytes, 'SKILL.md') }
  }

  async readResource(name: string, requestedPath: string): Promise<{ skill: SkillRecord; path: string; content: string }> {
    if (!requestedPath || requestedPath.length > 4_096 || requestedPath.includes('\0') || path.isAbsolute(requestedPath)) {
      throw new Error('skill resource path must be a bounded relative path')
    }
    const { skill } = await this.load(name)
    const root = await realpath(skill.directory)
    const candidate = path.resolve(root, requestedPath)
    if (!contained(root, candidate)) throw new Error('skill resource path escapes the skill directory')
    const resolved = await realpath(candidate)
    if (!contained(root, resolved)) throw new Error('skill resource resolves outside the skill directory')
    return {
      skill,
      path: path.relative(root, resolved).split(path.sep).join('/'),
      content: await readBounded(resolved, this.maxResourceBytes, 'skill resource'),
    }
  }

  private async deploy(source: SkillSourceDefinition, status: SkillSourceChange['status']): Promise<SkillSourceChange> {
    const normalized = normalizeSource(source)
    const sources = this.sourcesDirectory()
    const target = this.sourceDirectory(normalized.id)
    await mkdir(sources, { recursive: true })
    const staged = path.join(sources, `.${normalized.id}-${process.pid}-${randomUUID()}`)
    try {
      const cloneUrl = `${normalized.repository}.git`
      if (normalized.ref) {
        await this.run(this.gitBinary, ['clone', '--filter=blob:none', '--depth', '1', '--no-checkout', '--', cloneUrl, staged])
        await this.run(this.gitBinary, ['-C', staged, 'fetch', '--depth', '1', 'origin', normalized.ref])
        await this.run(this.gitBinary, ['-C', staged, 'checkout', '--detach', 'FETCH_HEAD'])
      } else {
        await this.run(this.gitBinary, ['clone', '--filter=blob:none', '--depth', '1', '--', cloneUrl, staged])
      }
      const resolvedRepository = await realpath(staged)
      let skillsPath = safeRelativeDirectory(normalized.skillsPath)
      let scanned: SkillDiscovery = { skills: [], diagnostics: [] }
      try {
        const skillRoot = await realpath(path.resolve(staged, skillsPath))
        if (!contained(resolvedRepository, skillRoot)) throw new Error(`skills path resolves outside the repository: ${skillsPath}`)
        scanned = await this.scanRoot(skillRoot, normalized.name)
        scanned.skills = scanned.skills.filter(skill => contained(resolvedRepository, skill.directory))
      } catch (error) {
        if (!missing(error) || !normalized.skillName) throw error
      }
      if (normalized.skillName) {
        const selected = scanned.skills.find(skill => skill.name === normalized.skillName)
          ?? await this.findNamedSkill(resolvedRepository, normalized.skillName, normalized.name)
        if (selected) {
          skillsPath = path.relative(resolvedRepository, selected.directory).split(path.sep).join('/') || '.'
          scanned = { skills: [selected], diagnostics: scanned.diagnostics }
        } else {
          scanned.skills = []
        }
      }
      if (!scanned.skills.length) {
        const details = scanned.diagnostics.map(diagnostic => diagnostic.message).join('; ')
        throw new Error(`skill source ${normalized.id} contains no valid skills${details ? `: ${details}` : ''}`)
      }
      const stored: StoredSource = { version: 1, ...normalized, skillsPath }
      await writeFile(path.join(staged, SOURCE_METADATA), `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await replaceDirectory(staged, target)
      const installedSkills = await this.scanRoot(path.resolve(target, skillsPath), normalized.name)
      return {
        source: { ...normalized, skillsPath, directory: target },
        skills: installedSkills.skills,
        status,
      }
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  }

  async install(id: string): Promise<SkillSourceChange> {
    const source = await this.source(id)
    if (!source) throw new Error(`unknown skill source "${id}"; use "skills catalog" to list sources`)
    if (await isDirectory(this.sourceDirectory(source.id))) throw new Error(`skill source "${source.id}" is already installed`)
    return this.deploy(source, 'installed')
  }

  async update(id: string): Promise<SkillSourceChange> {
    const directory = this.sourceDirectory(id)
    if (!await isDirectory(directory)) throw new Error(`skill source "${id}" is not installed`)
    const stored = await this.storedSource(directory)
    return this.deploy(await this.source(stored.id) ?? stored, 'updated')
  }

  async updateAll(): Promise<SkillSourceChange[]> {
    const installed = await this.installedSources()
    const changes: SkillSourceChange[] = []
    for (const source of installed) changes.push(await this.update(source.id))
    return changes
  }

  async remove(id: string): Promise<InstalledSkillSource> {
    const directory = this.sourceDirectory(id)
    if (!await isDirectory(directory)) throw new Error(`skill source "${id}" is not installed`)
    const source = { ...await this.storedSource(directory), directory }
    const discarded = `${directory}.removed-${process.pid}-${randomUUID()}`
    await rename(directory, discarded)
    await rm(discarded, { recursive: true, force: true })
    return source
  }
}
