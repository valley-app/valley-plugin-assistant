import { describe, expect, it } from 'vitest'
import { coerceArgs } from '../src/agent/coerceArgs'

const runCliSchema = {
  type: 'object',
  properties: {
    ns: { type: 'string' },
    sub: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    flags: { type: 'object' }
  }
}

const musicSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    shuffle: { type: 'boolean' },
    random: { type: 'boolean' },
    volume: { type: 'number' }
  }
}

describe('coerceArgs', () => {
  it('turns a stringified Python list into a real array (the screenshot bug)', () => {
    const out = coerceArgs(runCliSchema, { ns: 'music', sub: 'play', args: "['Orbiter']" })
    expect(out.args).toEqual(['Orbiter'])
  })

  it('parses a JSON-array string and a CSV string for array params', () => {
    expect(coerceArgs(runCliSchema, { args: '["a","b"]' }).args).toEqual(['a', 'b'])
    expect(coerceArgs(runCliSchema, { args: 'a, b' }).args).toEqual(['a', 'b'])
  })

  it('wraps a lone scalar into an array for array params', () => {
    expect(coerceArgs(runCliSchema, { args: 'Canopy Echo' }).args).toEqual(['Canopy Echo'])
  })

  it('coerces "true"/"false" strings to booleans', () => {
    const out = coerceArgs(musicSchema, { title: 'x', shuffle: 'true', random: 'false' })
    expect(out.shuffle).toBe(true)
    expect(out.random).toBe(false)
  })

  it('coerces numeric strings to numbers', () => {
    expect(coerceArgs(musicSchema, { volume: '40' }).volume).toBe(40)
  })

  it('drops placeholder strings like "null"/"undefined"/"none"', () => {
    const out = coerceArgs(musicSchema, { title: 'Canopy Echo', shuffle: 'null', random: 'undefined' })
    expect(out).toEqual({ title: 'Canopy Echo' })
  })

  it('unwraps a double-wrapped "parameters" object', () => {
    const out = coerceArgs(runCliSchema, { parameters: { ns: 'music', sub: 'play', args: ['x'] } })
    expect(out).toEqual({ ns: 'music', sub: 'play', args: ['x'] })
  })

  it('unwraps an "arguments" wrapper', () => {
    const out = coerceArgs(musicSchema, { arguments: { title: 'Orbiter' } })
    expect(out).toEqual({ title: 'Orbiter' })
  })

  it('leaves correctly-typed values untouched', () => {
    const out = coerceArgs(musicSchema, { title: 'Orbiter', shuffle: true, volume: 30 })
    expect(out).toEqual({ title: 'Orbiter', shuffle: true, volume: 30 })
  })

  it('passes unknown/unschematized props through verbatim', () => {
    const out = coerceArgs(musicSchema, { title: 'x', weird: { nested: 1 } })
    expect(out.weird).toEqual({ nested: 1 })
  })
})
