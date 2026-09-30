import path from 'path-browserify'
import { atomicWriteFile, queueFileWrite, readFile, rm } from './filesystem'
const location = (root: string, namespace: string, key: string): string => path.join(root, '.valley/cache', namespace, key)
export async function cacheReadJson<T>(root: string, namespace: string, key: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(location(root, namespace, key))) as T }
  catch { return structuredClone(fallback) }
}
export async function cacheUpdateJson<T>(root: string, namespace: string, key: string, fallback: T, update: (value: T) => void): Promise<void> {
  const file = location(root, namespace, key)
  await queueFileWrite(file, async () => { const value = await cacheReadJson(root, namespace, key, fallback); update(value); await atomicWriteFile(file, JSON.stringify(value)) })
}
export async function cacheClearNamespace(root: string, namespace: string): Promise<void> { await rm(path.join(root, '.valley/cache', namespace), { recursive: true, force: true }) }
