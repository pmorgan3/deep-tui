import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SkillSourceDefinition } from './catalog.js'

const ENTRY = /^- \*\*\[([^\]]+)]\((https:\/\/[^)\s]+)\)\*\*(?: - |: )(.+)$/gm

const RED_HAT_PACKS: Readonly<Record<string, string>> = {
  'agentic-skill-pack-for-red-hat-customers': 'rh-basic',
  'agentic-skill-pack-for-site-reliability-engineers': 'rh-sre',
  'agentic-skill-pack-for-red-hat-openshift': 'ocp-admin',
  'agentic-skill-pack-for-red-hat-openshift-virtualization': 'rh-virt',
}

function standardSkillName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[a-z\d]+(?:-[a-z\d]+)*$/.test(normalized) && normalized.length <= 64
    ? normalized
    : undefined
}

function entryId(source: Omit<SkillSourceDefinition, 'id' | 'name' | 'description'>): string {
  const identity = [source.repository, source.ref, source.skillsPath, source.skillName].filter(Boolean).join('#')
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 10)
  const slug = (source.skillName ?? new URL(source.repository).pathname.split('/').filter(Boolean).at(-1) ?? 'skill')
    .toLowerCase().replace(/[^a-z\d-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'skill'
  return `awesome-${slug}-${digest}`
}

function githubSource(label: string, value: string): Omit<SkillSourceDefinition, 'id' | 'name' | 'description'> | undefined {
  const url = new URL(value)
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  if (url.hostname.toLowerCase() === 'catalog.redhat.com') {
    const pack = RED_HAT_PACKS[segments.at(-1) ?? '']
    if (!pack) return undefined
    return {
      repository: 'https://github.com/RHEcosystemAppEng/agentic-plugins',
      skillsPath: `${pack}/skills`,
      catalogUrl: value,
    }
  }
  if (url.hostname.toLowerCase() === 'www.notion.so'
    && segments.at(-1)?.startsWith('Notion-Skills-for-Claude-')) {
    return {
      repository: 'https://github.com/team-attention/notion-skills-for-claude',
      skillsPath: 'skills',
      catalogUrl: value,
    }
  }
  if (url.hostname.toLowerCase() === 'officialskills.sh') {
    if (segments.length !== 3) return undefined
    const [owner, repository, skill] = segments
    if (!owner || !repository || !skill) return undefined
    const skillName = standardSkillName(skill)
    return {
      repository: `https://github.com/${owner}/${repository}`,
      skillsPath: `skills/${skill}`,
      ...(skillName ? { skillName } : {}),
      catalogUrl: value,
    }
  }
  if (url.hostname.toLowerCase() !== 'github.com' || segments.length < 2) return undefined
  const owner = segments[0]
  const repository = segments[1]?.replace(/\.git$/i, '')
  if (!owner || !repository) return undefined
  let ref: string | undefined
  let skillsPath: string | undefined
  if ((segments[2] === 'tree' || segments[2] === 'blob') && segments[3]) {
    ref = segments[3]
    const linkedPath = segments.slice(4).join('/')
    skillsPath = segments[2] === 'blob' || path.posix.basename(linkedPath) === 'SKILL.md'
      ? path.posix.dirname(linkedPath)
      : linkedPath
    if (skillsPath === '.') skillsPath = undefined
  }
  const labelName = standardSkillName(label.split('/').at(-1))
  const pathName = standardSkillName(skillsPath ? path.posix.basename(skillsPath) : undefined)
  const skillName = labelName && labelName !== repository.toLowerCase() ? labelName : pathName
  return {
    repository: `https://github.com/${owner}/${repository}`,
    ...(ref ? { ref } : {}),
    ...(skillsPath ? { skillsPath } : {}),
    ...(skillName ? { skillName } : {}),
    catalogUrl: value,
  }
}

/** Parse installable entries from VoltAgent's awesome-agent-skills README. */
export function parseAwesomeCatalog(markdown: string): SkillSourceDefinition[] {
  const selected = new Map<string, SkillSourceDefinition>()
  for (const match of markdown.matchAll(ENTRY)) {
    const label = match[1]?.trim()
    const url = match[2]
    const description = match[3]?.trim()
    if (!label || !url || !description) continue
    let source
    try {
      source = githubSource(label, url)
    } catch {
      continue
    }
    if (!source) continue
    const id = entryId(source)
    if (selected.has(id)) continue
    selected.set(id, {
      id,
      name: label,
      description: description.length <= 1_024 ? description : `${description.slice(0, 1_021)}…`,
      ...source,
    })
  }
  return [...selected.values()]
}
