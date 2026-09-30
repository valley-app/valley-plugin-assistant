import type { AiEmbeddingRequest } from '@valley/plugin-sdk/ai'
import { backendApi } from './runtime'
export const computeEmbeddingsV2 = (payload: unknown) => backendApi().ai.embeddings(payload as AiEmbeddingRequest)
export const computeEmbeddings = async (payload: unknown) => {
  const { model, vectors } = await computeEmbeddingsV2(payload)
  return { model, vectors }
}
