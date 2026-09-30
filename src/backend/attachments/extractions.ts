import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'
interface Extraction { id: string; state: 'RUNNING' | 'COMPLETED' | 'UNKNOWN'; result?: { text: string; warnings?: string[]; nextPage?: number }; error?: string }
export class AttachmentExtractions {
  constructor(private repository: AssistantRepository) {}
  async read(id: string, conversationId: string, extract: () => Promise<NonNullable<Extraction['result']>>) {
    return runExclusive(`extraction:${id}`, async () => {
      const existing = await this.repository.get<Extraction>('attachment_extractions', id)
      if (existing?.state === 'COMPLETED') return existing.result!
      if (existing) throw new Error(existing.error ?? 'Extraction was interrupted and its provider outcome is unknown; automatic retry is blocked.')
      const value: Extraction = { id, state: 'RUNNING' }
      const persist = () => this.repository.data.transaction([{ dataset: 'attachment_extractions', operation: 'upsert', values: record(id, conversationId, value.state, value) }])
      await persist()
      try {
        const result = await extract()
        value.state = 'COMPLETED'; value.result = result
        await persist()
        return result
      } catch (error) {
        value.state = 'UNKNOWN'; value.error = `Extraction outcome is unknown; preserve the attachment and inspect before retrying: ${String(error)}`
        await persist()
        throw error
      }
    })
  }
}
