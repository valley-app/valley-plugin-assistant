import type { ChannelKind, MessageContent } from '../../contracts/channel'

const symbols: Record<string, string> = { pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', cdot: '*', times: '×', div: '÷', pm: '±', leq: '≤', geq: '≥', neq: '≠', approx: '≈', infty: '∞', to: '→', rightarrow: '→', partial: '∂', nabla: '∇', sum: '∑', int: '∫' }
const superscript: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' }

export function simplifyLatex(source: string): string {
  if (source.length > 32000) return source
  let cursor = 0
  function group(depth: number): string {
    while (source[cursor] === ' ') cursor++
    if (source[cursor] !== '{') return source[cursor++] ?? ''
    cursor++
    return read(depth + 1, true)
  }
  function read(depth: number, grouped = false): string {
    if (depth > 32) throw new Error('Math nesting limit')
    let out = ''
    while (cursor < source.length) {
      const ch = source[cursor++]
      if (ch === '}' && grouped) return out
      if (ch === '{') { out += `(${read(depth + 1, true)})`; continue }
      if (ch === '^' || ch === '_') {
        const value = group(depth)
        out += ch === '^' && [...value].every(c => superscript[c]) ? [...value].map(c => superscript[c]).join('') : `${ch}${value.length > 1 ? `(${value})` : value}`
        continue
      }
      if (ch !== '\\') { out += ch; continue }
      if (source[cursor] === '\\') { cursor++; out += '; '; continue }
      const match = /^[a-zA-Z]+/.exec(source.slice(cursor))
      if (!match) { out += source[cursor++] ?? '\\'; continue }
      const command = match[0]; cursor += command.length
      if (command === 'frac' || command === 'dfrac' || command === 'tfrac') { const a = group(depth), b = group(depth); out += `(${a} / ${b})` }
      else if (command === 'sqrt') {
        let degree = ''
        if (source[cursor] === '[') { const end = source.indexOf(']', cursor + 1); if (end < 0) throw new Error('Unclosed root degree'); degree = source.slice(cursor + 1, end); cursor = end + 1 }
        const value = group(depth)
        out += degree ? `root(${degree}, ${value})` : `√(${value})`
      }
      else if (command === 'begin' || command === 'end') { const env = group(depth); out += /matrix|array/.test(env) ? command === 'begin' ? '[' : ']' : '' }
      else if (['text', 'mathrm', 'mathbf', 'operatorname', 'mathit'].includes(command)) out += group(depth)
      else if (command !== 'left' && command !== 'right') out += symbols[command] ?? `\\${command}`
    }
    if (grouped) throw new Error('Unclosed math group')
    return out
  }
  try { return read(0).replace(/\s*&\s*/g, ', ').trim() } catch { return source }
}

function math(text: string): string {
  return text.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$(?!\s|\d[\d.,]*(?:\s|$))([^$\n]+?)\$/g, (_all, a: string, b: string, c: string, d: string) => simplifyLatex(a ?? b ?? c ?? d))
}
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function formatInline(text: string, kind: 'telegram' | 'whatsapp'): string {
  const stash: string[] = []
  const keep = (value: string) => `\u0000${stash.push(value) - 1}\u0000`
  let out = text.replace(/\u0000/g, '')
  out = out.replace(/`([^`\n]+)`/g, (_all, code: string) => keep(kind === 'telegram' ? `<code>${html(code)}</code>` : `\`${code}\``))
  out = math(out)
  out = out.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, alias?: string) => {
    const label = alias ?? target.split('/').at(-1) ?? target
    return kind === 'telegram' ? keep(`<b>${html(label)}</b>`) : label
  })
  out = out.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) return label
    return keep(kind === 'telegram' ? `<a href="${html(url)}">${html(label)}</a>` : `${label} (${url})`)
  })
  if (kind === 'telegram') {
    out = html(out).replace(/^ {0,3}#{1,6}\s+(.*)$/gm, '<b>$1</b>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<i>$2</i>')
      .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<i>$2</i>').replace(/~~([^~]+)~~/g, '<s>$1</s>')
  } else {
    out = out.replace(/^ {0,3}#{1,6}\s+(.*)$/gm, '*$1*').replace(/\*\*([^*]+)\*\*/g, (_all, value: string) => keep(`*${value}*`))
      .replace(/__([^_]+)__/g, (_all, value: string) => keep(`*${value}*`)).replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1_$2_').replace(/~~([^~]+)~~/g, '~$1~')
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_all, i: string) => stash[Number(i)] ?? '')
}

export function formatTextParts(source: string, kind: 'telegram' | 'whatsapp', max = 4096): Array<Extract<MessageContent, { type: 'text' }>> {
  const blocks: Array<{ text: string; code: boolean }> = []
  const fence = /```[^\n`]*\n([\s\S]*?)```/g
  let cursor = 0
  for (const match of source.matchAll(fence)) {
    if (match.index! > cursor) blocks.push({ text: source.slice(cursor, match.index), code: false })
    blocks.push({ text: match[1].replace(/\n$/, ''), code: true }); cursor = match.index! + match[0].length
  }
  if (cursor < source.length || !blocks.length) blocks.push({ text: source.slice(cursor), code: false })
  const parts: Array<Extract<MessageContent, { type: 'text' }>> = []
  for (const block of blocks) {
    const chars = [...block.text]
    const render = (value: string) => block.code ? kind === 'telegram' ? `<pre>${html(value)}</pre>` : `\`\`\`\n${value}\n\`\`\`` : formatInline(value, kind)
    let offset = 0
    while (offset < chars.length) {
      let low = 1, high = Math.min(chars.length - offset, max), count = 0
      while (low <= high) { const mid = Math.floor((low + high) / 2); if (render(chars.slice(offset, offset + mid).join('')).length <= max) { count = mid; low = mid + 1 } else high = mid - 1 }
      if (!count) throw new Error('Channel text limit is too small')
      if (offset + count < chars.length && !block.code) { const chunk = chars.slice(offset, offset + count).join(''); const boundary = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' ')); if (boundary > chunk.length / 2) count = [...chunk.slice(0, boundary + 1)].length }
      const text = render(chars.slice(offset, offset + count).join('')); offset += count
      if (text.trim()) parts.push({ type: 'text', text, format: kind === 'telegram' ? 'telegramHtml' : 'whatsapp' })
    }
  }
  return parts
}

export function formatChannelParts(content: MessageContent, kind: ChannelKind): MessageContent[] {
  if (kind === 'chat') return [content]
  if (content.type === 'text') return content.format ? [content] : formatTextParts(content.text, kind)
  if (content.type === 'attachment' && content.caption) {
    const caption = formatInline(content.caption, kind)
    if (['videoNote', 'sticker'].includes(content.media ?? '') || kind === 'whatsapp' && ['audio', 'voice'].includes(content.media ?? '') || caption.length > 1024) return [...formatTextParts(content.caption, kind), { ...content, caption: undefined }]
    return [{ ...content, caption }]
  }
  return [content]
}
