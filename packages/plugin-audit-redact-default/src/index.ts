import type { Context } from 'cordis'
import type { AuditEvent, JsonObject } from '@flect/sdk'
import { createHash } from 'node:crypto'

export interface AuditRedactionConfig {
  maxStringLength?: number
  maxDepth?: number
  maxArrayLength?: number
  maxEventBytes?: number
  secretKeys?: string[]
}

function clean(value: unknown, secrets: RegExp, config: Required<Pick<AuditRedactionConfig, 'maxStringLength' | 'maxDepth' | 'maxArrayLength'>>, seen: WeakSet<object>, depth = 0): unknown {
  if (depth > config.maxDepth) return '[truncated depth]'
  if (typeof value === 'string') return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').slice(0, config.maxStringLength)
  if (Array.isArray(value)) return value.slice(0, config.maxArrayLength).map(item => clean(item, secrets, config, seen, depth + 1))
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const output: JsonObject = {}
    for (const [key, item] of Object.entries(value).slice(0, config.maxArrayLength)) {
      output[key] = secrets.test(key) ? '[redacted]' : clean(item, secrets, config, seen, depth + 1)
    }
    seen.delete(value)
    return output
  }
  return value
}

export const name = 'default-audit-redaction'
export const inject = ['audit']
export function apply(ctx: Context, config: AuditRedactionConfig = {}): void {
  const keys = config.secretKeys ?? ['authorization', 'token', 'secret', 'password', 'cookie', 'apiKey', 'stdin', 'content']
  const secrets = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
  const limits = {
    maxStringLength: config.maxStringLength ?? 2_000,
    maxDepth: config.maxDepth ?? 8,
    maxArrayLength: config.maxArrayLength ?? 100,
  }
  ctx.audit.registerRedactor({
    id: 'flect.audit.redact', priority: 100,
    redact(event) {
      const projectId = createHash('sha256').update(event.projectRoot).digest('hex').slice(0, 16)
      const cleaned = clean({ ...event, projectRoot: '.', projectId }, secrets, limits, new WeakSet()) as AuditEvent
      if (Buffer.byteLength(JSON.stringify(cleaned)) <= (config.maxEventBytes ?? 64_000)) return cleaned
      return { ...cleaned, data: { truncated: true } }
    },
  })
}
export default { name, inject, apply }
