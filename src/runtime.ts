import type { ValleyPluginApi } from './api'


/**
 * Module-global handles to the host's React instance and plugin API, set once in
 * `register(api)` before any view renders — the same package-local pattern used
 * by every plugin. Components import these instead of bundling their own `react`.
 */
export let React!: typeof import('react')
export let api!: ValleyPluginApi

export function initRuntime(a: ValleyPluginApi): void {
  api = a
  React = a.React
}
