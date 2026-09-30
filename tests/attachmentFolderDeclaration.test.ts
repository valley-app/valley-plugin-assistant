import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('attachment folder declaration', () => {
  const root = join(__dirname, '..')
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
    settingsSchema?: { fields?: { key: string; default?: unknown; validate?: string; section?: string }[] }
  }
  const field = config.settingsSchema?.fields?.find((entry) => entry.key === 'attachmentFolder')

  it('declares the folder so core can validate it without mounting the pane', () => {
    expect(field).toBeDefined()
    expect(field?.validate).toBe('vault-folder')
    expect(field?.section).toBe('chat')
  })

  it('keeps the override empty and resolves a separate internal destination', () => {
    const source = readFileSync(join(root, 'src', 'Page.tsx'), 'utf8')
    const declared = /export const DEFAULT_ATTACH_INBOX = '([^']+)'/.exec(source)?.[1]
    expect(declared).toBeTruthy()
    expect(field?.default).toBe('')
    expect(declared).toBe('.valley/plugins/data/assistant/attachment')
  })
})
