import * as fs from './filesystem'

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const text = await readText(file)
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
