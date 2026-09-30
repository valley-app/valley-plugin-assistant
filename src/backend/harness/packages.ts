import { t } from '../runtime'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as fs from '../filesystem'
import { dirname, extname, join, relative, resolve } from 'path-browserify'
const sep = '/'
import { z } from 'zod'
import {
  ASSISTANT_HARNESS_DIR,
  ASSISTANT_HARNESS_SETTINGS_FILE
} from './paths'
import type {
  HarnessConfig,
  HarnessCreatePackage,
  HarnessManifest,
  HarnessPackageSnapshot,
  HarnessPackageStatus,
  HarnessSettingValue
} from '../../harnessTypes'
import type { FileBaseline, GuardedWriteResult } from '@valley/plugin-sdk/types'
import { atomicWriteFile, queueFileWrite } from '../filesystem'
import { compileUserModule } from '../compiler'
const hashContent = (content: string): string => bytesToHex(sha256(new TextEncoder().encode(content)))
import { createHarnessWorker } from './workerRuntime'

export const HARNESS_SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_TIMEOUT_MS = 60_000
const MAX_MEMORY_MB = 256
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TURNS = 32
const MAX_CONCURRENCY = 8
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.json'])
const CREDENTIAL_SETTING_KEY = /(?:^|[-_])(?:secret|password|credential|api[-_]?key|access[-_]?token|auth[-_]?token)(?:$|[-_])/i

const manifestSchema: z.ZodType<HarnessManifest> = z.object({
  apiVersion: z.literal(1),
  id: z.string().regex(HARNESS_SAFE_ID),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(64),
  description: z.string().max(1000),
  author: z.string().max(200).optional(),
  enabled: z.boolean()
}).strict()

const settingValue = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())])
const settingField = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['text', 'number', 'boolean', 'select', 'textarea', 'range']),
  default: settingValue.optional(),
  required: z.boolean().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional()
}).strict()

const configSchema: z.ZodType<HarnessConfig> = z.object({
  packageKind: z.literal('ai-harness'),
  main: z.string().regex(/^src\/(?!.*\.\.)[^\\]+\.(?:ts|tsx|js)$/),
  icon: z.string().min(1).max(200),
  settingsSchema: z.array(settingField),
  execution: z.object({
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
    memoryMb: z.number().int().min(16).max(MAX_MEMORY_MB),
    maxResponseBytes: z.number().int().positive().max(MAX_RESPONSE_BYTES),
    maxTurns: z.number().int().positive().max(MAX_TURNS),
    maxConcurrency: z.number().int().positive().max(MAX_CONCURRENCY)
  }).strict(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(8),
    baseDelayMs: z.number().int().min(10).max(60_000),
    maxDelayMs: z.number().int().min(10).max(300_000)
  }).strict(),
  cache: z.object({
    maxAgeDays: z.number().int().positive().max(365),
    maxSizeMb: z.number().int().positive().max(2048)
  }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.retry.maxDelayMs < value.retry.baseDelayMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('assistant.backend.retryDelay') })
  }
  const keys = new Set<string>()
  for (const field of value.settingsSchema) {
    if (keys.has(field.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('assistant.backend.duplicateSetting', { value: field.key }) })
    if (CREDENTIAL_SETTING_KEY.test(field.key) || /(?:apiKey|accessToken|authToken)$/.test(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('assistant.backend.settingSecret', { value: field.key }) })
    }
    keys.add(field.key)
  }
})

export interface LoadedHarness {
  dir: string
  manifest: HarnessManifest
  config: HarnessConfig
  digest: string
  url: string
  dispose(): void
  source?: Record<string, string>
  cases: { id: string; name: string; description?: string; weight: number }[]
  updateAvailable?: boolean
}

let activeRoot = ''
let loaded = new Map<string, LoadedHarness>()
let statuses: HarnessPackageStatus[] = []
let packageSources = new Map<string, Record<string, string>>()
const creating = new Set<string>()

interface BuiltinPackage { manifest: HarnessManifest; config: HarnessConfig; files: Record<string, string> }
let builtins: Record<string, BuiltinPackage> = {}
async function builtinPackages(): Promise<Record<string, BuiltinPackage>> {
  if (Object.keys(builtins).length) return builtins
  const response = await fetch(new URL('./assets/harnesses/index.json', import.meta.url))
  if (!response.ok) throw new Error(t('assistant.backend.harnessAssets'))
  builtins = await response.json() as Record<string, BuiltinPackage>
  return builtins
}

