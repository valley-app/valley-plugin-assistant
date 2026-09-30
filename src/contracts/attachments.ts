export const ATTACHMENT_LIMIT = 32 * 1024 * 1024
export interface AttachmentReadResult {
  text: string
  warnings: string[]
  pages?: Array<{ page: number; method: 'text' | 'vision' | 'unreadable'; text: string; warning?: string }>
  pageCount?: number
  nextPage?: number
}
