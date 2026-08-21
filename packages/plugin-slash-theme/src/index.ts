import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context, Plugin } from 'cordis'
import { formatUnknownError, type Theme, type TuiActions } from '@flect/sdk'
import catppuccin from '@flect/plugin-theme-catppuccin'
import gruvbox from '@flect/plugin-theme-gruvbox'
import kanagawa from '@flect/plugin-theme-kanagawa'
import monokaiPro from '@flect/plugin-theme-monokai-pro'
import nord from '@flect/plugin-theme-nord'

export interface ThemeSlashConfig {
  /** Mount the first-party palette plugins as children of this plugin. */
  loadBuiltins?: boolean
  /** Restore and save the selected theme for this project. */
  persist?: boolean
  /** Absolute path or a path relative to the canonical project root. */
  stateFile?: string
}

interface ThemePicker {
  originalId: string
  highlightedId: string
}

const pickerOverlayId = 'flect.theme.picker'
const defaultStateFile = '.flect/theme.json'

export const bundledThemePlugins: Plugin[] = [gruvbox, catppuccin, kanagawa, nord, monokaiPro]

export const name = 'theme-slash-command'
export const inject = ['project', 'themes', 'tui']

function themeStatePath(ctx: Context, config: ThemeSlashConfig): string {
  const filename = config.stateFile ?? defaultStateFile
  return path.isAbsolute(filename) ? filename : path.resolve(ctx.project.root, filename)
}

