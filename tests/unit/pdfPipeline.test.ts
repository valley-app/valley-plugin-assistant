import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdf, needsVisualReading, rasterScale } from '../../src/backend/attachments/pdfPipeline'
describe('PDF page reading', () => {
  it('uses one density heuristic and caps rasters at four megapixels', () => {
    expect(needsVisualReading('Moss', 612, 792)).toBe(true)
    expect(needsVisualReading('Moss '.repeat(500), 612, 792)).toBe(false)
    const scale = rasterScale(5000, 5000)
    expect(Math.floor(scale * 5000) ** 2).toBeLessThanOrEqual(4000000)
    expect(rasterScale(72, 72)).toBe(150 / 72)
  })
  it('returns specific unread-page warnings and a continuation after ten pages', async () => {
    let active = 0, maximum = 0
    const document = { numPages: 14, getPage: async (page: number) => {
      active++; maximum = Math.max(maximum, active)
      return { getViewport: () => ({ width: 612, height: 792 }), getTextContent: async () => ({ items: [{ str: page % 2 ? 'Moss '.repeat(500) : '', hasEOL: true }] }), cleanup: () => { active-- } }
    } } as unknown as PDFDocumentProxy
    const result = await extractPdf(document)
    expect(result.pages).toHaveLength(10)
    expect(result.nextPage).toBe(11)
    expect(result.warnings).toHaveLength(5)
    expect(result.warnings[0]).toContain('Page 2')
    expect(maximum).toBe(1)
    const controller = new AbortController(); controller.abort()
    await expect(extractPdf(document, { signal: controller.signal })).rejects.toThrow()
    expect(active).toBe(0)
  })
})
