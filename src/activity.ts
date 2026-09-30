import type { ProjectActivity } from '@valley/plugin-sdk/pluginExecution'
import { redactSecrets } from '@valley/plugin-sdk'
import type { ValleyPluginApi } from './api'
export async function recordActivity(api: ValleyPluginApi, chatId: string, event: ProjectActivity, output?: string): Promise<void> {
  let outputRef: string | undefined
  if (output !== undefined) {
    const text = redactSecrets(output)
    let offset = 0
    do {
      let end = Math.min(text.length, offset + 64000)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      outputRef = await api.backend.call<string>('activity.request', { method: 'output', payload: { chatId, runId: event.runId, callId: event.callId, text: text.slice(offset, end), first: offset === 0 } })
      offset = end
    } while (offset < text.length)
  }
  await api.backend.call('activity.request', { method: 'append', payload: { chatId, event: { ...event, ...(outputRef ? { outputRef } : {}) } } })
}
