import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareTransfer, applyTransfer } from './transfer-assistant.mjs'
import { parseAppOpenTarget } from '@valley/plugin-sdk/paths'
const codec = { encrypt: value => Buffer.from('fixture:' + value), decrypt: bytes => { const text = bytes.toString(); if (!text.startsWith('fixture:')) throw new Error('Unreadable cipher'); return text.slice(8) } }
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-transfer-'))), vaultRoot = path.join(directory, 'vault'), userData = path.join(directory, 'device'), backupDirectory = path.join(directory, 'backup')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultId = randomUUID()
  const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)) }
  put(path.join(vaultRoot, '.valley/settings/app.json'), { vaultId, layoutVersion: 2 })
  put(path.join(vaultRoot, '.valley/assistant/assistant.json'), { connections: [{ id: 'work', provider: 'openai', baseUrl: 'https://example.test/v1', createdAt: 42 }] })
  put(path.join(vaultRoot, '.valley/assistant/provider-secrets.json'), { 'provider:work': codec.encrypt('fixture-key').toString('base64') })
  put(path.join(vaultRoot, '.valley/assistant/secrets.json'), { 'channel:bot': codec.encrypt('channel-token').toString('base64') })
  put(path.join(vaultRoot, '.valley/assistant/guards.json'), { commands: { 'project.execute': { decision: 'deny' } } })
  put(path.join(userData, 'assistant/usage.json'), 'enc:' + codec.encrypt(JSON.stringify({ kind: 'valley.plugin.sealed.v1', owner: 'assistant', purpose: 'usage', value: { entries: [{ ts: 1, provider: 'openai', connectionId: 'work', model: 'exact', inputTokens: 2, outputTokens: 3, costUsd: 1 }], budget: { total: 5 } } })).toString('base64'))
  for (const id of ['one', 'two']) {
    put(path.join(vaultRoot, `Meadow/Chorus/Chats/${id}/settings.json`), { id, title: 'Grüße', createdAt: 1, updatedAt: 2, model: { provider: 'openai', connectionId: 'work', model: 'exact' } })
    put(path.join(vaultRoot, `Meadow/Chorus/Chats/${id}/thread.jsonl`), JSON.stringify({ role: 'user', content: 'See flower', attachments: [{ path: 'custom/inbox/flower.txt', kind: 'file' }] }) + '\n' + JSON.stringify({ role: 'user', content: '[Attachment: unknown.pdf]', attachments: [{ mime: 'application/pdf', dataBase64: 'YQ==' }] }) + '\n')
  }
  put(path.join(vaultRoot, 'custom/inbox/flower.txt'), 'Blüten ä ö ü')
  put(path.join(vaultRoot, 'Index.md'), '[[Meadow/Chorus/Chats/one/thread.jsonl]]')
  put(path.join(vaultRoot, '.valley/plugins/data/assistant/settings.json'), { attachmentFolder: 'custom/inbox' })
  return { directory, vaultRoot, userData, backupDirectory, codec, put, vaultId }
}
test('backs up and transfers IDs, credentials, budgets, Guards, links and shared uncertain attachment references', t => {
  const f = fixture(t), result = prepareTransfer(f)
  assert.equal(result.conversations, 2)
  const original = fs.readFileSync(path.join(f.vaultRoot, '.valley/assistant/provider-secrets.json'))
  assert.equal(fs.existsSync(path.join(f.vaultRoot, '.valley/ai/connections.json')), false)
  assert.equal(applyTransfer(f.backupDirectory).state, 'complete')
  const home = path.join(f.vaultRoot, '.valley/plugins/data/assistant')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.vaultRoot, '.valley/ai/connections.json')))[0].id, 'work')
  const secrets = JSON.parse(fs.readFileSync(path.join(f.userData, 'vaults', f.vaultId, 'credentials/ai.json')))
  assert.equal(codec.decrypt(Buffer.from(secrets['provider:work'], 'base64')), 'fixture-key')
  const channels = JSON.parse(fs.readFileSync(path.join(f.userData, 'vaults', f.vaultId, 'credentials/plugin/assistant/credentials.json')))
  assert.deepEqual(JSON.parse(codec.decrypt(Buffer.from(channels['channel:bot'], 'base64'))), { value: 'channel-token' })
  const ledger = JSON.parse(codec.decrypt(Buffer.from(JSON.parse(fs.readFileSync(path.join(f.userData, 'ai/usage.json'))).ledger, 'base64')))
  assert.equal(ledger.budget.total, 5); assert.equal(ledger.entries[0].connectionId, 'work')
  const link = fs.readFileSync(path.join(f.vaultRoot, 'Index.md'), 'utf8').match(/\((valley:\/\/[^)]+)\)/)[1]
  assert.deepEqual(parseAppOpenTarget(link), { kind: 'plugin', pluginId: 'assistant', state: { chatId: 'one' } })
  assert.equal(fs.readFileSync(path.join(f.vaultRoot, 'custom/inbox/flower.txt'), 'utf8'), 'Blüten ä ö ü')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).attachmentFolder, 'custom/inbox')
  const records = JSON.parse(fs.readFileSync(path.join(home, 'transfer-records.json')))
  assert.equal(records.attachments.length, 1); assert.equal(records.references.length, 2); assert.equal(records.attachments[0].owned, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.vaultRoot, '.valley/security/guards.json'))).commands['project.execute'].decision, 'deny')
  const plan = JSON.parse(fs.readFileSync(path.join(f.backupDirectory, 'plan.json')))
  const saved = plan.sources.find(source => source.path.endsWith('/provider-secrets.json'))
  assert.deepEqual(fs.readFileSync(path.join(f.backupDirectory, saved.backup)), original)
  assert.throws(() => prepareTransfer({ ...f, backupDirectory: path.join(f.directory, 'second') }), /already transferred/)
})
test('resumes interrupted application from verified staged bytes', t => {
  const f = fixture(t); prepareTransfer(f)
  let writes = 0
  assert.throws(() => applyTransfer(f.backupDirectory, { afterWrite: () => { if (++writes === 3) throw new Error('simulated crash') } }), /simulated crash/)
  assert.equal(fs.existsSync(path.join(f.vaultRoot, '.valley/assistant/assistant.json')), true)
  assert.equal(applyTransfer(f.backupDirectory).state, 'complete')
})
test('copies the matching account credential into core AI while retaining the account', t => {
  const f = fixture(t)
  const accounts = path.join(f.userData, 'vaults', f.vaultId, 'credentials/accounts.json')
  f.put(path.join(f.vaultRoot, '.valley/accounts/connections.json'), { accounts: [{ id: 'work', kind: 'api-key', provider: 'openai' }, { id: 'unrelated', kind: 'api-key', provider: 'github' }] })
  const original = { work: codec.encrypt(JSON.stringify({ kind: 'api-key', value: 'account-priority' })).toString('base64'), unrelated: codec.encrypt(JSON.stringify({ kind: 'api-key', value: 'unrelated' })).toString('base64') }
  f.put(accounts, original)
  prepareTransfer(f); applyTransfer(f.backupDirectory)
  const ai = JSON.parse(fs.readFileSync(path.join(f.userData, 'vaults', f.vaultId, 'credentials/ai.json')))
  assert.equal(codec.decrypt(Buffer.from(ai['provider:work'], 'base64')), 'account-priority')
  assert.equal(ai['provider:unrelated'], undefined)
  assert.deepEqual(JSON.parse(fs.readFileSync(accounts)), original)
})
test('keeps moved attachment references and quoted conversation links resolvable', t => {
  const f = fixture(t), old = 'Meadow/Chorus/Chats/one'
  f.put(path.join(f.vaultRoot, old, 'local.txt'), 'attachment bytes')
  f.put(path.join(f.vaultRoot, old, 'thread.jsonl'), JSON.stringify({ role: 'user', content: '[[Meadow/Chorus/Chats/two/thread.jsonl|Say "Grüße"]]', attachments: [{ path: old + '/local.txt', kind: 'file' }] }) + '\n')
  prepareTransfer(f); applyTransfer(f.backupDirectory)
  const home = path.join(f.vaultRoot, '.valley/plugins/data/assistant')
  const records = JSON.parse(fs.readFileSync(path.join(home, 'transfer-records.json')))
  const attachment = records.attachments.find(record => record.fileName === 'local.txt')
  assert.equal(fs.readFileSync(path.join(f.vaultRoot, attachment.path), 'utf8'), 'attachment bytes')
  const message = JSON.parse(fs.readFileSync(path.join(home, 'chats/one/thread.jsonl'), 'utf8').trim())
  assert.match(message.content, /Say "Grüße"/)
  assert.equal(parseAppOpenTarget(message.content.match(/\((valley:\/\/[^)]+)\)/)[1]).state.chatId, 'two')
  assert.equal(attachment.owned, false)
})
test('rejects changes after preparation and corrupted recovery backups', t => {
  const f = fixture(t); prepareTransfer(f)
  f.put(path.join(f.vaultRoot, '.valley/assistant/assistant.json'), { connections: [] })
  assert.throws(() => applyTransfer(f.backupDirectory), /Source changed/)
  f.put(path.join(f.backupDirectory, 'source/0'), 'corrupted backup')
  assert.throws(() => applyTransfer(f.backupDirectory), /backup verification/)
})
test('refuses unreadable credentials, conflicting policy and unported custom provider before ownership changes', t => {
  const f = fixture(t)
  f.put(path.join(f.vaultRoot, '.valley/security/guards.json'), { commands: {} })
  assert.throws(() => prepareTransfer(f), /Destination already/)
  fs.unlinkSync(path.join(f.vaultRoot, '.valley/security/guards.json'))
  f.put(path.join(f.vaultRoot, '.valley/assistant/providers/custom/manifest.json'), { id: 'custom', enabled: true })
  assert.throws(() => prepareTransfer(f), /custom provider/)
  fs.unlinkSync(path.join(f.vaultRoot, '.valley/assistant/providers/custom/manifest.json'))
  f.put(path.join(f.vaultRoot, '.valley/assistant/provider-secrets.json'), { 'provider:work': Buffer.from('bad').toString('base64') })
  assert.throws(() => prepareTransfer(f), /Unreadable cipher/)
  assert.equal(fs.existsSync(path.join(f.vaultRoot, '.valley/ai/connections.json')), false)
})
test('rejects symlink inputs without reading their targets', t => {
  const f = fixture(t)
  fs.symlinkSync(path.join(f.directory, 'outside'), path.join(f.vaultRoot, 'Meadow/Chorus/Chats/one/link'))
  assert.throws(() => prepareTransfer(f), /symbolic links/)
})
test('does not trust a built-in provider name or an installed digest for modified source', t => {
  const f = fixture(t)
  f.put(path.join(f.vaultRoot, '.valley/assistant/providers/deepseek/manifest.json'), { id: 'deepseek', enabled: true })
  f.put(path.join(f.vaultRoot, '.valley/assistant/providers.lock.json'), { installed: { deepseek: { digest: '80fbe3b1ab60f76c2e348d3bb8689b94fadd9871ed0f07b24e0bd6c455a1c7f3' } } })
  assert.throws(() => prepareTransfer(f), /custom provider/)
  assert.equal(fs.existsSync(path.join(f.vaultRoot, '.valley/ai/connections.json')), false)
})
test('transfers empty pre-connection settings without dropping configured legacy models', t => {
  const f = fixture(t), source = path.join(f.vaultRoot, '.valley/assistant/assistant.json')
  f.put(source, { baseUrls: {}, models: { deepseek: 'selected-model' } })
  assert.throws(() => prepareTransfer(f), /Invalid legacy connections/)
  f.put(source, { baseUrls: {}, models: {} })
  prepareTransfer(f); applyTransfer(f.backupDirectory)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.vaultRoot, '.valley/ai/connections.json'))), [])
})