export async function digestHarnessTree(root: string): Promise<string> {
  const hash = sha256.create()
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (/claude/i.test(entry.name) || ['.DS_Store', 'node_modules', '.git'].includes(entry.name)) continue
      const file = join(dir, entry.name)
      hash.update(new TextEncoder().encode(relative(root, file)))
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) hash.update(new TextEncoder().encode(await fs.readFile(file)))
    }
  }
  await walk(root)
  return bytesToHex(hash.digest())
}

function defaults(config: HarnessConfig): Record<string, HarnessSettingValue> {
  return Object.fromEntries(config.settingsSchema.filter((field) => field.default !== undefined).map((field) => [field.key, field.default!]))
}

async function readAllSettings(root: string): Promise<Record<string, Record<string, HarnessSettingValue>>> {
  try {
    const value = JSON.parse(await fs.readFile(join(root, ASSISTANT_HARNESS_SETTINGS_FILE), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function validateWorker(candidate: Omit<LoadedHarness, 'cases'>): Promise<LoadedHarness['cases']> {
  return new Promise((resolveCases, reject) => {
    const worker = createHarnessWorker({ mode: 'validate', url: candidate.url, harnessId: candidate.manifest.id })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(t('assistant.backend.harnessTimeout')))
    }, Math.min(5000, candidate.config.execution.timeoutMs))
    worker.addEventListener('message', ({ data: message }: MessageEvent<{ type?: string; cases?: LoadedHarness['cases']; error?: string }>) => {
      if (message.type === 'validated' && message.cases) {
        clearTimeout(timer)
        void worker.terminate()
        const ids = new Set<string>()
        if (!Array.isArray(message.cases) || message.cases.length > 512 || message.cases.some((item) => {
          if (!item || !HARNESS_SAFE_ID.test(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 1000 || !Number.isFinite(item.weight) || item.weight <= 0 || ids.has(item.id)) return true
          ids.add(item.id)
          return false
        })) { reject(new Error(t('assistant.backend.harnessCases'))); return }
        resolveCases(message.cases)
      } else if (message.type === 'worker-error') {
        clearTimeout(timer)
        void worker.terminate()
        reject(new Error(message.error ?? t('assistant.backend.harnessValidation')))
      }
    })
    worker.addEventListener('error', (error) => { clearTimeout(timer); worker.terminate(); reject(new Error(error.message)) })
  })
}

export async function reloadHarnessPackages(root: string): Promise<HarnessPackageStatus[]> {
  activeRoot = resolve(root)
  for (const harness of loaded.values()) harness.dispose()
  loaded = new Map()
  statuses = []
  const allSettings = await readAllSettings(activeRoot)
  const base = join(activeRoot, ASSISTANT_HARNESS_DIR)
  const ownPackages = await builtinPackages()
  const candidates = new Map<string, { dir: string; source?: Record<string, string> }>(Object.entries(ownPackages).map(([id, value]) => [id, { dir: `/package/harness/${id}`, source: { ...value.files, 'manifest.json': JSON.stringify(value.manifest), 'config.json': JSON.stringify(value.config) } }]))
  for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && HARNESS_SAFE_ID.test(entry.name) && !/claude/i.test(entry.name)) candidates.set(entry.name, { dir: join(base, entry.name) })
  }
  packageSources = new Map([...candidates].flatMap(([id, value]) => value.source ? [[id, value.source]] : []))
  for (const [id, candidate] of candidates) {
    let manifest: HarnessManifest | undefined
    let config: HarnessConfig | undefined
    let compiled: Awaited<ReturnType<typeof compileUserModule>> | undefined
    try {
      const readText = async (file: string): Promise<string> => {
        if (!candidate.source) return fs.readFile(file)
        const name = relative(candidate.dir, file)
        if (!Object.hasOwn(candidate.source, name)) throw Object.assign(new Error('Module not found'), { code: 'ENOENT' })
        return candidate.source[name]
      }
      manifest = manifestSchema.parse(JSON.parse(await readText(join(candidate.dir, 'manifest.json'))))
      if (candidate.source && typeof allSettings.__enabled?.[id] === 'boolean') manifest.enabled = allSettings.__enabled[id] as boolean
      config = configSchema.parse(JSON.parse(await readText(join(candidate.dir, 'config.json'))))
      if (manifest.id !== id) throw new Error(t('assistant.backend.harnessFolder'))
      const settings = { ...defaults(config), ...(allSettings[id] ?? {}) }
      const baseStatus = { id, name: manifest.name, version: manifest.version, description: manifest.description,
        ...(manifest.author ? { author: manifest.author } : {}), enabled: manifest.enabled, icon: config.icon,
        settingsSchema: config.settingsSchema, settings, execution: config.execution }
      if (!manifest.enabled) { statuses.push({ ...baseStatus, ready: false }); continue }
      compiled = await compileUserModule(join(candidate.dir, config.main), { rootPath: candidate.dir, readText })
      const digest = hashContent(compiled.sourceDigest + JSON.stringify(manifest) + JSON.stringify(config))
      const partial = { ...candidate, manifest, config, digest, url: compiled.url, dispose: compiled.dispose }
      const cases = await validateWorker(partial)
      loaded.set(id, { ...partial, cases })
      statuses.push({ ...baseStatus, sourceDigest: digest, ready: true, caseCount: cases.length })
    } catch (error) {
      compiled?.dispose()
      statuses.push({ id, name: manifest?.name ?? id, version: manifest?.version ?? '', description: manifest?.description ?? '',
        ...(manifest?.author ? { author: manifest.author } : {}), enabled: manifest?.enabled ?? false, icon: config?.icon ?? 'extension', ready: false,
        error: error instanceof Error ? error.message : String(error), settingsSchema: config?.settingsSchema ?? [], settings: config ? { ...defaults(config), ...(allSettings[id] ?? {}) } : {},
        execution: config?.execution ?? { timeoutMs: 1000, memoryMb: 64, maxResponseBytes: 262144, maxTurns: 1, maxConcurrency: 1 } })
    }
  }
  return listHarnessPackageStatuses()
}

