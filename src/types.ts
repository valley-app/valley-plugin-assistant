import type { AiContinuation } from '@valley/plugin-sdk/ai'
import type { GuardOverrides, GuardPolicy } from '@valley/plugin-sdk/guard/types'

export type AiProviderId = string

export interface AiModelInfo {
  reasoningEfforts?: ReasoningEffort[]
  provider: AiProviderId
  id: string
  label?: string
    tools?: boolean
    web?: boolean
    contextWindow?: number
}

export interface AiProviderBalance {
    currency: string
    available: number
    granted?: number
    toppedUp?: number
}

export interface AiProviderStatus {
  provider: AiProviderId
  name?: string
  description?: string
  icon?: string
  capabilities?: string[]
    configured: boolean
    authMode?: 'env' | 'key' | 'none'
    authSources?: {
    envKey?: boolean
    savedKey?: boolean
        savedKeyUnreadable?: boolean
        savedKeyUnchecked?: boolean
  }
    baseUrl?: string
    models: AiModelInfo[]
}

export interface AiConnection {
    id: string
  provider: AiProviderId
    label?: string
    baseUrl?: string
    models?: { id: string; label?: string }[]
  createdAt: number
}

export interface AiConnectionStatus extends Omit<AiConnection, 'baseUrl' | 'models'> {
  providerName: string
  providerDescription: string
  providerIcon: string
  requiresKey: boolean
  providerSettingsUrl?: string
  providerCapabilities: string[]
    baseUrl: string
    configured: boolean
    authMode?: 'env' | 'key' | 'none'
  authSources?: {
    envKey?: boolean
    savedKey?: boolean
    savedKeyUnreadable?: boolean
    savedKeyUnchecked?: boolean
  }
    models: AiModelInfo[]
}

export interface AiProviderBalanceResult {
  provider: AiProviderId
    balance: AiProviderBalance | null
}

export interface AiOllamaStatus {
    running: boolean
    connected?: boolean
    version?: string
    models: string[]
    baseUrl: string
}

export interface AiProvidersStatus {
  providers: AiProviderStatus[]
}

export interface AiToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AiAttachment {
    mime: string
    dataBase64: string
}

export interface AiMessage {
  channelDeliveryId?: string
  ingestionState?: 'pending' | 'complete'
  voiceInput?: boolean
  id?: string
  continuation?: AiContinuation
  displayContent?: string
  attachmentFiles?: { fileName: string; path: string; kind: string; warning?: boolean; mime?: string; metadata?: import('./contracts/channel').ChannelMediaMetadata }[]
  activityRunId?: string
  attachmentIds?: string[]
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
    toolCalls?: AiToolCall[]
    toolCallId?: string
    name?: string
    attachments?: AiAttachment[]
    error?: boolean
    render?: 'quiz-image'
    ts?: number
}

export interface QuizChoice {
  value: string
  label: string
}

export interface QuizPrompt {
  source: string
  choices: QuizChoice[]
    imagePath?: string
}