async function saveTheme(ctx: Context, themeId: string, config: ThemeSlashConfig): Promise<void> {
  if (config.persist === false) return
  const filename = themeStatePath(ctx, config)
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ theme: themeId }, null, 2)}\n`, 'utf8')
  await rename(temporary, filename)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function restoreTheme(ctx: Context, actions: TuiActions, config: ThemeSlashConfig): Promise<void> {
  if (config.persist === false) return
  try {
    const saved: unknown = JSON.parse(await readFile(themeStatePath(ctx, config), 'utf8'))
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved) || !('theme' in saved)
      || typeof saved.theme !== 'string') {
      throw new TypeError('theme state must contain a string "theme" field')
    }
    const theme = ctx.themes.get(saved.theme)
    if (!theme) {
      actions.notify(`saved theme "${saved.theme}" is not currently registered`)
      return
    }
    ctx.themes.select(theme.id)
  } catch (error) {
    if (!isMissingFile(error)) actions.notify(`could not restore theme: ${formatUnknownError(error)}`)
  }
}

function sortedThemes(ctx: Context): Theme[] {
  return ctx.themes.list().sort((left, right) => left.label.localeCompare(right.label))
}

function showPicker(ctx: Context, actions: TuiActions, picker: ThemePicker, error?: string): void {
  const themes = sortedThemes(ctx)
  if (!themes.some(theme => theme.id === picker.highlightedId)) {
    picker.highlightedId = ctx.themes.current()?.id ?? themes[0]?.id ?? picker.highlightedId
  }
  actions.showOverlay({
    id: pickerOverlayId,
    title: 'Choose a theme',
    ...(error ? { tone: 'danger' as const } : {}),
    lines: [
      ...themes.map(theme => `${theme.id === picker.highlightedId ? '›' : ' '} ${theme.id} · ${theme.label}`),
      '',
      error ?? 'Up/Down previews · Enter accepts · Escape cancels',
    ],
  })
}

export function apply(ctx: Context, config: ThemeSlashConfig = {}): void {
  if (config.loadBuiltins !== false) {
    for (const plugin of bundledThemePlugins) ctx.plugin(plugin)
  }

  const pickers = new WeakMap<TuiActions, ThemePicker>()

  ctx.tui.registerSessionHook({
    id: 'flect.theme.persistence',
    priority: 50,
    start: actions => restoreTheme(ctx, actions, config),
    stop(actions) {
      const picker = pickers.get(actions)
      if (!picker) return
      if (ctx.themes.get(picker.originalId)) ctx.themes.select(picker.originalId)
      pickers.delete(actions)
    },
  })

  const pickerBinding = (
    id: string,
    keys: string[],
    description: string,
    handle: (actions: TuiActions, picker: ThemePicker) => boolean | Promise<boolean>,
  ) => ctx.tui.registerKeybinding({
    id,
    keys,
    description,
    priority: 50,
    handle: (_event, actions) => {
      if (actions.state.overlay?.id !== pickerOverlayId) return false
      const picker = pickers.get(actions)
      if (!picker) return false
      return handle(actions, picker)
    },
  })

  const movePicker = (actions: TuiActions, picker: ThemePicker, offset: number): boolean => {
    const themes = sortedThemes(ctx)
    if (!themes.length) return true
    const current = Math.max(0, themes.findIndex(theme => theme.id === picker.highlightedId))
    const next = themes[(current + offset + themes.length) % themes.length]
    if (!next) return true
    picker.highlightedId = next.id
    ctx.themes.select(next.id)
    showPicker(ctx, actions, picker)
    return true
  }

  pickerBinding('flect.theme.picker.previous', ['up'], 'Preview the previous theme.',
    (actions, picker) => movePicker(actions, picker, -1))
  pickerBinding('flect.theme.picker.next', ['down'], 'Preview the next theme.',
    (actions, picker) => movePicker(actions, picker, 1))
  pickerBinding('flect.theme.picker.cancel', ['escape'], 'Cancel the theme preview.', (actions, picker) => {
    if (ctx.themes.get(picker.originalId)) ctx.themes.select(picker.originalId)
    pickers.delete(actions)
    actions.closeOverlay()
    actions.notify('theme change cancelled')
    return true
  })
  pickerBinding('flect.theme.picker.accept', ['enter'], 'Accept the previewed theme.', async (actions, picker) => {
    const selected = ctx.themes.get(picker.highlightedId)
    if (!selected) {
      showPicker(ctx, actions, picker, 'The highlighted theme is no longer registered.')
      return true
    }
    try {
      await saveTheme(ctx, selected.id, config)
    } catch (error) {
      showPicker(ctx, actions, picker, `Could not save theme: ${formatUnknownError(error)}`)
      return true
    }
    pickers.delete(actions)
    actions.closeOverlay()
    actions.notify(`theme switched to ${selected.label}`)
    return true
  })

  ctx.tui.registerSlashCommand({
    id: 'flect.theme.select',
    name: 'theme',
    aliases: ['themes'],
    description: 'List or switch themes contributed by plugins.',
    usage: '/theme [id]',
    priority: -50,
    complete({ query }) {
      const normalized = query.toLowerCase()
      return ctx.themes.list()
        .filter(theme => theme.id.toLowerCase().startsWith(normalized)
          || theme.label.toLowerCase().includes(normalized))
        .sort((left, right) => left.label.localeCompare(right.label))
        .map(theme => ({
          value: theme.id,
          label: theme.id,
          description: theme.label,
        }))
    },
    async run(args, actions) {
      const requested = args[0]
      if (!requested) {
        const currentId = ctx.themes.current()?.id
        if (!currentId) {
          actions.notify('no themes are registered')
          return
        }
        const existing = pickers.get(actions)
        const picker = existing ?? { originalId: currentId, highlightedId: currentId }
        pickers.set(actions, picker)
        showPicker(ctx, actions, picker)
        return
      }

      const selected = ctx.themes.get(requested)
      if (!selected) {
        actions.showOverlay({
          id: 'theme-not-found',
          title: 'Unknown theme',
          tone: 'danger',
          lines: [`"${requested}" is not registered.`, 'Type /theme to list active theme plugins.'],
        })
        return
      }
      await saveTheme(ctx, selected.id, config)
      ctx.themes.select(selected.id)
      actions.notify(`theme switched to ${selected.label}`)
    },
  })
}

export default { name, inject, apply }
