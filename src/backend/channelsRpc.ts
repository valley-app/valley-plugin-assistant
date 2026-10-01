import { emitDriverEvent } from './runtime'
import { z } from 'zod'
import { channelManager, type ChannelConfigPatch } from './exports'
import { channelKey, channelSecretKey, setSecret } from './exports'
import { defineDriver, defineDriverMethod } from './contract'

/**
 * Channel-agnostic remote-messaging capability (Telegram and official WhatsApp
 * Cloud API). Tokens are write-only (encrypted via safeStorage). Inbound messages
 * arrive on the `channels`/`message` driver event; the renderer plugin runs the
 * agent loop and replies via `channels.send`.
 */
const channelId = z.string().min(1)
const expectedRevisions = z.record(z.number().int().nonnegative())
const provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const connectionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const modelRef = z.object({ provider, model: z.string(), connectionId: connectionId.optional() })
const guardEntry = z.object({
  decision: z.enum(['allow', 'confirm', 'deny']),
  allowPreApproval: z.boolean().optional()
})
const channelConfigPatch: z.ZodType<ChannelConfigPatch> = z.object({
  name: z.string().min(1).max(256).optional(),
  defaultHarness: z.enum(['valley', 'deepseek', 'openai-modified']).nullable().optional(),
  allowFrom: z.array(z.string()).optional(),
  defaultProfile: z.string().nullable().optional(),
  instructionsPath: z.string().nullable().optional(),
  defaultRouting: z.object({
    auto: z.boolean(),
    default: modelRef,
    fast: modelRef.optional(),
    rules: z.array(z.object({
      label: z.string().optional(),
      match: z.array(z.string()).optional(),
      kind: z.string().optional(),
      minComplexity: z.number().optional(),
      provider,
      model: z.string(),
      connectionId: connectionId.optional()
    }))
  }).nullable().optional(),
  guard: z.object({
    tools: z.record(guardEntry).optional(),
    commands: z.record(guardEntry).optional(),
    fileReadOverrides: z.record(guardEntry).optional(),
    fileWriteOverrides: z.record(guardEntry).optional(),
    blocked: z.array(z.string()).optional()
  }).nullable().optional(),
  commands: z.array(z.object({ name: z.string(), description: z.string().optional(), prompt: z.string() })).nullable().optional(),
  attachmentParser: z.string().nullable().optional(),
  phoneNumberId: z.string().nullable().optional(),
  graphVersion: z.string().nullable().optional(),
  webhookPort: z.number().nullable().optional(),
  publicCallbackUrl: z.string().nullable().optional()
})

export const channelsDriver = defineDriver({
  list: defineDriverMethod(z.object({}).optional(), async (root) => channelManager.listSnapshot(root)),
  add: defineDriverMethod(z.object({ type: z.string().min(1), name: z.string(), expectedRevisions }), async (root, payload) => {
      const { type, name } = payload
      const id = await channelManager.add(root, type, name, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return { id, ...await channelManager.listSnapshot(root) }
    }),
  remove: defineDriverMethod(z.object({ channelId, expectedRevisions }), async (root, payload) => {
      await channelManager.remove(root, payload.channelId, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  rename: defineDriverMethod(z.object({ channelId, name: z.string(), expectedRevisions }), async (root, payload) => {
      const { channelId: id, name } = payload
      await channelManager.rename(root, id, name, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  setSecret: defineDriverMethod(z.object({ channelId, secret: z.string() }), async (root, payload) => {
      const { channelId: id, secret } = payload
      await setSecret(root, channelKey(id), secret, await channelManager.credentialEndpoints(root, id))
      await channelManager.refresh(root, id)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  setSecretField: defineDriverMethod(z.object({ channelId, key: z.enum(['verifyToken', 'appSecret']), secret: z.string() }), async (root, payload) => {
      const { channelId: id, key, secret } = payload
      await setSecret(root, channelSecretKey(id, key), secret, await channelManager.credentialEndpoints(root, id))
      await channelManager.refresh(root, id)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  setConfig: defineDriverMethod(z.object({
      channelId,
      config: channelConfigPatch,
      expectedRevisions
    }), async (root, payload) => {
      const { channelId: id, config } = payload
      await channelManager.setConfig(root, id, config, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  start: defineDriverMethod(z.object({ channelId, expectedRevisions }), async (root, payload) => {
      await channelManager.start(root, payload.channelId, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  stop: defineDriverMethod(z.object({ channelId, expectedRevisions }), async (root, payload) => {
      await channelManager.stop(root, payload.channelId, payload.expectedRevisions)
      emitDriverEvent('channels', 'channels.changed', {})
      return channelManager.listSnapshot(root)
    }),
  send: defineDriverMethod(z.object({ channelId, chatRef: z.string(), text: z.string() }), async (root, payload) => {
      const { channelId: id, chatRef, text } = payload
      await channelManager.send(root, id, chatRef, text)
    }),
  sendButtons: defineDriverMethod(z.object({
      channelId,
      chatRef: z.string(),
      text: z.string(),
      buttons: z.array(z.object({ label: z.string(), value: z.string() }))
    }), async (root, payload) => {
      const { channelId: id, chatRef, text, buttons } = payload
      await channelManager.sendButtons(root, id, chatRef, text, buttons)
    }),
  sendAttachment: defineDriverMethod(z.object({ channelId, chatRef: z.string(), path: z.string(), caption: z.string().optional() }), async (root, payload) => {
      const { channelId: id, chatRef, path: filePath, caption } = payload
      await channelManager.sendAttachment(root, id, chatRef, filePath, caption)
    })
})
