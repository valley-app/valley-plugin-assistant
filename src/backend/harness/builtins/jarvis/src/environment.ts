import type { HarnessTool } from '../../../../../harnessTypes'

const observations = [
  { id: 'obs-1', species: 'Bombus terrestris', site: 'alpine-meadow-a', count: 7, source: 'transect-2026-06-12' },
  { id: 'obs-2', species: 'Gentiana verna', site: 'alpine-meadow-a', count: 18, source: 'quadrat-2026-06-12' },
  { id: 'obs-3', species: 'Lepus timidus', site: 'forest-edge-b', count: 2, source: 'camera-2026-06-13' }
]

export const expectedSources = observations.map((item) => item.source)

export const tools: HarnessTool[] = [
  {
    definition: {
      name: 'search_observations',
      description: 'Search the immutable biodiversity observation fixture by site or species.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      }
    },
    handle({ call }) {
      const query = String(call.arguments.query ?? '').toLowerCase()
      return observations.filter((item) => `${item.site} ${item.species}`.toLowerCase().includes(query))
    }
  },
  {
    definition: {
      name: 'read_observation',
      description: 'Read one immutable biodiversity observation by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      }
    },
    handle({ call }) {
      return observations.find((item) => item.id === call.arguments.id) ?? null
    }
  }
]
