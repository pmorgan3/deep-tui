import type { Context } from 'cordis'
import type { ThemeTokens } from '@deep-tui/sdk'

export interface DefaultThemeConfig {
  id?: string
  label?: string
  tokens?: Partial<ThemeTokens> & {
    colors?: Partial<ThemeTokens['colors']>
    spacing?: Partial<ThemeTokens['spacing']>
    syntax?: ThemeTokens['syntax']
  }
}

const defaults: ThemeTokens = {
  fontFamily: 'Berkeley Mono, JetBrains Mono, ui-monospace, monospace',
  fontSize: 14,
  colors: {
    background: '#10131a',
    foreground: '#e8edf5',
    muted: '#8792a2',
    accent: '#7aa2f7',
    success: '#9ece6a',
    warning: '#e0af68',
    danger: '#f7768e',
  },
  spacing: { compact: 4, normal: 8, relaxed: 16 },
  syntax: {
    comment: '#8792a2', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64',
    function: '#7aa2f7', type: '#2ac3de', variable: '#e8edf5', operator: '#89ddff',
    punctuation: '#a9b1d6', constant: '#ff9e64', property: '#73daca',
  },
}

export const name = 'default-theme'
export const inject = ['themes']

export function apply(ctx: Context, config: DefaultThemeConfig = {}): void {
  ctx.themes.register({
    id: config.id ?? 'default',
    label: config.label ?? 'Midnight',
    tokens: {
      ...defaults,
      ...config.tokens,
      colors: { ...defaults.colors, ...config.tokens?.colors },
      spacing: { ...defaults.spacing, ...config.tokens?.spacing },
      syntax: { ...defaults.syntax, ...config.tokens?.syntax },
    },
  })
}

export default { name, inject, apply }
