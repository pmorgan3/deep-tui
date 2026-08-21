import type { Context } from 'cordis'
import type { Theme } from '@flect/sdk'

export const nordTheme: Theme = {
  id: 'nord',
  label: 'Nord',
  tokens: {
    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
    fontSize: 14,
    colors: {
      background: '#2e3440', foreground: '#eceff4', muted: '#81a1c1', accent: '#88c0d0',
      success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a',
    },
    spacing: { compact: 4, normal: 8, relaxed: 16 },
    syntax: {
      comment: '#616e88', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead',
      function: '#88c0d0', type: '#8fbcbb', variable: '#eceff4', operator: '#81a1c1',
      punctuation: '#d8dee9', constant: '#d08770', property: '#8fbcbb',
    },
  },
}

export const name = 'nord-theme'
export const inject = ['themes']
export function apply(ctx: Context): void { ctx.themes.register(nordTheme) }
export default { name, inject, apply }
