import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from 'cordis'
import { formatUnknownError, type TuiActions } from '@flect/sdk'

export interface ModelPersistenceConfig {
  /** Restore and save the selected model for this project. */
  persist?: boolean
  /** Absolute path or a path relative to the canonical project root. */
  stateFile?: string
}

export const name = 'model-persistence'
export const inject = ['project', 'tui']

const defaultStateFile = '.flect/model.json'

function modelStatePath(ctx: Context, config: ModelPersistenceConfig): string {
  const filename = config.stateFile ?? defaultStateFile
  return path.isAbsolute(filename) ? filename : path.resolve(ctx.project.root, filename)
}

async function saveModel(ctx: Context, model: string, config: ModelPersistenceConfig): Promise<void> {
  if (config.persist === false) return
  const filename = modelStatePath(ctx, config)
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ model }, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function restoreModel(ctx: Context, actions: TuiActions, config: ModelPersistenceConfig): Promise<void> {
  if (config.persist === false) return
  try {
    const saved: unknown = JSON.parse(await readFile(modelStatePath(ctx, config), 'utf8'))
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved) || !('model' in saved)
      || typeof saved.model !== 'string') {
      throw new TypeError('model state must contain a string "model" field')
    }
    if (!actions.state.models.includes(saved.model)) {
      actions.notify(`saved model "${saved.model}" is not currently configured`)
      return
    }
    if (actions.state.model !== saved.model) actions.setModel(saved.model)
  } catch (error) {
    if (!isMissingFile(error)) actions.notify(`could not restore model: ${formatUnknownError(error)}`)
  }
}

function showModelPicker(actions: TuiActions): void {
  actions.showOverlay({
    id: 'flect.model.picker',
    title: 'Models',
    lines: [
      ...actions.state.models.map(model => `${model === actions.state.model ? '›' : ' '} ${model}`),
      '',
      'Use /model <name> or Ctrl+P to switch. Your choice is saved for future sessions.',
    ],
  })
}

function showUnknownModel(actions: TuiActions, requested: string): void {
  actions.showOverlay({
    id: 'model-not-found',
    title: 'Unknown model',
    tone: 'danger',
    lines: [
      `"${requested}" is not configured.`,
      `Available: ${actions.state.models.join(', ')}`,
    ],
  })
}

async function switchAndPersist(
  ctx: Context,
  actions: TuiActions,
  model: string,
  config: ModelPersistenceConfig,
): Promise<void> {
  actions.setModel(model)
  try {
    await saveModel(ctx, model, config)
  } catch (error) {
    actions.notify(`model switched to ${model}, but could not persist: ${formatUnknownError(error)}`)
  }
}

export function apply(ctx: Context, config: ModelPersistenceConfig = {}): void {
  ctx.tui.registerSessionHook({
    id: 'flect.model.persistence',
    priority: 50,
    start: actions => restoreModel(ctx, actions, config),
  })

  ctx.tui.registerKeybinding({
    id: 'flect.model.persistence.cycle',
    keys: ['ctrl+p'],
    description: 'Switch to the next configured model and remember the choice.',
    priority: 50,
    async handle(_event, actions) {
      actions.cycleModel()
      try {
        await saveModel(ctx, actions.state.model, config)
      } catch (error) {
        actions.notify(`model switched to ${actions.state.model}, but could not persist: ${formatUnknownError(error)}`)
      }
      return true
    },
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.model.persistence.command',
    name: 'model',
    aliases: ['models'],
    description: 'Show or switch the active model and remember it for future sessions.',
    usage: '/model [name]',
    priority: 50,
    complete({ query, state }) {
      const normalized = query.toLowerCase()
      return state.models
        .filter(model => model.toLowerCase().startsWith(normalized))
        .map(model => ({
          value: model,
          label: model,
          description: model === state.model ? 'current model' : 'switch and remember model',
        }))
    },
    async run(args, actions) {
      const requested = args[0]
      if (!requested) {
        showModelPicker(actions)
        return
      }
      if (!actions.state.models.includes(requested)) {
        showUnknownModel(actions, requested)
        return
      }
      await switchAndPersist(ctx, actions, requested, config)
    },
  })
}

export default { name, inject, apply }
