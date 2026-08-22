import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CommandService, ProjectService, PromptService, ToolService, TuiService } from '@deep-tui/sdk'
import skillsPlugin, {
  CURATED_SKILL_SOURCES,
  SkillManager,
  parseAwesomeCatalog,
  type SkillCatalogFetch,
  type SkillCommandRunner,
} from '../src/index.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), label))
  temporaryDirectories.push(directory)
  return directory
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<string> {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${body}\n`)
  return directory
}

describe('Agent Skills', () => {
  it('publishes detailed, dated catalog metadata for Superpowers and Impeccable', () => {
    expect(CURATED_SKILL_SOURCES.map(source => source.id)).toEqual(['superpowers', 'impeccable'])
    for (const source of CURATED_SKILL_SOURCES) {
      expect(source.description.length).toBeGreaterThan(150)
      expect(source.stars).toBeGreaterThan(1_000)
      expect(source.starsAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(CURATED_SKILL_SOURCES.find(source => source.id === 'impeccable')).toMatchObject({
      repository: 'https://github.com/pbakaus/impeccable',
      skillsPath: 'plugin/skills',
      skillName: 'impeccable',
    })
  })

  it('parses stable, installable sources from the VoltAgent marketplace', () => {
    const markdown = [
      '- **[frontend-design](https://officialskills.sh/anthropics/skills/frontend-design)** - Creates distinctive production-grade frontend interfaces with careful typography, layout, color, motion, accessibility, and responsive behavior.',
      '- **[security-review](https://github.com/example/security-skills/tree/main/skills/security-review)** - Reviews application boundaries, authentication, authorization, input handling, dependency risk, secret storage, and deployment configuration.',
      '- **[infrasity-labs/dev-gtm-claude-skills](https://github.com/infrasity-labs/dev-gtm-claude-skills)**: Plans developer-focused positioning, launches, outbound sequences, and go-to-market workflows.',
      '- **[redhat/openshift-virtualization](https://catalog.redhat.com/en/ai/skills/detail/agentic-skill-pack-for-red-hat-openshift-virtualization)** - Manages the full virtual-machine lifecycle on OpenShift Virtualization.',
      '- **[notiondevs/Notion Skills for Claude](https://www.notion.so/notiondevs/Notion-Skills-for-Claude-28da4445d27180c7af1df7d8615723d0)** - Provides workflow skills for meetings, research, knowledge capture, and specification implementation in Notion.',
    ].join('\n')
    const parsed = parseAwesomeCatalog(markdown)

    expect(parsed).toHaveLength(5)
    expect(parsed[0]).toMatchObject({
      name: 'frontend-design',
      repository: 'https://github.com/anthropics/skills',
      skillsPath: 'skills/frontend-design',
      skillName: 'frontend-design',
    })
    expect(parsed[1]).toMatchObject({
      name: 'security-review',
      repository: 'https://github.com/example/security-skills',
      ref: 'main',
      skillsPath: 'skills/security-review',
      skillName: 'security-review',
    })
    expect(parsed[2]).toMatchObject({
      repository: 'https://github.com/infrasity-labs/dev-gtm-claude-skills',
    })
    expect(parsed[3]).toMatchObject({
      repository: 'https://github.com/RHEcosystemAppEng/agentic-plugins',
      skillsPath: 'rh-virt/skills',
    })
    expect(parsed[4]).toMatchObject({
      repository: 'https://github.com/team-attention/notion-skills-for-claude',
      skillsPath: 'skills',
    })
    expect(parseAwesomeCatalog(markdown).map(source => source.id)).toEqual(parsed.map(source => source.id))
  })

  it('searches the VoltAgent marketplace and attaches live GitHub stars', async () => {
    const root = await temporaryDirectory('deep-tui-skill-search-')
    const markdown = '- **[kubernetes-audit](https://officialskills.sh/acme/agent-skills/kubernetes-audit)** - Audits Kubernetes workloads, pod security, network policies, resource constraints, supply-chain controls, and production readiness.\n'
    const requested: string[] = []
    const fetchCatalog: SkillCatalogFetch = async input => {
      requested.push(input)
      if (input.includes('raw.githubusercontent.com')) return new Response(markdown)
      if (input === 'https://api.github.com/repos/acme/agent-skills') {
        return Response.json({ stargazers_count: 4_321 })
      }
      return new Response('not found', { status: 404 })
    }
    const manager = new SkillManager(root, { includeCuratedCatalog: false }, { fetch: fetchCatalog })

    const results = await manager.searchCatalog('kubernetes audit')
    expect(results).toMatchObject([{
      name: 'kubernetes-audit',
      stars: 4_321,
      repository: 'https://github.com/acme/agent-skills',
      skillName: 'kubernetes-audit',
    }])
    expect(results[0]?.description.length).toBeGreaterThan(100)
    expect(results[0]?.starsAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(requested).toEqual(expect.arrayContaining([
      expect.stringContaining('VoltAgent/awesome-agent-skills'),
      'https://api.github.com/repos/acme/agent-skills',
    ]))
    expect(await manager.searchCatalog('kubernetes audit')).toHaveLength(1)
    expect(requested.filter(value => value === 'https://api.github.com/repos/acme/agent-skills')).toHaveLength(1)
  })

  it('installs a selected VoltAgent skill even when its catalog path is stale', async () => {
    const root = await temporaryDirectory('deep-tui-awesome-install-')
    const markdown = '- **[kubernetes-audit](https://officialskills.sh/acme/agent-skills/kubernetes-audit)** - Audits Kubernetes workloads, pod security, network policies, resource constraints, supply-chain controls, and production readiness.\n'
    const [source] = parseAwesomeCatalog(markdown)
    if (!source) throw new Error('fixture did not parse')
    const run: SkillCommandRunner = async (_command, args) => {
      if (args[0] !== 'clone') return
      const destination = args.at(-1)
      if (!destination) throw new Error('clone destination missing')
      await writeSkill(path.join(destination, 'plugin', 'skills'), 'kubernetes-audit', 'Audit Kubernetes deployments.', 'Audit this cluster.')
    }
    const fetchCatalog: SkillCatalogFetch = async input => input.includes('raw.githubusercontent.com')
      ? new Response(markdown)
      : new Response('not found', { status: 404 })
    const manager = new SkillManager(root, {
      includeCuratedCatalog: false,
      includeUserSkills: false,
      includeClaudeSkills: false,
    }, { homeDirectory: path.join(root, 'home'), run, fetch: fetchCatalog })

    const installed = await manager.install(source.id)
    expect(installed.skills).toMatchObject([{ name: 'kubernetes-audit' }])
    expect(installed.source.skillsPath).toBe('plugin/skills/kubernetes-audit')
  })

  it('discloses metadata progressively and safely loads instructions and resources', async () => {
    const root = await temporaryDirectory('deep-tui-skills-')
    const directory = await writeSkill(path.join(root, '.agents', 'skills'), 'review-code', 'Review code before release.', 'SECRET REVIEW INSTRUCTIONS')
    await writeFile(path.join(directory, 'checklist.md'), 'Check tests and migrations.\n')
    const outside = path.join(root, 'outside.md')
    await writeFile(outside, 'outside\n')
    await symlink(outside, path.join(directory, 'outside.md'))

    const ctx = new Context()
    const project = await ctx.plugin(ProjectService, { root })
    const services = await Promise.all([
      ctx.plugin(CommandService), ctx.plugin(PromptService), ctx.plugin(ToolService), ctx.plugin(TuiService),
    ])
    const plugin = await ctx.plugin(skillsPlugin, { includeUserSkills: false, includeClaudeSkills: false })
    try {
      const prompt = await ctx.prompts.render({ cwd: root, model: 'test' })
      expect(prompt).toContain('<name>review-code</name>')
      expect(prompt).toContain('Review code before release.')
      expect(prompt).not.toContain('SECRET REVIEW INSTRUCTIONS')

      const tool = ctx.tools.get('skill')
      expect(tool).toBeDefined()
      const listed = await tool?.execute({ action: 'list' }, { cwd: root }) as { skills: Array<{ name: string }> }
      expect(listed.skills).toMatchObject([{ name: 'review-code' }])
      const loaded = await tool?.execute({ action: 'load', name: 'review-code' }, { cwd: root }) as { instructions: string }
      expect(loaded.instructions).toContain('SECRET REVIEW INSTRUCTIONS')
      const resource = await tool?.execute({ action: 'read', name: 'review-code', path: 'checklist.md' }, { cwd: root }) as { content: string }
      expect(resource.content).toBe('Check tests and migrations.\n')
      await expect(tool?.execute({ action: 'read', name: 'review-code', path: '../outside.md' }, { cwd: root })).rejects.toThrow(/escapes/)
      await expect(tool?.execute({ action: 'read', name: 'review-code', path: 'outside.md' }, { cwd: root })).rejects.toThrow(/outside/)
      expect(ctx.commands.get('skills')).toBeDefined()
      expect(ctx.tui.slashCommand('skills')).toBeDefined()
    } finally {
      await plugin.dispose()
      await Promise.all(services.map(service => service.dispose()))
      await project.dispose()
    }
  })

  it('uses project skills before user skills and reports malformed and duplicate entries', async () => {
    const root = await temporaryDirectory('deep-tui-skill-precedence-')
    const home = await temporaryDirectory('deep-tui-skill-home-')
    await writeSkill(path.join(root, '.agents', 'skills'), 'shared-skill', 'Project version.', 'project')
    await writeSkill(path.join(home, '.agents', 'skills'), 'shared-skill', 'User version.', 'user')
    const invalid = path.join(root, '.agents', 'skills', 'invalid')
    await mkdir(invalid, { recursive: true })
    await writeFile(path.join(invalid, 'SKILL.md'), 'missing frontmatter')

    const manager = new SkillManager(root, { includeClaudeSkills: false }, { homeDirectory: home })
    const discovered = await manager.discover()
    expect(discovered.skills).toMatchObject([{ name: 'shared-skill', description: 'Project version.' }])
    expect(discovered.diagnostics.map(item => item.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/must begin with YAML/),
      expect.stringMatching(/duplicate skill/),
    ]))
  })

  it('installs, updates, and removes a configured GitHub skill pack atomically', async () => {
    const root = await temporaryDirectory('deep-tui-skill-source-')
    let revision = 0
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const run: SkillCommandRunner = async (command, args) => {
      commands.push({ command, args })
      if (args[0] !== 'clone') return
      revision += 1
      const destination = args.at(-1)
      if (!destination) throw new Error('clone destination missing')
      await writeSkill(path.join(destination, 'agent-skills'), 'pack-skill', 'Installed from a pack.', `revision ${revision}`)
    }
    const manager = new SkillManager(root, {
      includeCuratedCatalog: false,
      includeUserSkills: false,
      includeClaudeSkills: false,
      catalog: [{
        id: 'team-pack', name: 'Team Pack', description: 'Reviewed team skills.',
        repository: 'https://github.com/example/team-skills', skillsPath: 'agent-skills',
      }],
    }, { homeDirectory: path.join(root, 'home'), run })

    const installed = await manager.install('team-pack')
    expect(installed.status).toBe('installed')
    expect(installed.skills).toMatchObject([{ name: 'pack-skill' }])
    expect(commands[0]?.args).toContain('https://github.com/example/team-skills.git')
    expect((await manager.load('pack-skill')).content).toContain('revision 1')
    await expect(manager.install('team-pack')).rejects.toThrow(/already installed/)

    const updated = await manager.update('team-pack')
    expect(updated.status).toBe('updated')
    expect((await manager.load('pack-skill')).content).toContain('revision 2')
    const removed = await manager.remove('team-pack')
    expect(removed.id).toBe('team-pack')
    expect(await manager.installedSources()).toEqual([])
    expect((await manager.discover()).skills).toEqual([])
  })

  it('rejects credentialed repositories, unsafe refs, and invalid skill names', async () => {
    const root = await temporaryDirectory('deep-tui-skill-validation-')
    expect(() => new SkillManager(root, {
      catalog: [{ id: 'private', name: 'Private', description: 'No credentials.', repository: 'https://token@github.com/example/private' }],
    })).toThrow(/uncredentialed/)
    expect(() => new SkillManager(root, {
      catalog: [{ id: 'unsafe', name: 'Unsafe', description: 'No traversal.', repository: 'https://github.com/example/skills', ref: '../main' }],
    })).toThrow(/invalid skill source ref/)
    const directory = path.join(root, '.agents', 'skills', 'bad')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'SKILL.md'), '---\nname: Bad_Name\ndescription: Invalid name.\n---\nbody\n')
    const manager = new SkillManager(root, { includeUserSkills: false, includeClaudeSkills: false })
    const discovered = await manager.discover()
    expect(discovered.skills).toEqual([])
    expect(discovered.diagnostics[0]?.message).toMatch(/lowercase letters/)
  })
})
