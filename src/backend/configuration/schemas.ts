import { z } from 'zod'

export const modelSchema = z.object({ provider: z.string().min(1).max(64), model: z.string().min(1).max(512), connectionId: z.string().max(256).optional() }).strict()
export const routingSchema = z.object({ auto: z.boolean(), default: modelSchema, fast: modelSchema.optional(), rules: z.array(z.object({ label: z.string().optional(), match: z.array(z.string()).optional(), kind: z.string().optional(), minComplexity: z.number().optional(), provider: z.string(), model: z.string(), connectionId: z.string().optional() }).strict()).max(100) }).strict()
export const commandSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), description: z.string().optional(), prompt: z.string().trim().min(1) }).strict()
export const includesSchema = z.array(z.string().min(1).max(4096)).max(64).default([])
export const conversationSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  model: modelSchema.nullable().optional(), profileId: z.string().max(256).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  attachmentParser: z.string().max(512).optional(),
  commands: z.array(commandSchema).max(100).optional(),
  includes: includesSchema,
}).strict()

export const speechSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  provider: z.enum(['elevenlabs', 'openai']).default('elevenlabs'),
  transcriptionProvider: z.enum(['elevenlabs', 'openai']).optional(),
  connectionId: z.string().max(256).optional(), transcriptionConnectionId: z.string().max(256).optional(),
  voiceId: z.string().max(256).optional(), transcriptionModel: z.string().max(256).optional(),
  realtimeModel: z.string().max(256).optional(), synthesisModel: z.string().max(256).optional(),
  liveMode: z.enum(['hands-free', 'push-to-talk']).default('push-to-talk'),
  fallbackProvider: z.enum(['elevenlabs', 'openai']).nullable().default(null),
  replyWithVoice: z.boolean().default(true),
  includes: includesSchema,
}).strict()

export type SpeechSettings = z.infer<typeof speechSchema>
