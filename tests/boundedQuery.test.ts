import { describe, expect, it } from 'vitest'
import { AssistantRepository, boundedQuery, record } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'

const limited = (data: ReturnType<typeof datasetFixture>, maximum: number) => ({ ...data, dataset: ((name: string) => {
  const dataset = data.dataset(name)
  return { ...dataset, query: async (query: Parameters<typeof dataset.query>[0] = {}) => {
    if ((query.limit ?? 100) > maximum) throw Object.assign(new Error('Dataset response exceeds 8 MiB'), { code: 'limit-exceeded', outcome: 'not-applied' })
    return dataset.query(query)
  } }
}) as typeof data.dataset })

describe('bounded dataset queries', () => {
  // The host refuses a page over 8 MiB; conversations with long histories reach that well below the requested row count.
  it('asks the same cursor again for fewer rows until the page fits', async () => {
    const data = datasetFixture()
    await data.dataset('sessions').insert(Array.from({ length: 45 }, (_, index) => record(`moss-${String(index).padStart(2, '0')}`, `moss-${index}`, 'IDLE', { index })))
    const rows = await new AssistantRepository(limited(data, 6)).rows<{ index: number }>('sessions')
    expect(rows.map(row => row.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 45 }, (_, index) => index))
  })

  it('fails when one row is still too large or the error is not about size', async () => {
    const data = datasetFixture()
    await data.dataset('sessions').insert(record('moss', 'moss', 'IDLE', {}))
    await expect(boundedQuery(limited(data, 0).dataset('sessions'), { limit: 500 })).rejects.toThrow('Dataset response exceeds 8 MiB')
    const broken = { query: async () => { throw new Error('Store unavailable') } }
    await expect(boundedQuery(broken, { limit: 500 })).rejects.toThrow('Store unavailable')
  })
})
