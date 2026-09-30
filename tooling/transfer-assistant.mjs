import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { buildPluginOpenUrl } from '@valley/plugin-sdk/paths'
const hash = value => createHash('sha256').update(value).digest('hex')
// Original shipped packages from Valley commit 7441aa8, before core AI ownership.
const shippedProviders = {
  anthropic: '8f3e89109cb73adfb221266ea78a2ec9f93a6277a072371a1ee08814f08cc25f',
  deepseek: '80fbe3b1ab60f76c2e348d3bb8689b94fadd9871ed0f07b24e0bd6c455a1c7f3',
  gemini: '6736e9359dfaf16033e0022fa18d321ec0bfe053b9ae1eb328642d0a7a949185',
  kimi: '1ee103e58be6ed2dab8463f15b48c2d09923f23c8cb4cd967add9e884b481ac7',
  ollama: '410b0374037c45ddbe39f0243d4b110778364ce186608adfc3884f61881980d7',
  openai: '663c8bf2c4a8e0eff3e569a17f7748f0aebd73098ee1c6039984e69ba0c6ba90',
  xai: 'b6ef46c25a03d5340171ac6a2f51aea0ea43c949c9320804f704b30158afa914'
}
const blocked = value => /claude/i.test(value) || /^\/Users\/[^/]+\/Documents\/main\/(?:Notes\/)?notes(?:\/|$)/i.test(value)
const exists = file => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function safe(file) {
  const absolute = path.resolve(file)
  if (blocked(absolute)) throw new Error('Excluded location')
  let current = path.parse(absolute).root
  for (const part of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, part)
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Transfer paths cannot contain symbolic links')
  }
  return absolute
}
function files(directory) {
  if (!exists(directory)) return []
  safe(directory)
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || blocked(entry.name)) continue
    const file = safe(path.join(directory, entry.name))
    if (entry.isDirectory()) found.push(...files(file))
    else if (entry.isFile()) found.push(file)
    else throw new Error('Unsupported transfer file')
  }
  return found
}
const json = (file, fallback) => exists(file) ? JSON.parse(fs.readFileSync(safe(file), 'utf8')) : fallback
function providerDigest(directory) {
  const digest = createHash('sha256')
  const walk = root => {
    for (const entry of fs.readdirSync(safe(root), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.DS_Store', 'node_modules', '.git'].includes(entry.name)) continue
      const file = safe(path.join(root, entry.name))
      digest.update(path.relative(directory, file).split(path.sep).join('/'))
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) digest.update(fs.readFileSync(file))
      else throw new Error('Unsupported provider file')
    }
  }
  walk(directory)
  return digest.digest('hex')
}
function write(file, value) {
  safe(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file)
}
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const segment = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value) && !value.includes('..')
const decodeMap = (file, codec) => Object.fromEntries(Object.entries(json(file, {})).map(([key, cipher]) => {
  if (typeof cipher !== 'string' || Buffer.from(cipher, 'base64').toString('base64') !== cipher) throw new Error('Malformed credential storage')
  return [key, codec.decrypt(Buffer.from(cipher, 'base64'))]
}))
const encryptMap = (map, codec) => Object.fromEntries(Object.entries(map).map(([key, value]) => {
  const cipher = codec.encrypt(value)
  if (codec.decrypt(cipher) !== value) throw new Error('Credential verification failed')
  return [key, cipher.toString('base64')]
}))
function merge(target, source, label) {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value)) throw new Error(`Conflicting ${label}: ${key}`)
    target[key] = value
  }
  return target
}

