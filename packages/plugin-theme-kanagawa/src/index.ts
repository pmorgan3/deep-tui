import type { Context } from 'cordis'
import type { Theme } from '@deep-tui/sdk'

const common = {
  fontFamily: 'Berkeley Mono, JetBrains Mono, ui-monospace, monospace',
  fontSize: 14,
  spacing: { compact: 4, normal: 8, relaxed: 16 },
  syntax: {
    comment: '#727169', keyword: '#957fb8', string: '#98bb6c', number: '#d27e99',
    function: '#7e9cd8', type: '#7fb4ca', operator: '#c0a36e', constant: '#ffa066',
  },
}

export const kanagawaThemes: Theme[] = [
  {
    id: 'kanagawa-wave', label: 'Kanagawa Wave',
    tokens: { ...common, colors: {
      background: '#1f1f28', foreground: '#dcd7ba', muted: '#727169', accent: '#7e9cd8',
      success: '#98bb6c', warning: '#e6c384', danger: '#e82424',
    } },
  },
  {
    id: 'kanagawa-dragon', label: 'Kanagawa Dragon',
    tokens: { ...common, colors: {
      background: '#181616', foreground: '#c5c9c5', muted: '#737c73', accent: '#8ba4b0',
      success: '#87a987', warning: '#c4b28a', danger: '#c4746e',
    } },
  },
  {
    id: 'kanagawa-lotus', label: 'Kanagawa Lotus',
    tokens: { ...common, syntax: {
      ...common.syntax, comment: '#8a8980', keyword: '#624c83', string: '#6f894e', number: '#a09cac',
      function: '#4d699b', type: '#597b75', operator: '#cc6d00', constant: '#c84053',
    }, colors: {
      background: '#f2ecbc', foreground: '#545464', muted: '#8a8980', accent: '#4d699b',
      success: '#6f894e', warning: '#de9800', danger: '#c84053',
    } },
  },
]

export const name = 'kanagawa-themes'
export const inject = ['themes']

export function apply(ctx: Context): void {
  for (const theme of kanagawaThemes) ctx.themes.register(theme)
}

export default { name, inject, apply }
