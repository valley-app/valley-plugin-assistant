export function transportValue<T>(value: T): T {
  const ancestors = new Set<object>()
  let nodes = 0
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 100) throw new Error('Assistant response exceeds the structural limit')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object') throw new Error('Assistant response is not serializable')
    if (ancestors.has(input)) throw new Error('Assistant response contains a cycle')
    const array = Array.isArray(input)
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error('Assistant response requires plain objects')
    if (Object.getOwnPropertySymbols(input).length) throw new Error('Assistant response contains symbol properties')
    const keys = Object.getOwnPropertyNames(input)
    if (array && (keys.length !== input.length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)))) throw new Error('Assistant response requires dense arrays')
    ancestors.add(input)
    const entries: Array<[string, unknown]> = []
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Assistant response requires enumerable data properties')
      if (descriptor.value === undefined && !array) continue
      entries.push([key, visit(descriptor.value, depth + 1)])
    }
    ancestors.delete(input)
    return array ? entries.map(([, item]) => item) : Object.fromEntries(entries)
  }
  return value === undefined ? value : visit(value, 0) as T
}
