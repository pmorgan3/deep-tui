import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import type { PermissionRule } from '@deep-tui/sdk'
import { formatUnknownError } from '@deep-tui/sdk'

export interface PermissionRulesConfig {
  persist?: boolean
  stateFile?: string
  maxRules?: number
  /** Automatically allow built-in workspace reads. Defaults to true. */
  allowRead?: boolean
}

function filename(ctx: Context, config: PermissionRulesConfig): string {
  const configured = config.stateFile
  if (!configured) return ctx.project.statePath('permissions.json')
  return path.isAbsolute(configured) ? configured : path.resolve(ctx.project.root, configured)
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function load(ctx: Context, config: PermissionRulesConfig): Promise<void> {
  if (config.persist === false) return
  try {
    const parsed = JSON.parse(await readFile(filename(ctx, config), 'utf8')) as { version?: unknown; rules?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) throw new Error('permission state must use schema version 1')
    if (parsed.rules.length > (config.maxRules ?? 1_000)) throw new Error(`permission state exceeds the ${config.maxRules ?? 1_000} rule limit`)
    for (const candidate of parsed.rules) {
      if (typeof candidate !== 'object' || candidate === null) throw new Error('permission state contains an invalid rule')
      const rule = candidate as Partial<PermissionRule>
      if (!rule.id || !rule.key || !rule.label || rule.decision !== 'allow' || !rule.createdAt) throw new Error('permission state contains an invalid rule')
      ctx.permissionRules.add({
        id: rule.id, key: rule.key, label: rule.label, scope: 'project',
        projectRoot: ctx.project.root, createdAt: rule.createdAt,
      })
    }
  } catch (error) {
    if (!missing(error)) throw new Error(`could not load permission rules: ${formatUnknownError(error)}`)
  }
}

async function save(ctx: Context, config: PermissionRulesConfig, rules: readonly PermissionRule[]): Promise<void> {
  if (config.persist === false) return
  if (rules.length > (config.maxRules ?? 1_000)) throw new Error(`permission state exceeds the ${config.maxRules ?? 1_000} rule limit`)
  const target = filename(ctx, config)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  const stored = rules.map(({ id, key, label, decision, createdAt }) => ({ id, key, label, decision, createdAt }))
  await writeFile(temporary, `${JSON.stringify({ version: 1, rules: stored }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

export const name = 'permission-rules'
export const inject = ['commands', 'permissionRules', 'permissions', 'project', 'tui']

export async function apply(ctx: Context, config: PermissionRulesConfig = {}): Promise<void> {
  await load(ctx, config)
  ctx.permissionRules.registerWriter(rules => save(ctx, config, rules))
  ctx.permissions.register({
    id: 'deep-tui.permission.rules',
    priority: 1_000,
    decide(request, context) {
      if (config.allowRead !== false && request.risk === 'read' && request.capability === 'fs.read') {
        return 'allow'
      }
      const rule = ctx.permissionRules.match((request.remember ?? []).map(candidate => candidate.key), context)
      return rule ? { decision: 'allow', ruleId: rule.id } : 'abstain'
    },
  })
  ctx.tui.registerSlashCommand({
    id: 'deep-tui.permissions.manage', name: 'permissions', aliases: ['perms'],
    description: 'List or revoke remembered permission rules.', usage: '/permissions [revoke <id>]', priority: -40,
    complete({ args, query }) {
      if (args[0] !== 'revoke') return [{ value: 'revoke ', label: 'revoke', description: 'Remove a remembered rule.' }]
      return ctx.permissionRules.list().filter(rule => rule.id.startsWith(query)).map(rule => ({ value: rule.id, label: rule.id, description: rule.label }))
    },
    async run(args, actions) {
      if (args[0] === 'revoke' && args[1]) {
        const existing = ctx.permissionRules.list().find(rule => rule.id === args[1])
        if (!existing || !ctx.permissionRules.remove(args[1])) throw new Error(`permission rule "${args[1]}" was not found`)
        try { await ctx.permissionRules.persist() } catch (error) {
          ctx.permissionRules.add(existing)
          throw error
        }
        actions.notify(`revoked permission rule ${args[1]}`)
        return
      }
      const rules = ctx.permissionRules.list()
      actions.showOverlay({
        id: 'permission-rules', title: 'Remembered permissions',
        lines: rules.length ? [
          ...rules.map(rule => `${rule.id} · ${rule.scope} · ${rule.label}`), '',
          'Use /permissions revoke <id> to remove a rule.',
        ] : ['No remembered permissions.'],
      })
    },
  })
  ctx.commands.register({
    name: 'permissions', description: 'List remembered permission rules.',
    async run(args, environment) {
      if (args[0] === 'revoke') {
        const id = args[1]
        const existing = id ? ctx.permissionRules.list().find(rule => rule.id === id) : undefined
        if (!id || !existing || !ctx.permissionRules.remove(id)) throw new Error('permissions revoke requires a valid rule id')
        try { await ctx.permissionRules.persist() } catch (error) { ctx.permissionRules.add(existing); throw error }
        environment.stdout.write(`Revoked ${id}\n`)
        return
      }
      const rules = ctx.permissionRules.list()
      environment.stdout.write(rules.length ? `${rules.map(rule => `${rule.id}\t${rule.scope}\t${rule.label}`).join('\n')}\n` : 'No remembered permissions.\n')
    },
  })
}

export default { name, inject, apply }
