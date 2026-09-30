// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { matchesInteropSchema, validateInteropSchema } from '@valley/plugin-sdk/pluginSchema'
import config from '../config.json'
import { initBackend } from '../src/backend/runtime'
import { computeEmbeddings, computeEmbeddingsV2 } from '../src/backend/embeddings'
const embeddings = vi.fn()
const result = { model: 'exact-model', vectors: [[1, 2]], source: 'a'.repeat(64), revision: null }
beforeEach(() => {
  embeddings.mockReset().mockResolvedValue(result)
  initBackend({ ai: { embeddings } } as unknown as PluginBackendApi)
})
it('forwards exact connection, model, cancellation ID and identity to shared AI', async () => {
  const request = { provider: 'openai', connectionId: 'work', model: 'exact-model', requestId: 'embedding-1', texts: ['flower'], expectedIdentity: { source: result.source, revision: null } }
  expect(await computeEmbeddingsV2(request)).toEqual(result)
  expect(embeddings).toHaveBeenCalledOnce()
  expect(embeddings).toHaveBeenCalledWith(request)
  expect(await computeEmbeddings(request)).toEqual({ model: 'exact-model', vectors: [[1, 2]] })
})
it('preserves shared service failures without retrying or taking provider ownership', async () => {
  embeddings.mockRejectedValue(new Error('Embedding identity changed during the request'))
  await expect(computeEmbeddingsV2({ provider: 'ollama', texts: ['flower'] })).rejects.toThrow('identity changed')
  expect(embeddings).toHaveBeenCalledOnce()
})
it('declares separate strict v1 and v2 wire contracts', async () => {
  const [v1, v2] = config.runtime.services
  const input = { provider: 'openai', texts: [] }
  const old = await computeEmbeddings(input)
  const current = await computeEmbeddingsV2(input)
  expect(v1).toMatchObject({ id: 'valley.text-embeddings', version: '1.0.0', method: 'embeddings.compute' })
  expect(v2).toMatchObject({ id: 'valley.text-embeddings', version: '2.0.0', method: 'embeddings.computeV2' })
  for (const shape of [v1.request, v1.response, v2.request, v2.response]) expect(validateInteropSchema(shape)).toBe(true)
  if (!validateInteropSchema(v1.response) || !validateInteropSchema(v2.response) || !validateInteropSchema(v2.request)) throw new Error('Invalid service schema')
  expect(matchesInteropSchema(v1.response, old)).toBe(true)
  expect(matchesInteropSchema(v1.response, current)).toBe(false)
  expect(matchesInteropSchema(v2.response, current)).toBe(true)
  expect(matchesInteropSchema(v2.response, old)).toBe(false)
  expect(matchesInteropSchema(v2.request, { ...input, expectedIdentity: { source: current.source, revision: null } })).toBe(true)
})