export interface AiToolDef {
  name: string
  description: string
    parameters: Record<string, unknown>
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AiChatRequest {
    requestId: string
  provider: AiProviderId
    connectionId?: string
  model: string
  messages: AiMessage[]
  tools?: AiToolDef[]
    web?: boolean
  reasoningEffort?: ReasoningEffort
  temperature?: number
  maxTokens?: number
    baseUrl?: string
    origin?: 'ui' | 'channel' | 'harness'
    operation?: string
    conversationId?: string
}

export type AiStreamEvent =
  | { requestId: string; type: 'continuation'; continuation: AiContinuation }
  | { requestId: string; type: 'text'; text: string }
  | { requestId: string; type: 'tool_call'; call: AiToolCall }
  | { requestId: string; type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { requestId: string; type: 'done'; finishReason?: string }
  | { requestId: string; type: 'error'; error: string }

export interface AiUsageEntry {
    ts: number
  provider: AiProviderId
    connectionId?: string
  model: string
  inputTokens: number
  outputTokens: number
    costUsd: number
    origin: 'ui' | 'channel' | 'harness'
}

export interface AiUsageBucket {
  inputTokens: number
  outputTokens: number
  costUsd: number
    calls: number
}

export interface AiUsageDatedBucket extends AiUsageBucket {
    period: string
}

export interface AiUsageTrend {
    daily: AiUsageDatedBucket[]
    weekly: AiUsageDatedBucket[]
    monthly: AiUsageDatedBucket[]
}

export interface AiBudget {
  total?: number
  perProvider?: Partial<Record<AiProviderId, number>>
}

export interface AiUsageStats {
    month: AiUsageBucket
    allTime: AiUsageBucket
    byProvider: { provider: AiProviderId; month: AiUsageBucket; allTime: AiUsageBucket; trend: AiUsageTrend }[]
    byConnection: {
    connectionId: string
    provider: AiProviderId
    month: AiUsageBucket
    allTime: AiUsageBucket
    trend: AiUsageTrend
    lastUsedAt: number
  }[]
    byModel: { provider: AiProviderId; model: string; month: AiUsageBucket }[]
    byDay: { day: string; costUsd: number }[]
    trend: AiUsageTrend
  budget: AiBudget
    recentEntries: AiUsageEntry[]
    since: string | null
}

export interface AiCacheStats {
    hits: number
  savedInputTokens: number
  savedOutputTokens: number
  savedCostUsd: number
    entries: number
  byKind: { modelList: number; balance: number; completion: number }
}

export interface AiModelRef {
  provider: AiProviderId
  model: string
  connectionId?: string
}

export interface RoutingRule {
  label?: string
    match?: string[]
    kind?: string
    minComplexity?: number
  provider: AiProviderId
  model: string
  connectionId?: string
}

export interface RoutingConfig {
    auto: boolean
    default: AiModelRef
    fast?: AiModelRef
  rules: RoutingRule[]
}

export interface CustomCommand {
    name: string
    description?: string
    prompt: string
}

export type HarnessId = 'valley' | 'deepseek' | 'openai-modified'

export interface AssistantConfig {
  defaultHarness?: HarnessId
    instructions: string
    rules: { name: string; content: string; configurationRevision?: number }[]
  routing: RoutingConfig
    guard: GuardPolicy
    providers: AiProviderStatus[]
    connections: AiConnectionStatus[]
}

export type AiChatSource = 'telegram' | 'whatsapp'

export interface AssistantProject {
  configurationRevision?: number
  deleting?: boolean
  id: string
  name: string
  instructions: string
  folders: string[]
  createdAt: number
  updatedAt: number
}

export interface PendingMessage {
  id: string
  text: string
  attachments?: InboundAttachment[]
}

export interface AiChatThread {
  configurationRevision?: number
  channelSenderId?: string
  channelTopicId?: string
  channelChatType?: import('./contracts/channel').MessageDestination['chatType']
  configurationHash?: string
  titleOrigin?: 'manual' | 'generated' | 'fallback'
  titleRevision?: number
  instructionsPath?: string
  mode?: 'plan' | 'execute'
  plan?: { id: string; text: string; status: 'review' | 'changes' | 'approved'; revision?: number; artifactHash?: string; instructionSnapshotId?: string; directory?: string }
  pendingMessages?: PendingMessage[]

  harness?: HarnessId
  projectId?: string
  id: string
  title: string
  createdAt: number
  updatedAt: number
    model?: AiModelRef | null
    reasoningEffort?: ReasoningEffort
    profileId?: string
  messages: AiMessage[]
    source?: AiChatSource
    channelId?: string
    chatRef?: string
    channelName?: string
  channelIdentity?: string
    commands?: CustomCommand[]
    attachmentParser?: string
    quiz?: QuizPrompt | null
    pinned?: boolean
}

export interface AiChatSummary {
  preview?: string
  harness?: HarnessId
  projectId?: string
  id: string
  title: string
  updatedAt: number
    model?: AiModelRef | null
    reasoningEffort?: ReasoningEffort
    profileId?: string
    source?: AiChatSource
    channelId?: string
    channelName?: string
  channelIdentity?: string
    commands?: CustomCommand[]
    pinned?: boolean
}

export interface AiPersonality {
  configurationRevisions?: Record<string, number>
  configurationRevision?: number
  id: string
  name: string
    isDefault: boolean
  instructions: string
  routing: RoutingConfig
    instructionsPath?: string
    routingPath?: string
}

export interface AiMemoryEntry {
  id: string
  summary: string
    confidence?: number
    sourceChatId?: string
  createdAt: number
}

export type ChannelId = string

export interface ChannelInfo {
  configurationApplication?: { state: 'deferred'; reason: string }
  configurationRevisions?: Record<string, number>
  defaultHarness?: HarnessId
  id: ChannelId
    type: string
    name: string
  displayName: string
    configured: boolean
    running: boolean
    connected?: boolean
    allowFrom?: string[]
    defaultProfile?: string
    instructionsPath?: string
    defaultRouting?: RoutingConfig
    guard?: GuardOverrides
    commands?: CustomCommand[]
    attachmentParser?: string
  phoneNumberId?: string
  graphVersion?: string
  webhookPort?: number
  publicCallbackUrl?: string
  webhookLocalUrl?: string
    error?: string
}

export interface ChannelsInfo {
  configurationRevisions?: Record<string, number>
  channels: ChannelInfo[]
}

export interface ChannelMessage {
  questionId?: string
  chatType?: import('./contracts/channel').MessageDestination['chatType']
  contacts?: import('./contracts/channel').ContactCard[]
  location?: { latitude: number; longitude: number; name?: string; address?: string; livePeriod?: number }
  providerEventId?: string
  providerMessageId?: string
  senderId?: string
  topicId?: string
  channelId: ChannelId
    chatRef: string
    from?: string
  text: string
    data?: string
    attachments?: InboundAttachment[]
    ts: number
}

export interface InboundAttachment {
  metadata?: import('./contracts/channel').ChannelMediaMetadata
    id?: string
    kind: 'image' | 'pdf' | 'audio' | 'file'
    path: string
    fileName: string
    mime?: string
}
