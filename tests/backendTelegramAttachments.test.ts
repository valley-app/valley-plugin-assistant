import { describe, expect, it } from 'vitest'
import { parseAttachment, parseUpdates, pickTelegramMethod, toTelegramHtml } from '../src/backend/channels/telegram'

describe('pickTelegramMethod', () => {
  it('routes by file type', () => {
    expect(pickTelegramMethod('a/b.png')).toEqual({ method: 'sendPhoto', field: 'photo' })
    expect(pickTelegramMethod('song.mp3')).toEqual({ method: 'sendAudio', field: 'audio' })
    expect(pickTelegramMethod('clip.mp4')).toEqual({ method: 'sendVideo', field: 'video' })
    expect(pickTelegramMethod('field-guide.pdf')).toEqual({ method: 'sendDocument', field: 'document' })
    expect(pickTelegramMethod('notes.txt')).toEqual({ method: 'sendDocument', field: 'document' })
  })
})

describe('toTelegramHtml', () => {
  it('renders bold, italic and inline code as Telegram HTML', () => {
    expect(toTelegramHtml('**bold** and *italic* and `x`')).toBe('<b>bold</b> and <i>italic</i> and <code>x</code>')
  })

  it('escapes only the HTML-special characters in plain text', () => {
    expect(toTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('keeps code-block contents escaped and never reprocesses markup inside them', () => {
    expect(toTelegramHtml('```\n<b>**raw**</b>\n```')).toBe('<pre>&lt;b&gt;**raw**&lt;/b&gt;</pre>')
  })

  it('renders markdown links and collapses wikilinks to a bold label', () => {
    expect(toTelegramHtml('[site](https://a.com) and [[Note|alias]]')).toBe(
      '<a href="https://a.com">site</a> and <b>alias</b>'
    )
  })

  it('renders math as readable Unicode', () => {
    expect(toTelegramHtml('$x^2$')).toBe('x²')
  })
})

describe('parseAttachment', () => {
  it('picks the largest photo size as an image', () => {
    const spec = parseAttachment({
      photo: [
        { file_id: 'small', file_size: 100 },
        { file_id: 'big', file_size: 900 }
      ]
    })
    expect(spec).toMatchObject({ fileId: 'big', kind: 'image' })
  })

  it('classifies a PDF document and preserves video as a file attachment', () => {
    expect(parseAttachment({ document: { file_id: 'd', file_name: 'r.pdf' } })).toMatchObject({ kind: 'pdf' })
    expect(parseAttachment({ voice: { file_id: 'v' } })).toMatchObject({ kind: 'audio' })
    expect(parseAttachment({ video: { file_id: 'vid' } })).toMatchObject({ fileId: 'vid', fileName: 'vid.mp4', kind: 'file' })
  })
})

describe('parseUpdates with attachments', () => {
  it('carries an attachment spec + caption as the text', () => {
    const { messages } = parseUpdates({
      ok: true,
      result: [
        {
          update_id: 5,
          message: { chat: { id: 42 }, caption: 'look', photo: [{ file_id: 'p1', file_size: 10 }] }
        }
      ]
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('look')
    expect(messages[0].attachmentSpecs?.[0]).toMatchObject({ fileId: 'p1', kind: 'image' })
  })
})
