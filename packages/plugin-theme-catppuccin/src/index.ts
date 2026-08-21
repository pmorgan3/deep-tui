import type { Context } from 'cordis'
import type { Theme } from '@deep-tui/sdk'

const common = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 14,
  spacing: { compact: 4, normal: 8, relaxed: 16 },
  syntax: {
    comment: '#7f849c', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387',
    function: '#89b4fa', type: '#94e2d5', operator: '#89dceb', constant: '#fab387',
  },
}

export const catppuccinThemes: Theme[] = [
  {
    id: 'catppuccin-latte', label: 'Catppuccin Latte',
    tokens: { ...common, syntax: {
      ...common.syntax, comment: '#8c8fa1', keyword: '#8839ef', string: '#40a02b', number: '#fe640b',
      function: '#1e66f5', type: '#179299', operator: '#04a5e5', constant: '#fe640b',
    }, colors: {
      background: '#eff1f5', foreground: '#4c4f69', muted: '#8c8fa1', accent: '#1e66f5',
      success: '#40a02b', warning: '#df8e1d', danger: '#d20f39',
    } },
  },
  {
    id: 'catppuccin-frappe', label: 'Catppuccin Frappé',
    tokens: { ...common, colors: {
      background: '#303446', foreground: '#c6d0f5', muted: '#838ba7', accent: '#8caaee',
      success: '#a6d189', warning: '#e5c890', danger: '#e78284',
    } },
  },
  {
    id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato',
    tokens: { ...common, colors: {
      background: '#24273a', foreground: '#cad3f5', muted: '#8087a2', accent: '#8aadf4',
      success: '#a6da95', warning: '#eed49f', danger: '#ed8796',
    } },
  },
  {
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha',
    tokens: { ...common, colors: {
      background: '#1e1e2e', foreground: '#cdd6f4', muted: '#7f849c', accent: '#89b4fa',
      success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8',
    } },
  },
]

export const name = 'catppuccin-themes'
export const inject = ['themes']

export function apply(ctx: Context): void {
  for (const theme of catppuccinThemes) ctx.themes.register(theme)
}

export default { name, inject, apply }