export async function ensureHarnessPackages(root: string): Promise<void> {
  if (activeRoot !== resolve(root) || statuses.length === 0) await reloadHarnessPackages(root)
}

export function listHarnessPackageStatuses(): HarnessPackageStatus[] {
  return statuses.map((item) => structuredClone(item))
}

export function getLoadedHarness(id: string): LoadedHarness | null {
  return loaded.get(id) ?? null
}

function safePackageFile(id: string, file: string): string | null {
  if (!HARNESS_SAFE_ID.test(id) || /claude/i.test(id)) return null
  const normalized = file.replace(/\\/g, '/')
  if (!['manifest.json', 'config.json'].includes(normalized) && (!normalized.startsWith('src/') || !SOURCE_EXTENSIONS.has(extname(normalized)))) return null
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..' || /claude/i.test(part))) return null
  return `${ASSISTANT_HARNESS_DIR}/${id}/${normalized}`
}

async function baseline(path: string, content: string): Promise<FileBaseline> {
  const stat = await fs.stat(path)
  return { mtimeMs: stat.mtimeMs, size: stat.size, hash: hashContent(content) }
}

export async function readHarnessPackage(root: string, id: string): Promise<(HarnessPackageSnapshot & { readOnly?: boolean }) | null> {
  if (!HARNESS_SAFE_ID.test(id) || /claude/i.test(id)) return null
  const source = packageSources.get(id)
  if (source) {
    const manifest = manifestSchema.parse(JSON.parse(source['manifest.json']))
    const settings = await readAllSettings(root)
    if (typeof settings.__enabled?.[id] === 'boolean') manifest.enabled = settings.__enabled[id] as boolean
    const files = { ...source, 'manifest.json': JSON.stringify(manifest, null, 2) + '\n' }
    return { manifest, config: configSchema.parse(JSON.parse(source['config.json'])), readOnly: true, files: Object.entries(files).map(([path, content]) => ({ path, content, baseline: { mtimeMs: 0, size: new TextEncoder().encode(content).byteLength, hash: hashContent(content) } })) }
  }
  const dir = join(root, ASSISTANT_HARNESS_DIR, id)
  try {
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')))
    const config = configSchema.parse(JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8')))
    const files: HarnessPackageSnapshot['files'] = []
    const walk = async (folder: string): Promise<void> => {
      for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (/claude/i.test(entry.name) || ['node_modules', '.git'].includes(entry.name)) continue
        const path = join(folder, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) {
          const rel = relative(dir, path).split(sep).join('/')
          if (!safePackageFile(id, rel)) continue
          const content = await fs.readFile(path, 'utf8')
          files.push({ path: rel, content, baseline: await baseline(path, content) })
        }
      }
    }
    await walk(dir)
    return { manifest, config, files }
  } catch {
    return null
  }
}

