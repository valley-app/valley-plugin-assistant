import { channelManager } from '../channels/manager'
import { z } from 'zod'
import type { ConfigurationApi } from './documents'
import { channelConfigurationRevisions, channelSchema, readChannelConfigurations, writeChannelConfigurations } from './channels'
import { commandSchema, routingSchema } from './schemas'
import { deletePersonality, listPersonalities, readCommandsSnapshot, readPersonality, readRules, saveCommands, savePersonality, writeRule } from '../store'

const revision = z.number().int().nonnegative()
const revisions = z.record(revision)
const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const guardEntry = z.object({ decision: z.enum(['allow', 'confirm', 'deny']), allowPreApproval: z.boolean().optional() }).strict()
const guard = z.object({ tools: z.record(guardEntry).optional(), commands: z.record(guardEntry).optional(), fileReadOverrides: z.record(guardEntry).optional(), fileWriteOverrides: z.record(guardEntry).optional(), blocked: z.array(z.string()).optional() }).strict()
const profile = z.object({ id: identity, name: z.string().min(1).max(256), isDefault: z.boolean(), instructions: z.string().max(500000), routing: routingSchema, configurationRevision: revision, configurationRevisions: revisions.optional(), instructionsPath: z.string().optional(), routingPath: z.string().optional(), schemaVersion: z.literal(1).optional(), includes: z.array(z.string()).optional() }).strict()
export const configurationDomainSchemas = {
  'configuration.profiles': z.object({}).strict(),
  'configuration.profile': z.object({ id: identity }).strict(),
  'configuration.profile.save': z.object({ personality: profile }).strict(),
  'configuration.profile.delete': z.object({ id: identity, expectedRevision: revision }).strict(),
  'configuration.commands': z.object({}).strict(),
  'configuration.commands.set': z.object({ commands: z.array(commandSchema).max(100), expectedRevisions: revisions }).strict(),
  'configuration.channels': z.object({}).strict(),
  'configuration.channels.set': z.object({ connections: z.record(identity, channelSchema.omit({ includes: true }).extend({ guard: guard.optional() })), expectedRevisions: revisions }).strict(),
  'configuration.rules': z.object({}).strict(),
  'configuration.rule.set': z.object({ name: identity, content: z.string().max(500000), expectedRevision: revision }).strict()
}

export function configurationDomainHandlers(root: string, api: ConfigurationApi): Record<keyof typeof configurationDomainSchemas, (input: unknown) => Promise<unknown>> {
  const channels = async () => {
    const connections = await readChannelConfigurations<Record<string, object>>(root, {}, api)
    return { connections, configurationRevisions: channelConfigurationRevisions(connections) }
  }
  return {
    'configuration.profiles': async input => { configurationDomainSchemas['configuration.profiles'].parse(input ?? {}); return { personalities: await listPersonalities(root, api) } },
    'configuration.profile': async input => { const value = configurationDomainSchemas['configuration.profile'].parse(input); return { personality: await readPersonality(root, value.id, api) } },
    'configuration.profile.save': async input => { const value = configurationDomainSchemas['configuration.profile.save'].parse(input); await savePersonality(root, value.personality, api); return { personality: await readPersonality(root, value.personality.id, api) } },
    'configuration.profile.delete': async input => { const value = configurationDomainSchemas['configuration.profile.delete'].parse(input); await deletePersonality(root, value.id, value.expectedRevision, api); return null },
    'configuration.commands': async input => { configurationDomainSchemas['configuration.commands'].parse(input ?? {}); return readCommandsSnapshot(root, api) },
    'configuration.commands.set': async input => { const value = configurationDomainSchemas['configuration.commands.set'].parse(input); await saveCommands(root, value.commands, value.expectedRevisions, api); return readCommandsSnapshot(root, api) },
    'configuration.channels': async input => { configurationDomainSchemas['configuration.channels'].parse(input ?? {}); return channels() },
    'configuration.channels.set': async input => { const value = configurationDomainSchemas['configuration.channels.set'].parse(input); const previous = await readChannelConfigurations<Record<string, object>>(root, {}, api); await writeChannelConfigurations(root, value.connections, value.expectedRevisions, api); const application = await channelManager.reconcileConfiguration(root, previous, api); return { ...await channels(), application } },
    'configuration.rules': async input => { configurationDomainSchemas['configuration.rules'].parse(input ?? {}); return { rules: await readRules(root, api) } },
    'configuration.rule.set': async input => { const value = configurationDomainSchemas['configuration.rule.set'].parse(input); await writeRule(root, value.name, value.content, value.expectedRevision, api); return null }
  }
}
