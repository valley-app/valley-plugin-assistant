import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { AttachmentReadResult } from '../../contracts/attachments'

export type PageVision = (base64: string, page: number, signal?: AbortSignal) => Promise<string>
export function needsVisualReading(text: string, width: number, height: number): boolean {
  const usable = [...text.replace(/[\s\uFFFD\u0000-\u001f]/g, '')].length
  const area = width * height / (72 * 72)
  return !usable || !Number.isFinite(area) || area <= 0 || usable / area < 8
}
export function rasterScale(width: number, height: number): number {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0) throw new Error('Invalid PDF page dimensions')
  return Math.min(150 / 72, Math.sqrt(4_000_000 / (width * height)))
}

export async function extractPdf(document: PDFDocumentProxy, options: { startPage?: number; mode?: 'auto' | 'text' | 'visual'; vision?: PageVision; signal?: AbortSignal } = {}): Promise<AttachmentReadResult> {
  const start = options.startPage ?? 1
  if (!Number.isInteger(start) || start < 1 || start > document.numPages) throw new Error('Requested PDF page does not exist')
  const pages: NonNullable<AttachmentReadResult['pages']> = [], warnings: string[] = []
  const end = Math.min(document.numPages, start + 9)
  for (let number = start; number <= end; number++) {
    options.signal?.throwIfAborted()
    const page = await document.getPage(number)
    try {
      const viewport = page.getViewport({ scale: 1 })
      let native = ''
      try {
        const content = await page.getTextContent()
        native = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
      } catch (error) { warnings.push(`Page ${number}: text extraction failed (${String(error)}).`) }
      const visual = options.mode === 'visual' || options.mode !== 'text' && needsVisualReading(native, viewport.width, viewport.height)
      if (!visual) { pages.push({ page: number, method: 'text', text: native }); continue }
      if (!options.vision) {
        const warning = `Page ${number}: visual content could not be read because no vision model is configured.`
        warnings.push(warning); pages.push({ page: number, method: 'unreadable', text: native, warning }); continue
      }
      const scaled = page.getViewport({ scale: rasterScale(viewport.width, viewport.height) })
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : globalThis.document?.createElement('canvas')
      if (!canvas) {
        const warning = `Page ${number}: a trusted canvas renderer is unavailable; original PDF and extracted text are preserved.`
        warnings.push(warning); pages.push({ page: number, method: 'unreadable', text: native, warning }); continue
      }
      canvas.width = Math.max(1, Math.floor(scaled.width)); canvas.height = Math.max(1, Math.floor(scaled.height))
      const task = page.render({ canvas: canvas as HTMLCanvasElement, viewport: scaled })
      const cancel = () => task.cancel()
      options.signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (options.signal?.aborted) cancel()
        await task.promise
        options.signal?.throwIfAborted()
        let base64: string
        if ('toDataURL' in canvas) base64 = canvas.toDataURL('image/png').split(',')[1]
        else {
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
          let binary = ''
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
          base64 = btoa(binary)
        }
        const text = await options.vision(base64, number, options.signal)
        pages.push({ page: number, method: 'vision', text })
      } catch (error) {
        options.signal?.throwIfAborted()
        const warning = `Page ${number}: visual reading failed (${String(error)}).`
        warnings.push(warning); pages.push({ page: number, method: 'unreadable', text: native, warning })
      } finally { options.signal?.removeEventListener('abort', cancel); canvas.width = 0; canvas.height = 0 }
    } finally { page.cleanup() }
  }
  return { text: pages.map(page => `[Page ${page.page}]\n${page.text}${page.warning ? `\n[WARNING: ${page.warning}]` : ''}`).join('\n\n'), pages, warnings, pageCount: document.numPages, ...(end < document.numPages ? { nextPage: end + 1 } : {}) }
}

export async function readPdf(bytes: Uint8Array, options: Parameters<typeof extractPdf>[1] = {}): Promise<AttachmentReadResult> {
  const pdfjs = await import('pdfjs-dist')
  const assets = new URL('./assets/pdf/', import.meta.url).href
  pdfjs.GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.mjs`
  options.signal?.throwIfAborted()
  const task = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`, maxImageSize: 4_000_000, canvasMaxAreaInBytes: 16_000_000, stopAtErrors: true, enableXfa: false })
  const abort = () => { void task.destroy() }
  options.signal?.addEventListener('abort', abort, { once: true })
  try { return await extractPdf(await task.promise, options) }
  finally { options.signal?.removeEventListener('abort', abort); await task.destroy() }
}
