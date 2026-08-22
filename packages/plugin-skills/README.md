# @deep-tui/plugin-skills

Discovers portable [Agent Skills](https://agentskills.io), discloses their
names and descriptions to the model, and loads full instructions only when a
task needs them. The plugin also provides a small curated source catalog and
project-local GitHub installation management.

The standard Deep TUI composition includes this plugin, but it does not install
skills by default. Its reviewed catalog starts with Superpowers and Impeccable,
and its searchable marketplace exposes installable entries from
[VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills):

```sh
deep-tui skills catalog
deep-tui skills search accessibility
deep-tui skills install superpowers
deep-tui skills install impeccable
deep-tui skills list
```

Every built-in and search result includes a detailed description, its GitHub
repository star count, and the date that count was retrieved. Built-in counts
are reviewed snapshots; marketplace search refreshes counts through GitHub's
REST API. Set `GITHUB_TOKEN` to raise GitHub's API rate limit. If a live star
count cannot be retrieved, the remote search fails instead of presenting an
undated or misleading number.

The same operations are available inside the TUI through `/skills`. Managed
sources are cloned without running dependency or lifecycle scripts and live in
`.deep-tui/skills/sources/`. Treat installed skills as trusted instructions:
they can tell an agent to run bundled scripts or use other tools, whose normal
Deep TUI permissions still apply.

## Discovery

In precedence order, the plugin scans configured `paths`, project
`.agents/skills`, `.deep-tui/skills`, project `.claude/skills`, managed source
packs, user `~/.agents/skills`, and user `~/.claude/skills`. This makes existing
cross-client skills available without reinstalling them. Duplicate names keep
the first match and are reported as discovery warnings.

The model receives only each valid `SKILL.md` name and description. Its
read-only `skill` tool supports `list`, `load`, and bounded skill-relative
resource reads. This follows the Agent Skills progressive-disclosure model.

## Configuration

Add private or team-curated GitHub repositories without replacing the built-in
catalog:

```json
{
  "use": "@deep-tui/plugin-skills",
  "config": {
    "catalog": [
      {
        "id": "team-skills",
        "name": "Team Skills",
        "description": "Our reviewed engineering workflows.",
        "repository": "https://github.com/example/team-skills",
        "ref": "v1.0.0",
        "skillsPath": "skills"
      }
    ],
    "paths": ["./shared/skills"]
  }
}
```

Catalog sources currently use uncredentialed GitHub HTTPS repositories. A
source may contain one skill at `skillsPath/SKILL.md` or a collection at
`skillsPath/*/SKILL.md`; `skillName` selects one skill from a collection. Custom
entries can include `stars` and `starsAsOf` metadata. Set
`includeCuratedCatalog`, `includeAwesomeCatalog`, `includeUserSkills`, or
`includeClaudeSkills` to `false` to disable those discovery surfaces. Use
`catalogTimeoutMs` to bound marketplace and GitHub API requests.
