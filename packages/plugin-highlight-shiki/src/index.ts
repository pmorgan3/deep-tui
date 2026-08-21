import type { Context } from 'cordis'
import { createHighlighter, type BundledLanguage, type ThemeRegistration } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { Theme } from '@deep-tui/sdk'

export interface ShikiHighlighterConfig {
  languages?: BundledLanguage[]
  /** Maximum highlighted documents retained across renders. Default 512. */
  maxCacheEntries?: number
}

const defaultLanguages: BundledLanguage[] = [
  'bash', 'c', 'cpp', 'css', 'diff', 'dockerfile', 'go', 'html', 'java',
  'javascript', 'json', 'jsx', 'markdown', 'python', 'rust', 'sql',
  'typescript', 'tsx', 'yaml',
]

function syntaxTheme(theme: Theme): ThemeRegistration {
  const colors = theme.tokens.colors
  const syntax = theme.tokens.syntax ?? {}
  const color = (name: keyof NonNullable<Theme['tokens']['syntax']>, fallback: string) => syntax[name] ?? fallback
  return {
    name: `deep-tui-${theme.id}`,
    type: 'dark',
    colors: { 'editor.foreground': colors.foreground, 'editor.background': colors.background },
    settings: [
      { settings: { foreground: colors.foreground, background: colors.background } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: color('comment', colors.muted), fontStyle: 'italic' } },
      { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: color('keyword', colors.accent), fontStyle: 'bold' } },
      { scope: ['string', 'string.quoted'], settings: { foreground: color('string', colors.success) } },
      { scope: ['constant.numeric'], settings: { foreground: color('number', colors.warning) } },
      { scope: ['entity.name.function', 'support.function'], settings: { foreground: color('function', colors.accent) } },
      { scope: ['entity.name.type', 'support.type'], settings: { foreground: color('type', colors.warning) } },
      { scope: ['variable', 'meta.definition.variable'], settings: { foreground: color('variable', colors.foreground) } },
      { scope: ['keyword.operator'], settings: { foreground: color('operator', colors.accent) } },
      { scope: ['constant.language'], settings: { foreground: color('constant', colors.warning) } },
      { scope: ['variable.other.property'], settings: { foreground: color('property', colors.foreground) } },
    ],
  }
}

export const name = 'shiki-highlighter'
export const inject = ['themes', 'tui']

export async function apply(ctx: Context, config: ShikiHighlighterConfig = {}): Promise<void> {
  const themes = ctx.themes.list()
  const highlighter = await createHighlighter({
    themes: themes.map(syntaxTheme),
    langs: config.languages ?? defaultLanguages,
    engine: createJavaScriptRegexEngine(),
  })
  const cache = new Map<string, readonly { spans: readonly {
    text: string
    style: { foreground?: string; italic?: boolean; bold?: boolean; underline?: boolean }
  }[] }[]>()
  const cacheLimit = Math.max(1, Math.floor(config.maxCacheEntries ?? 512))
  ctx.effect(() => () => highlighter.dispose(), 'shiki highlighter')
  ctx.tui.registerCodeHighlighter({
    id: 'deep-tui.shiki',
    priority: 50,
    highlight(code, language, render) {
      const lang = (language || 'text').toLowerCase() as BundledLanguage | 'text'
      if (lang !== 'text' && !highlighter.getLoadedLanguages().includes(lang)) return undefined
      const theme = `deep-tui-${render.theme.id}`
      if (!highlighter.getLoadedThemes().includes(theme)) return undefined
      const key = `${theme}\u0000${lang}\u0000${code}`
      const cached = cache.get(key)
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        return cached
      }
      try {
        const result = highlighter.codeToTokens(code, { lang, theme })
        const lines = result.tokens.map(line => ({
          spans: line.map(token => ({
            text: token.content,
            style: {
              ...(token.color ? { foreground: token.color } : {}),
              ...((token.fontStyle ?? 0) & 1 ? { italic: true } : {}),
              ...((token.fontStyle ?? 0) & 2 ? { bold: true } : {}),
              ...((token.fontStyle ?? 0) & 4 ? { underline: true } : {}),
            },
          })),
        }))
        cache.set(key, lines)
        while (cache.size > cacheLimit) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        return lines
      } catch {
        return undefined
      }
    },
  })
}

export default { name, inject, apply }
