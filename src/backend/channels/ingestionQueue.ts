import path from 'path-browserify'
import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'
import * as fs from '../filesystem'
import { backendApi, VAULT_ROOT } from '../runtime'
import { importAttachmentFile } from '../attachments'
import type { ChannelInboundMessage, InboundMediaSpec } from './types'

export interface InboundMediaJob {
  id: string
  channelId: string
  message: ChannelInboundMessage
  state: 'PENDING' | 'DOWNLOADING' | 'READY' | 'DISPATCHING' | 'COMPLETE' | 'FAILED'
  attempts: number
  error?: string
  spool: Record<string, string>
}
export interface IngestionDependencies {
  download(channelId: string, media: InboundMediaSpec, signal: AbortSignal): Promise<{ response: Response; fileName: string; mime?: string; maxBytes: number }>
  receive(channelId: string, message: ChannelInboundMessage): Promise<void>
  error(channelId: string, error: string): void
}

export class InboundMediaQueue {
  private queued = new Set<string>()
  private active = new Map<string, { task: Promise<void>; abort: AbortController }>()
  private closed = false
  constructor(private repository: AssistantRepository, private dependencies: IngestionDependencies) {}

  private persist(job: InboundMediaJob) {
    return this.repository.data.transaction([{ dataset: 'inbound_media_jobs', operation: 'upsert', values: record(job.id, `channel:${job.channelId}:${job.message.chatRef}`, job.state, job) }])
  }

  async accept(channelId: string, message: ChannelInboundMessage): Promise<void> {
    if (this.closed) throw new Error('Channel ingestion is closing')
    if (!message.providerEventId) throw new Error('An inbound event requires a stable provider identity')
    const id = JSON.stringify([channelId, message.providerEventId])
    await runExclusive(`media-accept:${id}`, async () => {
      const existing = await this.repository.get<InboundMediaJob>('inbound_media_jobs', id)
      if (existing) return
      const job: InboundMediaJob = { id, channelId, message: { ...message, receivedAt: message.receivedAt ?? Date.now() }, state: 'PENDING', attempts: 0, spool: {} }
      await this.persist(job)
    })
    this.queued.add(id); this.pump()
  }

  async recover(): Promise<void> {
    for (const job of await this.repository.rows<InboundMediaJob>('inbound_media_jobs')) {
      if (job.state === 'COMPLETE' || job.state === 'FAILED') continue
      this.queued.add(job.id)
    }
    this.pump()
  }

  async retry(id: string): Promise<void> {
    await runExclusive(`media:${id}`, async () => {
      const job = await this.repository.get<InboundMediaJob>('inbound_media_jobs', id)
      if (!job || job.state !== 'FAILED') throw new Error('Only a failed media job can be retried')
      job.state = 'PENDING'; job.error = undefined; await this.persist(job)
    })
    this.queued.add(id); this.pump()
  }

  private pump(): void {
    if (this.closed) return
    while (this.active.size < 4 && this.queued.size) {
      const id = this.queued.values().next().value!
      this.queued.delete(id)
      if (this.active.has(id)) continue
      const abort = new AbortController()
      const task = this.process(id, abort.signal).finally(() => { this.active.delete(id); this.pump() })
      this.active.set(id, { task, abort })
      void task.catch(error => this.dependencies.error('', String(error)))
    }
  }

  private async writeSpool(file: string, response: Response, maxBytes: number, signal: AbortSignal): Promise<void> {
    const api = backendApi(), temporary = `${file}.part`
    const expected = Number(response.headers.get('content-length'))
    if (Number.isFinite(expected) && expected > maxBytes) { await response.body?.cancel(); throw new Error('Inbound media exceeds the configured limit') }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Inbound media has no body')
    await fs.mkdir(path.dirname(file), { recursive: true }, api)
    const location = await fs.storageLocation(temporary, 'write', api)
    let bytes = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        if (bytes + part.value.length > maxBytes) throw new Error('Inbound media exceeds the configured limit')
        for (let offset = 0; offset < part.value.length; offset += 65536) {
          signal.throwIfAborted()
          const chunk = part.value.subarray(offset, offset + 65536)
          let binary = ''
          for (let start = 0; start < chunk.length; start += 32768) binary += String.fromCharCode(...chunk.subarray(start, start + 32768))
          await api.storage.writeBytes(location, btoa(binary), bytes > 0)
          bytes += chunk.length
        }
      }
      if (!bytes) throw new Error('Inbound media is empty')
      signal.throwIfAborted()
      await fs.rename(temporary, file, api)
    } catch (error) { await reader.cancel().catch(() => undefined); await fs.rm(temporary, { force: true }, api).catch(() => undefined); throw error }
    finally { reader.releaseLock() }
  }

  private async process(id: string, signal: AbortSignal): Promise<void> {
    await runExclusive(`media:${id}`, async () => {
      const job = await this.repository.get<InboundMediaJob>('inbound_media_jobs', id)
      if (!job || job.state === 'COMPLETE' || job.state === 'FAILED') return
      try {
        signal.throwIfAborted(); job.attempts++; job.state = 'DOWNLOADING'; await this.persist(job)
        const ready = job.message.attachments ?? []
        for (const [index, spool] of Object.entries(job.spool)) if (Number(index) < ready.length) { await fs.rm(spool, { force: true }); delete job.spool[index] }
        for (let index = ready.length; index < (job.message.media?.length ?? 0); index++) {
          const media = job.message.media![index]
          signal.throwIfAborted()
          let fileName = media.fileName, mime = media.mime
          let spool = job.spool[index]
          const complete = spool ? await backendApi().storage.stat(await fs.storageLocation(spool, 'read')) : null
          if (!complete) {
            const downloaded = await this.dependencies.download(job.channelId, media, signal)
            signal.throwIfAborted(); fileName = downloaded.fileName; mime = downloaded.mime ?? mime
            const suffix = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.bin'
            spool ||= `${VAULT_ROOT}/.valley/plugins/data/assistant/media/inbound/${crypto.randomUUID()}${suffix}`
            job.spool[index] = spool; media.fileName = fileName; media.mime = mime
            await this.persist(job)
            await this.writeSpool(spool, downloaded.response, downloaded.maxBytes, signal)
          }
          signal.throwIfAborted()
          const exported = await backendApi().storage.exportFile(await fs.storageLocation(spool, 'read'))
          let attachment
          try { attachment = await importAttachmentFile({ fileHandle: exported.handle, fileName, mime, kind: media.kind }) }
          finally { await backendApi().files.release([exported.handle]) }

          ready.push({ ...attachment, metadata: { ...media.metadata, interpretation: media.metadata.media === 'sticker' || media.metadata.media === 'animation' ? 'pending' : media.metadata.interpretation } })
          job.message.attachments = ready; await this.persist(job)
          await fs.rm(job.spool[index], { force: true }); delete job.spool[index]; await this.persist(job)
        }
        signal.throwIfAborted(); job.state = 'READY'; await this.persist(job)
        job.state = 'DISPATCHING'; await this.persist(job)
        await this.dependencies.receive(job.channelId, job.message)
        job.state = 'COMPLETE'; job.error = undefined; await this.persist(job)
      } catch (error) {
        job.state = signal.aborted ? 'PENDING' : 'FAILED'; job.error = signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
        await this.persist(job)
        if (!signal.aborted) this.dependencies.error(job.channelId, job.error!)
      }
    })
  }

  async stop(): Promise<void> {
    this.closed = true; this.queued.clear()
    for (const active of this.active.values()) active.abort.abort()
    await Promise.allSettled([...this.active.values()].map(value => value.task))
  }
}
