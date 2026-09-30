import { expect, it } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend, t } from '../src/backend/runtime'
import { harnessWorkerMessages } from '../src/backend/harness/workerRuntime'
import { runSkill } from '../src/backend/skills'
import en from '../locales/en.json'
import de from '../locales/de.json'
import fr from '../locales/fr.json'
import es from '../locales/es.json'
import zh from '../locales/zh-CN.json'

it('owns complete error catalogs and resolves errors and worker messages in the current language', async () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('assistant.backend.') || key.startsWith('assistant.harness.') || key.startsWith('assistant.error.'))
  for (const catalog of [de, fr, es, zh]) for (const key of keys) {
    expect((catalog as Record<string, string>)[key]).toBeTruthy()
    expect((catalog as Record<string, string>)[key].match(/\{\{\w+\}\}/g)?.sort() ?? []).toEqual((en as Record<string, string>)[key].match(/\{\{\w+\}\}/g)?.sort() ?? [])
  }
  initBackend({ i18n: { t: (key: string) => (de as Record<string, string>)[key] ?? key } } as unknown as PluginBackendApi)
  expect(t('assistant.backend.backendUnavailable')).toBe('Das Assistant-Backend ist nicht verfügbar')
  expect(harnessWorkerMessages()['assistant.backend.harnessTurns']).toBe(de['assistant.backend.harnessTurns'])
  await expect(runSkill('/vault', 'unsupported', {})).rejects.toThrow(de['assistant.backend.unknownRunnable'])
})
