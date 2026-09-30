// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFile } from 'fs/promises'
import { resolve } from 'path'

/**
 * Guard: the assistant chat must reflow to its OWN width, not the window's.
 *
 * The chat (`assistant.page`) can mount in a narrow workspace pane or sidebar
 * inside a wide window. A viewport `@media (max-width:…)` can't see that — it
 * only fires when the whole window is narrow — so bubbles and the composer used
 * to clip off the right edge of a narrow pane. The fix is CSS container queries
 * (`container-type` on `.assistant-page` + `@container`/`cqi` units), which key
 * off the element's own inline size. Don't regress back to `vw`/`@media` as the
 * primary mechanism (a viewport `@media` survives only inside the
 * `@supports not (container-type:…)` fallback).
 */
const STYLES = resolve(__dirname, '..', 'src', 'styles.ts')

describe('assistant chat responsive layout', () => {
  it('keys reflow to the chat container, not the viewport', async () => {
    const css = await readFile(STYLES, 'utf8')

    // The page is a query container.
    expect(css).toMatch(/\.assistant-page\b[^}]*container-type:\s*inline-size/)
    expect(css).toMatch(/container-name:\s*assistant-page/)

    // Container queries drive the breakpoints (phone tier included).
    expect(css).toContain('@container assistant-page (max-width:720px)')
    expect(css).toContain('@container assistant-page (max-width:460px)')

    // Horizontal padding/margins scale with the container (cqi), never the viewport.
    expect(css).toContain('clamp(16px,4cqi,48px)')
    expect(css).not.toMatch(/clamp\([^)]*\dvw/)

    // A bare viewport @media may only survive as the no-container-query fallback.
    const fallback = css.slice(css.indexOf('@supports not (container-type:inline-size)'))
    const mediaMatches = [...css.matchAll(/@media \(max-width:720px\)/g)]
    expect(mediaMatches).toHaveLength(1)
    expect(fallback).toContain('@media (max-width:720px)')
  })
})
