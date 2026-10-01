import * as fs from './filesystem'
import { backendApi } from './runtime'
import type { StorageApi } from './filesystem'

export async function readText(file: string, api: StorageApi = backendApi()): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8', api)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    return null
  }
}

export async function readJson<T>(file: string, fallback: T, api: StorageApi = backendApi()): Promise<T> {
  const text = await readText(file, api)
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
