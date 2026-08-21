import type { Context } from 'cordis'
import type { Theme } from '@flect/sdk'

const common = {
  fontFamily: 'Fira Code, Fantasque Sans Mono, ui-monospace, monospace',
  fontSize: 14,
  spacing: { compact: 4, normal: 8, relaxed: 16 },
  syntax: {
    comment: '#928374', keyword: '#fb4934', string: '#b8bb26', number: '#d3869b',
    function: '#fabd2f', type: '#8ec07c', operator: '#fe8019', constant: '#d3869b',
  },
}

export const gruvboxThemes: Theme[] = [
  {
    id: 'gruvbox-dark-medium',
    label: 'Gruvbox Dark Medium',
    tokens: {
      ...common,
      colors: {
        background: '#282828', foreground: '#ebdbb2', muted: '#928374', accent: '#83a598',
        success: '#b8bb26', warning: '#fabd2f', danger: '#fb4934', inlineCode: '#d65d0e',
      },
    },
  },
  {
    id: 'gruvbox-dark-hard',
    label: 'Gruvbox Dark Hard',
    tokens: {
      ...common,
      colors: {
        background: '#1d2021', foreground: '#fbf1c7', muted: '#928374', accent: '#83a598',
        success: '#b8bb26', warning: '#fabd2f', danger: '#fb4934', inlineCode: '#d65d0e',
      },
    },
  },
  {
    id: 'gruvbox-light-medium',
    label: 'Gruvbox Light Medium',
    tokens: {
      ...common,
      syntax: { ...common.syntax, comment: '#7c6f64', keyword: '#9d0006', string: '#79740e', number: '#8f3f71', function: '#b57614', type: '#427b58', operator: '#af3a03' },
      colors: {
        background: '#fbf1c7', foreground: '#3c3836', muted: '#7c6f64', accent: '#076678',
        success: '#79740e', warning: '#b57614', danger: '#9d0006',
      },
    },
  },
  {
    id: 'gruvbox-light-hard',
    label: 'Gruvbox Light Hard',
    tokens: {
      ...common,
      syntax: { ...common.syntax, comment: '#7c6f64', keyword: '#9d0006', string: '#79740e', number: '#8f3f71', function: '#b57614', type: '#427b58', operator: '#af3a03' },
      colors: {
        background: '#f9f5d7', foreground: '#282828', muted: '#7c6f64', accent: '#076678',
        success: '#79740e', warning: '#b57614', danger: '#9d0006',
      },
    },
  },
]

export const name = 'gruvbox-themes'
export const inject = ['themes']

export function apply(ctx: Context): void {
  for (const theme of gruvboxThemes) ctx.themes.register(theme)
}

export default { name, inject, apply }
