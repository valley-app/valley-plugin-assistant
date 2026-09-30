import { expect, it } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { initLocalization } from '../src/localization'
import { registerAssistantSurfaces } from '../src/surfaces'
import { disposeStore } from '../src/store'

it('keeps subscription status out of Assistant even with a saved monitor preference', async () => {
  const mock = createMockValleyApi()
  initRuntime(mock.api)
  initLocalization(mock.api)
  await mock.api.settings.set('showSubscriptionUsage', true)
  const off = registerAssistantSurfaces(mock.api)
  expect(mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map(entry => entry.extension.id)).toEqual(['assistant.properties'])
  off()
  disposeStore()
})