export function prepareTransfer({ vaultRoot, userData, backupDirectory, codec }) {
  const vault = safe(vaultRoot), device = safe(userData), backup = safe(backupDirectory)
  if (backup === vault || backup.startsWith(vault + path.sep) || backup === device || backup.startsWith(device + path.sep)) throw new Error('Backup must be outside the vault and device profile')
  if (exists(path.join(backup, 'plan.json'))) throw new Error('This backup already contains a transfer; apply or resume it')
  const app = json(path.join(vault, '.valley/settings/app.json'), {})
  if (!/^[a-f0-9-]{36}$/.test(app.vaultId ?? '')) throw new Error('Complete the core storage-layout transfer first')
  const old = path.join(vault, '.valley/assistant'), home = path.join(vault, '.valley/plugins/data/assistant')
  const marker = path.join(home, 'transfer-completed.json')
  if (exists(marker)) throw new Error('Assistant ownership was already transferred')
  const sources = new Map(), outputs = new Map(), removals = new Set(), unresolved = [], moves = new Map()
  const capture = file => {
    safe(file)
    if (!sources.has(file)) sources.set(file, exists(file) ? fs.readFileSync(file) : null)
    return sources.get(file)
  }
  const output = (file, bytes, replace = false) => {
    const previous = capture(file), next = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (outputs.has(file) && !outputs.get(file).equals(next)) throw new Error(`Conflicting transfer output: ${file}`)
    if (!replace && previous && !previous.equals(next)) throw new Error(`Destination already contains different data: ${file}`)
    outputs.set(file, next)
  }
  const move = (source, destination) => {
    const bytes = capture(source)
    if (!bytes) return
    output(destination, bytes); removals.add(source)
    moves.set(path.relative(vault, source).split(path.sep).join('/'), path.relative(vault, destination).split(path.sep).join('/'))
  }
  const tree = (from, to) => { for (const file of files(from)) move(file, path.join(to, path.relative(from, file))) }
  const connectionsFile = path.join(old, 'assistant.json'), coreConnections = path.join(vault, '.valley/ai/connections.json')
  const legacyConnections = json(connectionsFile, { connections: [] })
  const emptyProviderDefaults = Object.entries(legacyConnections).every(([key, value]) => ['baseUrls', 'models'].includes(key) && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  const connections = legacyConnections.connections ?? (emptyProviderDefaults ? [] : undefined)
  if (!Array.isArray(connections)) throw new Error('Invalid legacy connections')
  const combined = new Map((json(coreConnections, [])).map(connection => [connection.id, connection]))
  const known = new Set(['anthropic', 'deepseek', 'gemini', 'kimi', 'ollama', 'openai', 'xai'])
  for (const connection of connections) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(connection.id) || !known.has(connection.provider)) throw new Error('An unsupported provider must be ported before switching ownership')
    if (combined.has(connection.id) && JSON.stringify(combined.get(connection.id)) !== JSON.stringify(connection)) throw new Error('AI connection ID conflict')
    combined.set(connection.id, connection)
  }
  const providerRoot = path.join(old, 'providers'), retiredProviders = new Set()
  for (const file of files(providerRoot).filter(file => file.endsWith('/manifest.json'))) {
    const manifest = json(file, {}), directory = path.dirname(file)
    if (path.dirname(directory) === providerRoot && manifest.id === path.basename(directory) && shippedProviders[manifest.id] === providerDigest(directory)) retiredProviders.add(directory)
    else if (manifest.enabled !== false) throw new Error('A custom provider package must be ported before switching ownership')
  }
  for (const file of files(providerRoot)) {
    capture(file)
    if ([...retiredProviders].some(directory => file.startsWith(directory + path.sep))) removals.add(file)
    else move(file, path.join(vault, '.valley/ai/providers', path.relative(providerRoot, file)))
  }
  const providerLock = path.join(old, 'providers.lock.json')
  if (exists(providerLock)) { capture(providerLock); removals.add(providerLock) }
  if (exists(connectionsFile)) { capture(connectionsFile); removals.add(connectionsFile); output(coreConnections, encoded([...combined.values()]), true) }
  const credentialRoot = path.join(device, 'vaults', app.vaultId, 'credentials')
  for (const [name, target, channel] of [['provider-secrets.json', path.join(credentialRoot, 'ai.json'), false], ['secrets.json', path.join(credentialRoot, 'plugin/assistant/credentials.json'), true]]) {
    const source = path.join(old, name)
    const accountSource = path.join(credentialRoot, 'accounts.json')
    const accountConfig = path.join(vault, '.valley/accounts/connections.json')
    const accounts = channel ? [] : (json(accountConfig, {}).accounts ?? []).filter(account => account.kind === 'api-key' && [...combined.values()].some(connection => connection.id === account.id && connection.provider === account.provider))
    if (!exists(source) && !accounts.length) continue
    capture(source); capture(target)
    const legacy = decodeMap(source, codec), current = decodeMap(target, codec)
    const converted = Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, channel ? JSON.stringify({ value }) : value]))
    if (accounts.length) {
      capture(accountSource); capture(accountConfig)
      const accountSecrets = decodeMap(accountSource, codec)
      for (const account of accounts) if (accountSecrets[account.id]) {
        const secret = JSON.parse(accountSecrets[account.id])
        if (secret.kind !== 'api-key' || typeof secret.value !== 'string') throw new Error('AI account credential is unavailable')
        converted['provider:' + account.id] = secret.value
      }
    }
    output(target, encoded(encryptMap(merge(current, converted, 'credential'), codec)), true); if (exists(source)) removals.add(source)
  }
  const usageSource = path.join(device, 'assistant/usage.json'), usageTarget = path.join(device, 'ai/usage.json')
  if (exists(usageSource)) {
    const bytes = capture(usageSource), raw = bytes.toString()
    if (!raw.startsWith('enc:')) throw new Error('Usage ledger is not encrypted')
    let legacy = JSON.parse(codec.decrypt(Buffer.from(raw.slice(4), 'base64')))
    if (legacy.kind) {
      if (legacy.kind !== 'valley.plugin.sealed.v1' || legacy.owner !== 'assistant' || legacy.purpose !== 'usage') throw new Error('Usage owner mismatch')
      legacy = legacy.value
    }
    if (!Array.isArray(legacy.entries) || !legacy.budget) throw new Error('Invalid usage ledger')
    const current = decodeMap(usageTarget, codec)
    if (current.ledger && JSON.parse(current.ledger).entries.length) throw new Error('Core usage already exists; reconcile before transfer')
    const ledger = { ...legacy, entries: legacy.entries.map((entry, index) => ({ ...entry, requestId: entry.requestId ?? `legacy-${hash(bytes).slice(0, 16)}-${index}`, pluginId: 'assistant', operation: 'legacy.chat', connectionId: entry.connectionId ?? entry.provider, status: 'completed' })) }
    output(usageTarget, encoded(encryptMap({ ...current, ledger: JSON.stringify(ledger) }, codec)), true); removals.add(usageSource)
  }
  move(path.join(old, 'guards.json'), path.join(vault, '.valley/security/guards.json'))
  move(path.join(old, 'guard-audit.jsonl'), path.join(vault, '.valley/security/guard-audit.jsonl'))
  for (const [from, to] of [['rules', 'rules'], ['runtime', 'runtime'], ['harness', 'evaluations'], ['harness-runs', 'evaluation-runs']]) tree(path.join(old, from), path.join(home, to))
  move(path.join(old, 'harness-settings.json'), path.join(home, 'evaluation-settings.json'))
  move(path.join(old, 'channels.json'), path.join(home, 'channels.json'))
  const chorus = path.join(vault, 'Meadow/Chorus')
  tree(path.join(chorus, 'Personalities'), path.join(home, 'personalities'))
  tree(path.join(chorus, 'Toolbox'), path.join(home, 'toolbox'))
  move(path.join(chorus, 'commands.json'), path.join(home, 'commands.json'))
  const chats = new Map(), chatLinks = new Map(), attachments = new Map(), references = []
  for (const base of [path.join(chorus, 'Chats'), path.join(chorus, 'Channels')]) for (const file of files(base).filter(file => file.endsWith('/settings.json'))) {
    const meta = json(file, {})
    if (!segment(meta.id) || meta.channelId && !segment(meta.channelId)) throw new Error('Invalid legacy conversation identity')
    if (chats.has(meta.id)) throw new Error('Duplicate legacy conversation ID')
    const from = path.dirname(file), to = meta.source && meta.channelId && meta.chatRef ? path.join(home, 'channels', meta.channelId, meta.id) : path.join(home, 'chats', meta.id)
    const link = { url: buildPluginOpenUrl('assistant', { chatId: meta.id }), title: meta.title || meta.id }
    for (const directory of [from, to]) for (const name of ['', 'thread.jsonl', 'settings.json']) chatLinks.set(path.relative(vault, path.join(directory, name)).split(path.sep).join('/'), link)
    chats.set(meta.id, to); tree(from, to)
    const transcript = path.join(to, 'thread.jsonl'), bytes = outputs.get(transcript)
    if (!bytes) continue
    const messages = bytes.toString().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    let changed = false
    for (const [index, message] of messages.entries()) {
      for (const item of message.attachments ?? []) {
        if (typeof item.path !== 'string') { unresolved.push({ chatId: meta.id, message: index, reason: 'Attachment has no source path; files preserved' }); continue }
        const relative = item.path.replace(/\\/g, '/')
        if (path.isAbsolute(relative) || relative.split('/').includes('..')) { unresolved.push({ chatId: meta.id, message: index, reason: 'Attachment path is outside the vault; preserved' }); continue }
        const source = safe(path.join(vault, relative))
        if (!exists(source) || !fs.statSync(source).isFile()) { unresolved.push({ chatId: meta.id, message: index, path: relative, reason: 'Attachment source is unavailable' }); continue }
        let record = attachments.get(relative)
        if (!record) { record = { id: randomUUID(), path: relative, fileName: item.fileName ?? path.basename(relative), mime: item.mime ?? '', kind: item.kind ?? 'file', owned: false, sha256: hash(capture(source)), state: 'ready', createdAt: Number(meta.createdAt) || 0 }; attachments.set(relative, record) }
        message.attachmentIds = [...new Set([...(message.attachmentIds ?? []), record.id])]
        if (!references.some(ref => ref.chatId === meta.id && ref.attachmentId === record.id)) references.push({ chatId: meta.id, attachmentId: record.id })
        unresolved.push({ chatId: meta.id, message: index, path: relative, reason: 'Source ownership is uncertain; reference retained without deletion rights' })
        changed = true
      }
      if (!message.attachments?.length && typeof message.content === 'string' && /\[(?:attachment|image|file)|!\[\[/i.test(message.content)) unresolved.push({ chatId: meta.id, message: index, reason: 'Message may refer to an attachment without a recorded source; preserved' })
    }
    if (changed) outputs.set(transcript, Buffer.from(messages.map(message => JSON.stringify(message)).join('\n') + '\n'))
  }
  const linkedChat = target => {
    try { return chatLinks.get(decodeURIComponent(target).replace(/^\.\//, '')) } catch { return undefined }
  }
  const rewrite = text => {
    text = text.replace(/!?\[\[([^\]]+)\]\]/g, (original, target) => {
      const [file, alias] = target.split('|'), link = linkedChat(file)
      return link ? `[${String(alias || link.title).replace(/[\\[\]]/g, '\\$&')}](${link.url})` : original
    }).replace(/(\[[^\]]*\]\()([^\s)]+)(\))/g, (original, before, target, after) => {
      const link = linkedChat(target)
      return link ? before + link.url + after : original
    })
    for (const [from, to] of [...moves].sort((a, b) => b[0].length - a[0].length)) text = text.split(from).join(to).split(encodeURI(from)).join(encodeURI(to))
    return text
  }
  const rewriteValues = value => typeof value === 'string' ? rewrite(value) : Array.isArray(value) ? value.map(rewriteValues) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, rewriteValues(value)])) : value
  for (const [file, bytes] of outputs) if (/\.(?:jsonl?|md)$/.test(file) && file.startsWith(vault + path.sep)) {
    const text = bytes.toString()
    const updated = file.endsWith('.jsonl') ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.stringify(rewriteValues(JSON.parse(line)))).join('\n') + (text.trim() ? '\n' : '') : file.endsWith('.json') ? JSON.stringify(rewriteValues(JSON.parse(text)), null, 2) + '\n' : rewrite(text)
    outputs.set(file, Buffer.from(updated))
  }
  for (const entry of fs.readdirSync(vault, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || blocked(entry.name)) continue
    const entryPath = path.join(vault, entry.name)
    const candidates = entry.isDirectory() ? files(entryPath) : entry.isFile() ? [entryPath] : []
    for (const file of candidates) if (/\.md$/i.test(file) && !removals.has(file)) {
      const text = fs.readFileSync(safe(file), 'utf8'), updated = rewrite(text)
      if (updated !== text) output(file, updated, true)
    }
  }
  const records = { version: 1, attachments: [...attachments.values()].map(record => {
    const transferred = moves.get(record.path)
    return transferred ? { ...record, path: transferred, sha256: hash(outputs.get(path.join(vault, transferred))) } : record
  }), references }
  output(path.join(home, 'transfer-records.json'), encoded(records))
  output(path.join(home, 'transfer-report.json'), encoded({ version: 1, conversations: chats.size, unresolved }))
  const id = randomUUID()
  output(marker, encoded({ version: 1, id, backupDirectory: backup }))
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  const plan = { version: 1, id, vaultRoot: vault, userData: device, marker, sources: [], writes: [], removals: [...removals], unresolved, state: 'prepared' }
  let index = 0
  for (const [file, bytes] of sources) {
    const saved = `source/${index++}`
    if (bytes) write(path.join(backup, saved), bytes)
    plan.sources.push({ path: file, sha256: bytes ? hash(bytes) : null, backup: bytes ? saved : null })
  }
  index = 0
  for (const [file, bytes] of outputs) {
    const staged = `staged/${index++}`; write(path.join(backup, staged), bytes)
    plan.writes.push({ path: file, sha256: hash(bytes), staged })
  }
  write(path.join(backup, 'plan.json'), encoded(plan))
  verifyBackup(backup, plan)
  return { id, writes: plan.writes.length, removals: plan.removals.length, conversations: chats.size, unresolved }
}
function verifyBackup(backup, plan) {
  for (const source of plan.sources) if (source.backup && hash(fs.readFileSync(safe(path.join(backup, source.backup)))) !== source.sha256) throw new Error('Recovery backup verification failed')
  for (const item of plan.writes) if (hash(fs.readFileSync(safe(path.join(backup, item.staged)))) !== item.sha256) throw new Error('Staged output verification failed')
}
export function applyTransfer(backupDirectory, { afterWrite } = {}) {
  const backup = safe(backupDirectory), plan = json(path.join(backup, 'plan.json'), null)
  if (!plan || plan.version !== 1) throw new Error('Unsupported transfer plan')
  verifyBackup(backup, plan)
  for (const source of plan.sources) {
    safe(source.path)
    const actual = exists(source.path) ? hash(fs.readFileSync(source.path)) : null
    const next = plan.writes.find(item => item.path === source.path)?.sha256
    if (actual !== source.sha256 && actual !== next && !(actual === null && plan.state !== 'prepared' && plan.removals.includes(source.path))) throw new Error('Source changed after preparation; transfer stopped')
  }
  plan.state = 'applying'; write(path.join(backup, 'plan.json'), encoded(plan))
  const ordinary = plan.writes.filter(item => item.path !== plan.marker)
  for (const item of ordinary) {
    write(item.path, fs.readFileSync(path.join(backup, item.staged)))
    if (hash(fs.readFileSync(item.path)) !== item.sha256) throw new Error('Written output verification failed')
    afterWrite?.(item)
  }
  for (const item of ordinary) if (hash(fs.readFileSync(item.path)) !== item.sha256) throw new Error('Destination changed during transfer')
  for (const file of plan.removals) if (exists(file)) fs.unlinkSync(safe(file))
  const marker = plan.writes.find(item => item.path === plan.marker)
  write(marker.path, fs.readFileSync(path.join(backup, marker.staged)))
  plan.state = 'complete'; write(path.join(backup, 'plan.json'), encoded(plan))
  return { id: plan.id, state: plan.state, writes: plan.writes.length, unresolved: plan.unresolved }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return at < 0 ? [value.replace(/^--/, ''), true] : [value.slice(2, at), value.slice(at + 1)] }))
  try {
    if (!args.backup) throw new Error('Pass --backup=/absolute/recovery/directory')
    if (args.apply) console.log(JSON.stringify(applyTransfer(args.backup)))
    else {
      if (!args.vault || !args['user-data']) throw new Error('Pass --vault and --user-data explicitly; keep Valley closed')
      const { app, safeStorage } = await import('electron')
      app.setName('Valley'); app.setPath('userData', safe(args['user-data'])); await app.whenReady()
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable')
      console.log(JSON.stringify(prepareTransfer({ vaultRoot: args.vault, userData: args['user-data'], backupDirectory: args.backup, codec: { encrypt: value => safeStorage.encryptString(value), decrypt: bytes => safeStorage.decryptString(bytes) } })))
      app.quit()
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; if (process.versions.electron) (await import('electron')).app.exit(1) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main()
