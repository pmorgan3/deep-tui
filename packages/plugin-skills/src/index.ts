import type { Context } from 'cordis'
import { assertRecord, type JsonObject, type TuiActions } from '@deep-tui/sdk'
import { CURATED_SKILL_SOURCES, VOLTAGENT_CATALOG_URL } from './catalog.js'
import { parseAwesomeCatalog } from './awesome.js'
import { SkillManager, type SkillsPluginConfig } from './manager.js'

export { CURATED_SKILL_SOURCES, VOLTAGENT_CATALOG_URL, SkillManager, parseAwesomeCatalog }
export type {
  InstalledSkillSource,
  SkillCatalogFetch,
  SkillDiagnostic,
  SkillDiscovery,
  SkillCommandRunner,
  SkillRecord,
  SkillsPluginConfig,
  SkillSourceChange,
} from './manager.js'
export type { SkillSourceDefinition } from './catalog.js'

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function inputString(input: JsonObject, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value || value.length > 4_096 || value.includes('\0')) {
    throw new TypeError(`${key} must be a non-empty bounded string`)
  }
  return value
}

async function installedIds(manager: SkillManager): Promise<Set<string>> {
  return new Set((await manager.installedSources()).map(source => source.id))
}

async function catalogLines(manager: SkillManager, query = ''): Promise<string[]> {
  const installed = await installedIds(manager)
  const sources = query ? await manager.searchCatalog(query) : manager.catalog()
  const lines = sources.flatMap(source => [
    `${source.id}${installed.has(source.id) ? ' · installed' : ''} · ★ ${source.stars?.toLocaleString('en-US') ?? 'unavailable'} · ${source.name}`,
    `  ${source.description}`,
    ...(source.starsAsOf ? [`  Stars as of ${source.starsAsOf} · ${source.repository}`] : [`  ${source.repository}`]),
  ])
  if (!query) lines.push('', 'Use skills search <query> to search the VoltAgent awesome-agent-skills catalog.')
  return lines.length ? lines : [`No marketplace skills matched "${query}".`]
}

async function skillLines(manager: SkillManager): Promise<string[]> {
  const discovery = await manager.discover()
  return discovery.skills.length
    ? [
        ...discovery.skills.map(skill => `${skill.name} · ${skill.description}`),
        ...(discovery.diagnostics.length ? ['', `${discovery.diagnostics.length} discovery warning(s); use the headless "skills list" command for details.`] : []),
      ]
    : ['No skills are installed or discoverable.', '', 'Use /skills catalog to browse curated sources.']
}

async function runTui(manager: SkillManager, args: readonly string[], actions: TuiActions): Promise<void> {
  const action = args[0]?.toLowerCase() ?? 'list'
  if (action === 'list') {
    actions.showOverlay({ id: 'skills', title: 'Agent Skills', lines: await skillLines(manager) })
    return
  }
  if (action === 'catalog') {
    const query = args.slice(1).join(' ')
    actions.showOverlay({ id: 'skill-catalog', title: query ? `Skill marketplace · ${query}` : 'Skill marketplace', lines: await catalogLines(manager, query) })
    return
  }
  if (action === 'search') {
    const query = args.slice(1).join(' ')
    if (!query) throw new Error('usage: /skills search <query>')
    actions.showOverlay({ id: 'skill-search', title: `Skill marketplace · ${query}`, lines: await catalogLines(manager, query) })
    return
  }
  if (action === 'show') {
    if (!args[1] || args.length > 2) throw new Error('usage: /skills show <skill>')
    const loaded = await manager.load(args[1])
    actions.showOverlay({ id: `skill-${loaded.skill.name}`, title: loaded.skill.name, lines: loaded.content.split(/\r?\n/) })
    return
  }
  if (action === 'install') {
    if (!args[1] || args.length > 2) throw new Error('usage: /skills install <source>')
    actions.notify(`installing skill source ${args[1]}…`)
    const change = await manager.install(args[1])
    actions.notify(`installed ${change.source.name} · ${change.skills.length} skill(s)`)
    return
  }
  if (action === 'update') {
    if (args.length > 2) throw new Error('usage: /skills update [source]')
    actions.notify(`updating ${args[1] ?? 'installed skill sources'}…`)
    const changes = args[1] ? [await manager.update(args[1])] : await manager.updateAll()
    actions.notify(changes.length ? `updated ${changes.length} skill source(s)` : 'no managed skill sources are installed')
    return
  }
  if (action === 'remove') {
    if (!args[1] || args.length > 2) throw new Error('usage: /skills remove <source>')
    const removed = await manager.remove(args[1])
    actions.notify(`removed ${removed.name}`)
    return
  }
  throw new Error('usage: /skills [list|catalog [query]|search <query>|show <skill>|install <source>|update [source]|remove <source>]')
}