export async function createHarnessPackage(root: string, input: HarnessCreatePackage): Promise<void> {
  const manifest = manifestSchema.parse(input.manifest)
  if (/claude/i.test(manifest.id)) throw new Error(t('assistant.backend.harnessId'))
  const config = configSchema.parse(input.config)
  if (!input.files[config.main]) throw new Error(t('assistant.backend.harnessMain', { value: config.main }))
  const target = join(root, ASSISTANT_HARNESS_DIR, manifest.id)
  if (creating.has(target)) throw new Error(t('assistant.backend.harnessCreating'))
  creating.add(target)
  const staging = `${target}.create-${crypto.randomUUID()}-${Date.now()}`
  try {
    if (await fs.access(target).then(() => true, () => false)) throw new Error(t('assistant.backend.harnessExists'))
    await fs.mkdir(staging, { recursive: true })
    await atomicWriteFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await atomicWriteFile(join(staging, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
    for (const [file, content] of Object.entries(input.files)) {
      const rel = safePackageFile(manifest.id, file)
      if (!rel || !file.startsWith('src/')) throw new Error(t('assistant.backend.harnessSource', { value: file }))
      await atomicWriteFile(join(staging, file), content)
    }
    await fs.mkdir(dirname(target), { recursive: true })
    if (await fs.access(target).then(() => true, () => false)) throw new Error(t('assistant.backend.harnessExists'))
    await fs.rename(staging, target)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    creating.delete(target)
  }
}

function sameBaseline(path: string, expected: FileBaseline | null): Promise<{ same: boolean; current: FileBaseline | null }> {
  return fs.readFile(path, 'utf8').then(async (content) => {
    const current = await baseline(path, content)
    return { same: expected !== null && current.hash === expected.hash, current }
  }, () => ({ same: expected === null, current: null }))
}

export async function writeHarnessFile(
  root: string,
  id: string,
  file: string,
  content: string,
  expected: FileBaseline | null
): Promise<GuardedWriteResult> {
  const rel = safePackageFile(id, file)
  if (!rel) return { ok: false, reason: 'error' }
  if (packageSources.has(id)) {
    if (file !== 'manifest.json') return { ok: false, reason: 'error' }
    const settingsFile = join(root, ASSISTANT_HARNESS_SETTINGS_FILE)
    return queueFileWrite(settingsFile, async () => {
      const snapshot = await readHarnessPackage(root, id)
      const current = snapshot?.files.find((entry) => entry.path === file)?.baseline ?? null
      if (!snapshot || !expected || current?.hash !== expected.hash) return { ok: false, reason: 'conflict', current }
      const next = manifestSchema.parse(JSON.parse(content))
      if (JSON.stringify({ ...next, enabled: false }) !== JSON.stringify({ ...snapshot.manifest, enabled: false })) return { ok: false, reason: 'error' }
      const settings = await readAllSettings(root)
      settings.__enabled = { ...settings.__enabled, [id]: next.enabled }
      await atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2) + '\n')
      const text = JSON.stringify(next, null, 2) + '\n'
      return { ok: true, baseline: { mtimeMs: 0, size: new TextEncoder().encode(text).byteLength, hash: hashContent(text) } }
    })
  }
  if (file === 'manifest.json') {
    const manifest = manifestSchema.parse(JSON.parse(content))
    if (manifest.id !== id) return { ok: false, reason: 'error' }
  }
  if (file === 'config.json') configSchema.parse(JSON.parse(content))
  const path = join(root, rel)
  return queueFileWrite(path, async () => {
    const check = await sameBaseline(path, expected)
    if (!check.same) return { ok: false, reason: 'conflict', current: check.current }
    await atomicWriteFile(path, content)
    return { ok: true, baseline: await baseline(path, content) }
  })
}

export async function saveHarnessSettings(root: string, id: string, values: Record<string, HarnessSettingValue>): Promise<void> {
  const harness = loaded.get(id)
  const status = statuses.find((item) => item.id === id)
  const schema = harness?.config.settingsSchema ?? status?.settingsSchema
  if (!schema) throw new Error(t('assistant.backend.harnessUnknown'))
  const fields = new Map(schema.map((field) => [field.key, field]))
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key)
    if (!field) throw new Error(t('assistant.backend.harnessSetting', { value: key }))
    settingValue.parse(value)
    if (field.type === 'number' || field.type === 'range') {
      if (typeof value !== 'number' || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) throw new Error(t('assistant.backend.invalidSetting', { value: key }))
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(t('assistant.backend.invalidSetting', { value: key }))
    if (['text', 'textarea', 'select'].includes(field.type) && typeof value !== 'string') throw new Error(t('assistant.backend.invalidSetting', { value: key }))
    if (field.type === 'select' && !field.options?.some((option) => option.value === value)) throw new Error(t('assistant.backend.invalidSetting', { value: key }))
  }
  for (const field of schema) {
    if (field.required && values[field.key] === undefined && field.default === undefined) throw new Error(t('assistant.backend.requiredSetting', { value: field.key }))
  }
  const all = await readAllSettings(root)
  all[id] = values
  await atomicWriteFile(join(root, ASSISTANT_HARNESS_SETTINGS_FILE), `${JSON.stringify(all, null, 2)}\n`)
}
