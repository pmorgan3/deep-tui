import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLayeredConfig, redactConfiguration, selectConfig } from '../src/config.js'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function json(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value)}\n`, 'utf8')
}

describe('layered configuration', () => {
  it('uses global configuration without changing the working project root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-global-config-'))
    temporaryDirectories.push(directory)
    const user = path.join(directory, 'user.json')
    await json(user, { version: 2, plugins: [] })

    expect(await selectConfig(directory, undefined, user)).toEqual({ filename: user, userOnly: true })

    const project = path.join(directory, 'deep-tui.config.json')
    await json(project, { version: 2, plugins: [] })
    expect(await selectConfig(directory, undefined, user)).toEqual({ filename: project })
  })

  it('merges user, extends, project, and explicit layers with provenance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-config-'))
    temporaryDirectories.push(directory)
    const user = path.join(directory, 'user.json')
    const shared = path.join(directory, 'shared.json')
    const project = path.join(directory, 'deep-tui.config.json')
    const explicit = path.join(directory, 'explicit.json')
    await json(user, { version: 2, plugins: [{ id: 'agent', use: 'agent-a', config: { nested: { a: 1 }, list: [1], apiKey: 'secret' } }] })
    await json(shared, { version: 2, plugins: [{ id: 'tools', use: 'tools-a', config: { read: true } }] })
    await json(project, { version: 2, extends: ['./shared.json'], plugins: [{ id: 'agent', use: 'agent-a', config: { nested: { b: 2 }, list: [2] } }] })
    await json(explicit, { version: 2, plugins: [{ id: 'agent', use: 'agent-b', enabled: false, config: null }] })

    const result = await readLayeredConfig(project, { userFile: user, explicitFile: explicit })
    expect(result.sources).toEqual([user, shared, project, explicit])
    expect(result.plugins).toMatchObject([
      { id: 'agent', use: 'agent-b', enabled: false },
      { id: 'tools', use: 'tools-a', config: { read: true } },
    ])
    expect(result.plugins[0]).not.toHaveProperty('config')
    expect(result.provenance.agent).toMatchObject({ use: explicit, enabled: explicit, config: explicit, fields: { config: explicit } })
    expect(redactConfiguration({ config: { apiKey: 'secret', model: 'x' } })).toEqual({ config: { apiKey: '[redacted]', model: 'x' } })
  })

  it('detects an extends cycle with the source chain', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'deep-tui-cycle-'))
    temporaryDirectories.push(directory)
    const first = path.join(directory, 'first.json')
    const second = path.join(directory, 'second.json')
    await json(first, { version: 2, extends: ['./second.json'], plugins: [] })
    await json(second, { version: 2, extends: ['./first.json'], plugins: [] })
    await expect(readLayeredConfig(first, { userFile: path.join(directory, 'missing') })).rejects.toThrow(/cycle.*first\.json.*second\.json.*first\.json/)
  })
})