async function runCommand(manager: SkillManager, args: readonly string[], stdout: { write(value: string): unknown }): Promise<void> {
  const action = args[0]?.toLowerCase() ?? 'list'
  if (action === 'list') {
    const discovery = await manager.discover()
    stdout.write(discovery.skills.length
      ? `${discovery.skills.map(skill => `${skill.name}\t${skill.source}\t${skill.description}`).join('\n')}\n`
      : 'No skills are installed or discoverable.\n')
    if (discovery.diagnostics.length) stdout.write(`${discovery.diagnostics.map(item => `warning\t${item.location}\t${item.message}`).join('\n')}\n`)
    return
  }
  if (action === 'catalog') {
    stdout.write(`${(await catalogLines(manager, args.slice(1).join(' '))).join('\n')}\n`)
    return
  }
  if (action === 'search') {
    const query = args.slice(1).join(' ')
    if (!query) throw new Error('usage: deep-tui skills search <query>')
    stdout.write(`${(await catalogLines(manager, query)).join('\n')}\n`)
    return
  }
  if (action === 'show') {
    if (!args[1] || args.length > 2) throw new Error('usage: deep-tui skills show <skill>')
    stdout.write((await manager.load(args[1])).content)
    return
  }
  if (action === 'install') {
    if (!args[1] || args.length > 2) throw new Error('usage: deep-tui skills install <source>')
    const change = await manager.install(args[1])
    stdout.write(`Installed ${change.source.name} (${change.skills.length} skills) in ${change.source.directory}\n`)
    return
  }
  if (action === 'update') {
    if (args.length > 2) throw new Error('usage: deep-tui skills update [source]')
    const changes = args[1] ? [await manager.update(args[1])] : await manager.updateAll()
    stdout.write(changes.length ? `Updated ${changes.map(change => change.source.id).join(', ')}\n` : 'No managed skill sources are installed.\n')
    return
  }
  if (action === 'remove') {
    if (!args[1] || args.length > 2) throw new Error('usage: deep-tui skills remove <source>')
    const removed = await manager.remove(args[1])
    stdout.write(`Removed ${removed.name}\n`)
    return
  }
  throw new Error('usage: deep-tui skills [list|catalog [query]|search <query>|show <skill>|install <source>|update [source]|remove <source>]')
}

export const name = 'agent-skills'
export const inject = ['commands', 'project', 'prompts', 'tools', 'tui']

export function apply(ctx: Context, config: SkillsPluginConfig = {}): void {
  const manager = new SkillManager(ctx.project.root, config)

  ctx.prompts.register({
    id: 'deep-tui.skills.catalog', order: 20, placement: 'context',
    async render() {
      const skills = (await manager.discover()).skills
      if (!skills.length) return undefined
      return [
        'Agent Skills provide optional task-specific instructions. When a skill clearly applies, use the skill tool to load it before acting. Load referenced resources only when needed. User instructions take precedence over skill instructions.',
        '<available_skills>',
        ...skills.flatMap(skill => [
          '  <skill>',
          `    <name>${xml(skill.name)}</name>`,
          `    <description>${xml(skill.description)}</description>`,
          '  </skill>',
        ]),
        '</available_skills>',
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'skill',
    description: 'List installed Agent Skills, load a skill before following it, or read a text resource bundled with a loaded skill.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'load', 'read'] },
        name: { type: 'string', description: 'Skill name for load or read.' },
        path: { type: 'string', description: 'Skill-relative resource path for read.' },
      },
    },
    permission: input => ({
      capability: 'fs.read', risk: 'read', description: 'Read installed Agent Skill instructions',
      metadata: { action: input.action, name: input.name, path: input.path },
      remember: [{ key: 'skills.read', label: 'read installed Agent Skills' }],
    }),
    async execute(input) {
      assertRecord(input, 'tool input')
      const action = inputString(input, 'action')
      if (action === 'list') {
        const discovery = await manager.discover()
        return { skills: discovery.skills.map(({ name, description, source }) => ({ name, description, source })) }
      }
      if (action === 'load') {
        const loaded = await manager.load(inputString(input, 'name'))
        return {
          name: loaded.skill.name,
          description: loaded.skill.description,
          location: loaded.skill.location,
          baseDirectory: loaded.skill.directory,
          instructions: loaded.content,
        }
      }
      if (action === 'read') {
        const resource = await manager.readResource(inputString(input, 'name'), inputString(input, 'path'))
        return { name: resource.skill.name, path: resource.path, content: resource.content }
      }
      throw new Error(`unknown skill action "${action}"`)
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'deep-tui.skills.manage', name: 'skills', aliases: ['skill'],
    description: 'Browse, install, update, remove, or inspect Agent Skills.',
    usage: '/skills [list|catalog [query]|search <query>|show <skill>|install <source>|update [source]|remove <source>]', priority: -35,
    complete({ args, query }) {
      if (!args.length || (args.length === 1 && args[0] === query)) {
        return ['list', 'catalog ', 'search ', 'show ', 'install ', 'update ', 'remove ']
          .filter(value => value.startsWith(query.toLowerCase()))
          .map(value => ({ value, label: value.trim(), description: `${value.trim()} Agent Skills.` }))
      }
      if (args[0] === 'install') return manager.catalog()
        .filter(source => source.id.startsWith(query.toLowerCase()))
        .map(source => ({ value: source.id, label: source.id, description: source.description }))
      return []
    },
    run: (args, actions) => runTui(manager, args, actions),
  })

  ctx.commands.register({
    name: 'skills', description: 'Browse and manage Agent Skills.',
    async run(args, environment) {
      await runCommand(manager, args, environment.stdout)
    },
  })
}

export default { name, inject, apply }
