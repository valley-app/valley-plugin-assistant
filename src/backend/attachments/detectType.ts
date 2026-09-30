import type { InboundAttachment } from '../../types'

export function detectType(bytes: Uint8Array, declared = ''): { mime: string; kind: InboundAttachment['kind'] } {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  let mime = 'application/octet-stream', kind: InboundAttachment['kind'] = 'file'
  if (header.startsWith('%PDF-')) { mime = 'application/pdf'; kind = 'pdf' }
  else if (bytes[0] === 137 && header.slice(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) { mime = 'image/png'; kind = 'image' }
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { mime = 'image/jpeg'; kind = 'image' }
  else if (/^GIF8[79]a/.test(header)) { mime = 'image/gif'; kind = 'image' }
  else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') { mime = 'image/webp'; kind = 'image' }
  else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WAVE') { mime = 'audio/wav'; kind = 'audio' }
  else if (header.startsWith('OggS')) { mime = declared.startsWith('video/') ? 'video/ogg' : 'audio/ogg'; kind = mime.startsWith('audio/') ? 'audio' : 'file' }
  else if (header.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) { mime = 'audio/mpeg'; kind = 'audio' }
  else if (header.startsWith('fLaC')) { mime = 'audio/flac'; kind = 'audio' }
  else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && header.includes('webm')) { mime = declared.startsWith('audio/') ? 'audio/webm' : 'video/webm'; kind = mime.startsWith('audio/') ? 'audio' : 'file' }
  else if (bytes[0] === 0x1f && bytes[1] === 0x8b && declared === 'application/x-tgsticker') mime = 'application/x-tgsticker'
  else if (header.slice(4, 8) === 'ftyp') { mime = declared.startsWith('audio/') ? 'audio/mp4' : 'video/mp4'; kind = mime.startsWith('audio/') ? 'audio' : 'file' }
  else if (header.startsWith('PK\x03\x04')) mime = 'application/zip'
  else if (!bytes.includes(0) && declared.startsWith('text/')) mime = declared
  const normalized = declared.split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg')
  if (normalized && /^(image\/|audio\/|application\/pdf$)/.test(normalized) && normalized !== mime) throw new Error(`Attachment signature does not match declared type ${normalized}`)
  return { mime, kind }
}
