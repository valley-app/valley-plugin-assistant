import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import type { AiMessage } from '../types'
import { React, api } from '../runtime'
import { uiText } from '../localization'
import { Folder } from '../icons'
import css from './media.css'

type AttachmentFile = NonNullable<AiMessage['attachmentFiles']>[number]
export function attachmentPreview(file: AttachmentFile): 'image' | 'audio' | 'video' | 'file' {
  const mime = file.mime?.split(';')[0].toLowerCase()
  if (mime && /^image\/(png|jpeg|webp|gif|avif)$/.test(mime)) return 'image'
  if (mime && /^audio\/(mpeg|mp4|ogg|opus|wav|x-wav|webm|flac|aac)$/.test(mime)) return 'audio'
  if (mime && /^video\/(mp4|webm|ogg|quicktime)$/.test(mime)) return 'video'
  if (!mime && /\.(png|jpe?g|webp|gif|avif)$/i.test(file.fileName)) return 'image'
  if (!mime && /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(file.fileName)) return 'audio'
  if (!mime && /\.(mp4|webm|mov)$/i.test(file.fileName)) return 'video'
  return 'file'
}
export function safeAttachmentPath(value: string): boolean {
  return Boolean(value && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f?#]/.test(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.split('/').some(part => part === '..' || part === '.') && (!value.startsWith('.valley/') || value.startsWith('.valley/plugins/data/assistant/')))
}
const label = (key: string) => uiText(`assistant.media.${key}`)
const Button: typeof api.ui.settings.Button = props => React.createElement(api.ui.settings.Button, props)

type PreviewPlayer = Awaited<ReturnType<typeof api.playback.createLocalPlayer>>
type PreviewSnapshot = NonNullable<Awaited<ReturnType<PreviewPlayer['getSnapshot']>>>
const elapsed = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`

function AttachmentMedia({ file, kind, onError }: { file: AttachmentFile; kind: 'audio' | 'video'; onError(): void }) {
  const player = React.useRef<PreviewPlayer | null>(null)
  const [sessionId, setSessionId] = React.useState('')
  const [snapshot, setSnapshot] = React.useState<PreviewSnapshot | null>(null)
  const [busy, setBusy] = React.useState(false)
  const error = React.useRef(onError)
  error.current = onError
  React.useEffect(() => {
    let alive = true
    let owned: PreviewPlayer | null = null
    let off: (() => void) | undefined
    setSessionId(''); setSnapshot(null); setBusy(false)
    void (async () => {
      const value = await api.playback.createLocalPlayer({ id: `attachment:${crypto.randomUUID()}`, preview: true })
      owned = value
      if (!alive) { await value.dispose(); return }
      player.current = value
      off = value.onChange(next => {
        if (!alive) return
        setSnapshot(next)
        if (next.state.status === 'error') error.current()
      })
      const next = await value.load({ key: `attachment:${file.path}`, providerId: 'assistant', sourceId: file.path, path: file.path,
        kind, title: file.fileName, artists: [], feat: [] }, { autoplay: false, position: 0 })
      if (!alive) return
      setSnapshot(next)
      setSessionId(value.sessionId)
    })().catch(() => { if (alive) error.current() })
    return () => { alive = false; off?.(); if (player.current === owned) player.current = null; void owned?.dispose().catch(() => {}) }
  }, [file.path, file.fileName, kind])
  const action = (run: (value: PreviewPlayer) => Promise<{ status: string }>): void => {
    const current = player.current
    if (!current || busy) return
    setBusy(true)
    void run(current).then(receipt => { if (receipt.status !== 'observed') throw new Error('Media preview action was not confirmed') })
      .catch(() => { if (player.current === current) error.current() }).finally(() => { if (player.current === current) setBusy(false) })
  }
  const playing = snapshot?.state.status === 'playing' || snapshot?.state.status === 'buffering'
  const position = snapshot?.state.positionSeconds ?? 0
  const duration = snapshot?.state.durationSeconds ?? 0
  return <div className={`assistant-media-player assistant-media-${kind}`}>
    {kind === 'video' && sessionId && <div className="assistant-media-surface">{React.createElement(api.ui.MediaSurface, { sessionId, controls: false, style: { width: '100%', height: '100%', borderRadius: 6 } })}</div>}
    <div className="assistant-media-transport">
      <Button size="small" variant="ghost" disabled={!sessionId || busy} aria-label={label(playing ? 'pause' : 'play')} onClick={() => action(value => value.toggle())}>{playing ? 'Ⅱ' : '▶'}</Button>
      <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 1)} disabled={!sessionId || !duration || busy} aria-label={label('seek')} onChange={event => action(value => value.seek(Number(event.currentTarget.value)))} />
      <span>{elapsed(position)} / {elapsed(duration)}</span>
      <input className="assistant-media-volume" type="range" min={0} max={1} step={0.05} value={snapshot?.state.volume ?? 1} disabled={!sessionId || busy} aria-label={label('volume')} onChange={event => action(value => value.setVolume(Number(event.currentTarget.value)))} />
    </div>
  </div>
}

function AttachmentCard({ file }: { file: AttachmentFile }) {
  const root = React.useRef<HTMLElement>(null), [failed, setFailed] = React.useState(false), [reducedMotion, setReducedMotion] = React.useState(true), [reveal, setReveal] = React.useState(false)
  React.useEffect(() => {
    setFailed(false); setReveal(false)
    const query = root.current?.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query?.matches ?? false)
    update(); query?.addEventListener('change', update)
    return () => { query?.removeEventListener('change', update) }
  }, [file.path])
  const safe = safeAttachmentPath(file.path), preview = attachmentPreview(file), source = safe ? assetUrlForRelPath(file.path) : undefined
  const animated = file.metadata?.animated || file.metadata?.video || /\.(gif|tgs)$/i.test(file.fileName)
  const sticker = file.metadata?.media === 'sticker'
  const showPreview = safe && !failed && (!reducedMotion || !animated || reveal)
  const details = [file.metadata?.media ? label(file.metadata.media) : file.mime, file.metadata?.duration === undefined ? null : `${Math.round(file.metadata.duration)} s`, file.metadata?.bytes === undefined ? null : `${Math.max(1, Math.round(file.metadata.bytes / 1024))} KB`].filter(Boolean).join(' · ')
  const status = file.warning || file.metadata?.interpretation === 'partial' || file.metadata?.interpretation === 'unavailable'
  return <figure ref={root} className={`assistant-media-card${sticker ? ' assistant-media-sticker' : ''}`}>
    {showPreview && preview === 'image' && <img src={source} alt={file.fileName} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    {showPreview && (preview === 'audio' || preview === 'video') && <AttachmentMedia file={file} kind={preview} onError={() => setFailed(true)} />}
    {(!showPreview || preview === 'file') && <div className="assistant-media-placeholder"><Folder />{sticker && file.metadata?.emoji && <span aria-label={label('stickerEmoji')}>{file.metadata.emoji}</span>}</div>}
    <figcaption><span className="assistant-media-name" title={file.fileName}>{file.fileName}</span>{details && <span className="assistant-media-detail">{details}</span>}
      {(failed || preview === 'file' && sticker) && <span className="assistant-media-detail">{label('previewUnavailable')}</span>}
      {status && <span className="assistant-media-warning">{label(file.metadata?.interpretation === 'partial' ? 'partial' : 'unreadable')}</span>}
      <div className="assistant-media-actions">{safe && <Button size="small" variant="ghost" onClick={() => api.workspace.openFile(file.path)}>{label('open')}</Button>}{safe && reducedMotion && animated && !reveal && <Button size="small" variant="ghost" onClick={() => setReveal(true)}>{label('preview')}</Button>}</div>
    </figcaption>
  </figure>
}

export function MessageAttachments({ files }: { files: AiMessage['attachmentFiles'] }) {
  if (!files?.length) return null
  return <div className="assistant-message-media"><style>{css}</style>{files.map((file, index) => <AttachmentCard key={`${file.path}:${index}`} file={file} />)}</div>
}
