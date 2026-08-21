import { createHash } from 'node:crypto'
import type {
  ConversationRecord,
  JsonObject,
  ModelEnvelope,
  ModelTool,
  ToolCall,
} from './types.js'

export type Awaitable<T> = T | Promise<T>

export type Disposer = () => void | Promise<void>

function canonicalJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical JSON cannot contain a cycle')
    seen.add(value)
    const output = value.map(item => {
      const resolved = canonicalJson(item, seen)
      return resolved === undefined ? null : resolved
    })
    seen.delete(value)
    return output
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('canonical JSON cannot contain a cycle')
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const resolved = canonicalJson((value as Record<string, unknown>)[key], seen)
      if (resolved !== undefined) output[key] = resolved
    }
    seen.delete(value)
    return output
  }
  return undefined
}

/** Return a detached JSON object with recursively sorted keys. */
export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  return canonicalJson(value, new Set()) as JsonObject
}

/** Deterministic JSON used for model-history passback and cache fingerprints. */
export function stableJsonStringify(value: unknown): string {
  const encoded = JSON.stringify(canonicalJson(value, new Set()))
  if (encoded === undefined) throw new TypeError('value cannot be represented as canonical JSON')
  return encoded
}

export function createModelEnvelope(
  provider: string,
  model: string,
  system: string,
  tools: readonly ModelTool[],
): ModelEnvelope {
  const canonicalTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: canonicalizeJsonObject(tool.inputSchema),
  }))
  const payload = { provider, model, ...(system ? { system } : {}), tools: canonicalTools }
  return {
    ...payload,
    fingerprint: createHash('sha256').update(stableJsonStringify(payload)).digest('hex'),
  }
}

export type ConversationSurfaceRecord = Extract<ConversationRecord,
  { type: 'user' | 'context' | 'assistant' | 'tool' | 'tool-prune' | 'checkpoint' }>

/** Fold append-only replacement records into the exact message surface shown to the model. */
export function conversationSurface(records: readonly ConversationRecord[]): ConversationSurfaceRecord[] {
  const surface: ConversationSurfaceRecord[] = []
  for (const record of records) {
    if (record.type === 'user' || record.type === 'context' || record.type === 'assistant' || record.type === 'tool') {
      surface.push(record)
      continue
    }
    if (record.type === 'tool-prune') {
      const index = surface.findIndex(candidate => candidate.seq === record.sourceSeq)
      if (index >= 0) surface.splice(index, 1, record)
      continue
    }
    if (record.type === 'checkpoint') {
      const sources = new Set(record.sourceSeqs)
      const indexes = surface.flatMap((candidate, index) => sources.has(candidate.seq) ? [index] : [])
      if (!indexes.length) continue
      const insertAt = Math.min(...indexes)
      const retained = surface.filter(candidate => !sources.has(candidate.seq))
      retained.splice(insertAt, 0, record)
      surface.splice(0, surface.length, ...retained)
    }
  }
  return surface
}

export function formatRuntimeContext(source: string, text: string): string {
  return `<runtime-context source=${JSON.stringify(source)}>\n${text}\n</runtime-context>`
}

export function formatCheckpoint(summary: string): string {
  return [
    'This is an automatically generated checkpoint condensing an earlier span of the conversation. Treat it as established context and continue directly.',
    '',
    '<compacted-summary>',
    summary,
    '</compacted-summary>',
  ].join('\n')
}

/** Human-friendly tool-call label for transcripts. Unknown tools fall back to their name. */
export function describeToolCall(call: ToolCall): string {
  if (call.name === 'read_file') {
    const path = call.arguments.path
    return typeof path === 'string' && path ? `Reading ${path}` : 'Reading file'
  }
  return call.name
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

export function fallbackConversationTitle(prompt: string, maxLength = 60): string {
  const normalized = prompt.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'New conversation'
  return [...normalized].slice(0, Math.max(1, maxLength)).join('').trimEnd()
}
