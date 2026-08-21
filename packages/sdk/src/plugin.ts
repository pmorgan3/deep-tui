import type { Plugin } from 'cordis'

export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin
}
