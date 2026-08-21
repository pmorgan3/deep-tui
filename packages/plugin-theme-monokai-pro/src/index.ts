import type { Context } from 'cordis'
import type { Theme } from '@deep-tui/sdk'

export const monokaiProTheme: Theme = {
  id: 'monokai-pro',
  label: 'Monokai Pro',
  tokens: {
    fontFamily: 'Fira Code, ui-monospace, monospace',
    fontSize: 14,
    colors: {
      background: '#2d2a2e', foreground: '#fcfcfa', muted: '#727072', accent: '#ffd866',
      success: '#a9dc76', warning: '#fc9867', danger: '#ff6188',
    },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
    syntax: {
      comment: '#727072', keyword: '#ff6188', string: '#a9dc76', number: '#ab9df2',
      function: '#78dce8', type: '#78dce8', variable: '#fcfcfa', operator: '#ff6188',
      punctuation: '#939293', constant: '#ab9df2', property: '#ffd866',
    },
  },
}

export const name = 'monokai-pro-theme'
export const inject = ['themes']
export function apply(ctx: Context): void { ctx.themes.register(monokaiProTheme) }
export default { name, inject, apply }
