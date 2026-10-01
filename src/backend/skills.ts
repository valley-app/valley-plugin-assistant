import type { ConfigurationApi } from './configuration/documents'
import path from 'path-browserify'
import * as fs from './filesystem'
import { VAULT_ROOT } from './runtime'
import { TOOLBOX_DIR, skillMetaFrom } from '../skills'
import { isSafeName } from './paths'
import { openOwnedAttachment } from './attachments'
import { z } from 'zod'
import { backendApi, t } from './runtime'
import { guardFilePath } from './guards'

export const skillRequestSchema = z.object({
  runnable: z.string().min(1).max(128),
  args: z.record(z.string().max(4096)).default({})
}).strict()

export async function runSkill(root: string, runnable: string, args: Record<string, string>, api: ConfigurationApi = backendApi()): Promise<string> {
  if (runnable !== 'markitdown') throw new Error(t('assistant.backend.unknownRunnable', { runnable }))
  if (!args.path?.trim()) throw new Error(t('assistant.backend.runnablePath', { runnable }))
  const tool = await api.native.resolve({ name: 'markitdown' })
  if (!tool) throw new Error(t('assistant.backend.missingTool'))
  const owned = await openOwnedAttachment(args.path, api)
  if (!owned) await guardFilePath(root, args.path, 'read', api)
  const file = owned ?? await api.files.openVault(args.path)
  const jobId = crypto.randomUUID(), decoder = new TextDecoder(), errorDecoder = new TextDecoder()
  let output = '', errors = '', truncated = false
  const off = api.native.onOutput((event) => {
    if (event.jobId !== jobId || truncated) return
    const text = (event.stream === 'stdout' ? decoder : errorDecoder).decode(Uint8Array.from(atob(event.base64), (character) => character.charCodeAt(0)), { stream: true })
    if (event.stream === 'stdout') output += text
    else errors = (errors + text).slice(-200_000)
    if (output.length > 200_000) {
      output = output.slice(0, 200_000)
      truncated = true
      void api.native.cancel(jobId).catch(() => undefined)
    }
  })
  try {
    const result = await api.native.run({ jobId, executable: tool.handle, args: [{ input: file.handle }], environment: { PYTHONDONTWRITEBYTECODE: '1' } })
    await api.files.release(result.outputs.map((entry) => entry.handle))
    errors += errorDecoder.decode()
    if (result.exitCode && !truncated) throw new Error(errors.trim() || t('assistant.backend.operationFailed', { operation: 'MarkItDown', status: result.exitCode }))
    output += decoder.decode()
    return output.trim()
  } catch (error) {
    if (truncated) return output.trim()
    throw error
  } finally { off(); await api.files.release([file.handle]) }
}

export async function toolboxRequest(payload: unknown): Promise<unknown> {
  const input = z.object({ method: z.enum(['list', 'read']), name: z.string().max(256).optional(), file: z.enum(['skill.md', 'skill.json']).optional() }).strict().parse(payload)
  const directory = path.join(VAULT_ROOT, TOOLBOX_DIR)
  if (input.method === 'list') {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: { code?: string }) => { if (error.code === 'ENOENT') return []; throw error })
    const skills = []
    for (const entry of entries) if (entry.isDirectory() && isSafeName(entry.name)) {
      try { skills.push(skillMetaFrom(entry.name, await fs.readFile(path.join(directory, entry.name, 'skill.md')))) }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    }
    return skills
  }
  if (!input.name || !isSafeName(input.name) || !input.file) throw new Error('Invalid Toolbox skill')
  try { return await fs.readFile(path.join(directory, input.name, input.file)) }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error }
}
