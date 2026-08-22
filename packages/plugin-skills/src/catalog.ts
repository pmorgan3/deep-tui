export interface SkillSourceDefinition {
  /** Stable marketplace identifier used by install, update, and remove commands. */
  id: string
  name: string
  description: string
  /** Uncredentialed HTTPS URL for a GitHub repository. */
  repository: string
  /** Branch, tag, or commit-ish. The default branch is used when omitted. */
  ref?: string
  /** Directory containing skill folders, relative to the repository root. */
  skillsPath?: string
  /** Install only this named skill when the repository contains a collection. */
  skillName?: string
  /** GitHub repository stars, captured on starsAsOf. */
  stars?: number
  /** ISO date on which stars was retrieved. */
  starsAsOf?: string
  /** Catalog page that supplied this entry. */
  catalogUrl?: string
}

export const VOLTAGENT_CATALOG_URL = 'https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md'

/** Sources reviewed for compatibility with Deep TUI's Agent Skills implementation. */
export const CURATED_SKILL_SOURCES: readonly SkillSourceDefinition[] = [
  {
    id: 'superpowers',
    name: 'Superpowers',
    description: 'A complete software-development methodology for coding agents. Its composable skills cover structured brainstorming, implementation planning, test-driven development, systematic debugging, verification, code review, Git worktrees, and parallel or subagent-driven execution.',
    repository: 'https://github.com/obra/superpowers',
    skillsPath: 'skills',
    stars: 276_110,
    starsAsOf: '2026-08-22',
    catalogUrl: 'https://github.com/obra/superpowers',
  },
  {
    id: 'impeccable',
    name: 'Impeccable',
    description: 'A frontend-design language and workflow for coding agents. It adds design-context setup, UI shaping and critique, accessibility and responsive audits, typography and layout guidance, production polish, and deterministic checks that target common AI-generated interface anti-patterns.',
    repository: 'https://github.com/pbakaus/impeccable',
    skillsPath: 'plugin/skills',
    skillName: 'impeccable',
    stars: 61_594,
    starsAsOf: '2026-08-22',
    catalogUrl: 'https://impeccable.style/',
  },
]
