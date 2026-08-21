import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AuditService, type AuditEvent } from '@flect/sdk'
import redaction from '../../plugin-audit-redact-default/src/index.js'
import { JsonlAuditSink, readAuditEvents } from '../src/index.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

function event(id: string, data: Record<string, unknown> = {}): AuditEvent {
  return { id, type: 'tool.finish', timestamp: '2026-08-17T12:00:00.000Z', projectRoot: '/secret/project', runId: 'run', toolCallId: 'tool', data }
}

describe('redacted JSONL audit history', () => {
  it('removes secrets and controls before restrictive persistent storage', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flect-audit-'))
    directories.push(directory)
    const ctx = new Context()
    const service = await ctx.plugin(AuditService, { failureMode: 'fail-closed' })
    const redact = await ctx.plugin(redaction, { maxStringLength: 30 })
    ctx.audit.registerSink(new JsonlAuditSink(directory))
    await ctx.audit.record(event('one', {
      authorization: 'Bearer seeded-secret', nested: { apiKey: 'seeded-api-key', content: 'private file content' },
      safe: `visible\u001b[31m${'x'.repeat(100)}`,
    }))
    await ctx.audit.flush()
    const filename = path.join(directory, '2026-08-17.jsonl')
    const bytes = await readFile(filename, 'utf8')
    expect(bytes).not.toContain('seeded-secret')
    expect(bytes).not.toContain('seeded-api-key')
    expect(bytes).not.toContain('private file content')
    expect(bytes).not.toContain('\u001b')
    const stored = await readAuditEvents(directory)
    expect(stored[0]).toMatchObject({ version: 1, projectRoot: '.', projectId: expect.any(String), data: { authorization: '[redacted]' } })
    await redact.dispose(); await service.dispose()
  })

  it('rotates, tolerates only a partial tail, and detects hash-chain edits', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flect-audit-chain-'))
    directories.push(directory)
    const sink = new JsonlAuditSink(directory, { maxFileBytes: 1 })
    await sink.record(event('one'))
    await sink.record(event('two'))
    await sink.flush()
    const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort()
    expect(files).toHaveLength(2)
    await appendFile(path.join(directory, files[1] as string), '{"partial"', 'utf8')
    expect(await readAuditEvents(directory)).toHaveLength(2)

    const first = path.join(directory, files[0] as string)
    const line = (await readFile(first, 'utf8')).trim()
    const stored = JSON.parse(line) as { event: AuditEvent }
    stored.event.data = { changed: true }
    await writeFile(first, `${JSON.stringify(stored)}\n`, 'utf8')
    await expect(readAuditEvents(directory)).rejects.toThrow('hash chain verification failed')
  })
})
