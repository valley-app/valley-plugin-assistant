export const survey = {
  site: 'alpine-meadow-a',
  species: ['Bombus terrestris', 'Gentiana verna', 'Lepus timidus'],
  observations: 3
}

export const lookupTool = {
  name: 'lookup_observation',
  description: 'Look up one observation in a read-only biodiversity survey.',
  parameters: {
    type: 'object',
    properties: {
      species: { type: 'string' }
    },
    required: ['species'],
    additionalProperties: false
  }
}
