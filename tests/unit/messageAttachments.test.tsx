import * as React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMockValleyApi } from '../mock'
import { initRuntime } from '../../src/runtime'
import { MessageAttachments, attachmentPreview, safeAttachmentPath } from '../../src/media/MessageAttachments'

afterEach(cleanup)
const mockPreviews = () => {
  const mock = createMockValleyApi()
  let nextSession = 0
  const players: Array<ReturnType<typeof player>> = []
  function player() {
    const current = { sessionId: `preview-${nextSession++}`, load: vi.fn(async () => ({ state: { status: 'paused', positionSeconds: 0, durationSeconds: 40, volume: 1 } })),
      dispose: vi.fn(async () => {}), onChange: vi.fn(() => () => {}), play: vi.fn(async () => ({ status: 'observed' })),
      toggle: vi.fn(async () => ({ status: 'observed' })), seek: vi.fn(async () => ({ status: 'observed' })), setVolume: vi.fn(async () => ({ status: 'observed' })) }
    return current
  }
  const createLocalPlayer = vi.fn(async () => { const current = player(); players.push(current); return current })
  Object.assign(mock.api.playback, { createLocalPlayer })
  Object.assign(mock.api.ui, { MediaSurface: ({ sessionId }: { sessionId: string }) => <div data-media-session={sessionId} /> })
  initRuntime(mock.api)
  return { ...mock, players, createLocalPlayer }
}
it('shows host audio and video previews without autoplay and preserves unreadable sticker metadata', async () => {
  const { api, players, createLocalPlayer } = mockPreviews()
  const { container } = render(<MessageAttachments files={[
    { fileName: 'Bird call.ogg', path: '.valley/plugins/data/assistant/attachment/bird.ogg', kind: 'audio', mime: 'audio/ogg', metadata: { media: 'voice', duration: 4 } },
    { fileName: 'Forest.webm', path: '.valley/plugins/data/assistant/attachment/forest.webm', kind: 'file', mime: 'video/webm', metadata: { media: 'videoNote' } },
    { fileName: 'Moss.tgs', path: '.valley/plugins/data/assistant/attachment/moss.tgs', kind: 'file', mime: 'application/x-tgsticker', metadata: { media: 'sticker', animated: true, interpretation: 'unavailable' } },
  ]} />)
  await waitFor(() => expect(container.querySelector('[data-media-session]')).toBeTruthy())
  expect(container.querySelector('audio, video')).toBeNull()
  expect(createLocalPlayer).toHaveBeenCalledTimes(2)
  expect(createLocalPlayer).toHaveBeenCalledWith(expect.objectContaining({ preview: true }))
  expect(players.every(player => player.play.mock.calls.length === 0)).toBe(true)
  expect(players[0].load).toHaveBeenCalledWith(expect.objectContaining({ path: '.valley/plugins/data/assistant/attachment/bird.ogg' }), { autoplay: false, position: 0 })
  expect(screen.getByText('Moss.tgs')).toBeTruthy()
  expect(screen.getByText('Preview unavailable; the original is retained.')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Open original' })[2])
  expect(api.workspace.openFile).toHaveBeenCalledWith('.valley/plugins/data/assistant/attachment/moss.tgs')
})

it('routes preview controls to the player and disposes it when the message unmounts', async () => {
  const { players } = mockPreviews()
  const { unmount } = render(<MessageAttachments files={[{ fileName: 'Bird.ogg', path: 'Attachments/bird.ogg', kind: 'audio', mime: 'audio/ogg' }]} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).not.toBeDisabled())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Play' })) })
  expect(players[0].toggle).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), { target: { value: '12' } }) })
  expect(players[0].seek).toHaveBeenCalledWith(12)
  unmount()
  expect(players[0].dispose).toHaveBeenCalledOnce()
})

it('disposes a preview created after its attachment was removed', async () => {
  const { createLocalPlayer, players } = mockPreviews()
  const original = createLocalPlayer.getMockImplementation()!
  let release!: () => void
  createLocalPlayer.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return original() })
  const { unmount } = render(<MessageAttachments files={[{ fileName: 'Bird.ogg', path: 'Attachments/bird.ogg', kind: 'audio', mime: 'audio/ogg' }]} />)
  unmount()
  await act(async () => { release(); await Promise.resolve() })
  expect(players[0].dispose).toHaveBeenCalledOnce()
  expect(players[0].load).not.toHaveBeenCalled()
})

it('never previews executable documents or arbitrary remote paths', () => {
  expect(attachmentPreview({ fileName: 'tree.svg', path: 'tree.svg', kind: 'image', mime: 'image/svg+xml' })).toBe('file')
  expect(attachmentPreview({ fileName: 'tree.html', path: 'tree.html', kind: 'file', mime: 'text/html' })).toBe('file')
  for (const path of ['https://example.org/image.png', 'file:///tmp/image.png', '../image.png', '.valley/plugins/data/other/image.png']) expect(safeAttachmentPath(path)).toBe(false)
  expect(safeAttachmentPath('Attachments/forest.webp')).toBe(true)
})
