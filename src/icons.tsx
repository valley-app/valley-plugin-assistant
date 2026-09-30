import { React } from './runtime'
import type { FC, ReactNode } from 'react'

/**
 * Inline SVG icons (no bundled icon library).
 * Each icon is a component so its JSX (→ `React.createElement`) runs at render
 * time — never at module-evaluation time, when the host's `React` binding is
 * not yet assigned (`initRuntime` runs inside `register()`, after import). A
 * top-level `svg(<…/>)` would throw on load and fail the whole plugin.
 */
type IconProps = { className?: string }

const Svg: FC<IconProps & { children: ReactNode }> = ({ className, children }) => (
  <svg
    className={className}
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const Send: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M12 20V4m-7 7 7-7 7 7" />
  </Svg>
)

export const Plus: FC<IconProps> = (p) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
)

export const Trash: FC<IconProps> = (p) => (
  <Svg {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Svg>
)

export const Stop: FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </Svg>
)

export const ShieldAlert: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
    <path d="M12 8v5m0 3h.01" />
  </Svg>
)

export const ShieldCheck: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
    <path d="m8 12 3 3 5-6" />
  </Svg>
)

export const Check: FC<IconProps> = (p) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
)

export const X: FC<IconProps> = (p) => (
  <Svg {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Svg>
)

export const Copy: FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
)

export const ChevronRight: FC<IconProps> = (p) => (
  <Svg {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Svg>
)

export const ChevronLeft: FC<IconProps> = (p) => (
  <Svg {...p}>
    <polyline points="15 18 9 12 15 6" />
  </Svg>
)

/* react-icons IoFolderOutline path (plugins can't bundle react-icons — it would
   drag in a second React instance), inlined with its native 512 viewBox. */
export const Folder: FC<IconProps> = ({ className }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 512 512" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32" aria-hidden="true">
    <path d="M440 432H72a40 40 0 0 1-40-40V120a40 40 0 0 1 40-40h75.89a40 40 0 0 1 22.19 6.72l27.84 18.56a40 40 0 0 0 22.19 6.72H440a40 40 0 0 1 40 40v240a40 40 0 0 1-40 40zM32 192h448" />
  </svg>
)

/* react-icons MdOutlineFrontHand path (filled, 24 viewBox) — the open-palm "stop"
   glyph for the assistant-permission control. Inlined for the same reason. */
export const Hand: FC<IconProps> = ({ className }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.5 8c-.17 0-.34.02-.5.05V4.5a2.5 2.5 0 0 0-3.04-2.44A2.502 2.502 0 0 0 12.5 0c-1.06 0-1.96.66-2.33 1.59A2.5 2.5 0 0 0 7 4v.55A2.5 2.5 0 0 0 4 7v8.5c0 4.69 3.81 8.5 8.5 8.5s8.5-3.81 8.5-8.5v-5A2.5 2.5 0 0 0 18.5 8zm.5 7.5a6.5 6.5 0 1 1-13 0V7c0-.28.22-.5.5-.5s.5.22.5.5v5h2V4c0-.28.22-.5.5-.5s.5.22.5.5v7h2V2.5c0-.28.22-.5.5-.5s.5.22.5.5V11h2V4.5c0-.28.22-.5.5-.5s.5.22.5.5v8.92c-1.77.77-3 2.53-3 4.58h2c0-1.66 1.34-3 3-3v-4.5c0-.28.22-.5.5-.5s.5.22.5.5v5z" />
  </svg>
)

/* lucide TriangleAlert — the danger glyph for the "Dangerously skip permissions"
   permission item (stroke-based to sit cleanly beside the hand/chevrons). */
export const Warning: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
)

/* react-icons CiCircleCheck (Circum Icons), inlined verbatim — importing react-icons
   would bundle a second React into the plugin and break the api.React invariant. */
export const CircleCheck: FC<IconProps> = ({ className }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M15.81,10.4a.5.5,0,0,0-.71-.71l-3.56,3.56L9.81,11.52a.5.5,0,0,0-.71.71l2.08,2.08a.513.513,0,0,0,.71,0Z" />
    <path d="M12,21.934A9.934,9.934,0,1,1,21.933,12,9.945,9.945,0,0,1,12,21.934ZM12,3.067A8.934,8.934,0,1,0,20.933,12,8.944,8.944,0,0,0,12,3.067Z" />
  </svg>
)

export const Tool: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </Svg>
)

export const Pin: FC<IconProps> = (p) => (
  <Svg {...p}>
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </Svg>
)

export const Compose: FC<IconProps> = (p) => (
  <Svg {...p}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="m16 3 5 5M10 14l-1 4 4-1L22 8a3.5 3.5 0 0 0-5-5Z" /></Svg>
)

export const FolderOpen: FC<IconProps> = (p) => (
  <Svg {...p}><path d="M3 9V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1M3 21h15a2 2 0 0 0 2-1.5l2-8A2 2 0 0 0 20 9H7a2 2 0 0 0-2 1.5L3 19a2 2 0 0 1-2-2V9" /></Svg>
)

export const Pencil: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </Svg>
)

export const Chat: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </Svg>
)

/** Telegram's paper-plane mark — flags conversations mirrored from Telegram. */
export const Telegram: FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M21.5 4.3 2.9 11.5c-.9.35-.9 1.55.05 1.85l4.55 1.4 1.75 5.4c.25.75 1.2.95 1.7.3l2.5-3.2 4.7 3.45c.6.45 1.45.1 1.6-.6l3.05-14.5c.2-.95-.7-1.75-1.6-1.4z" />
    <path d="m8 13.5 9.5-6-7 7.3" />
  </Svg>
)

/** WhatsApp mark — Font Awesome FaWhatsapp path (filled, 448×512 viewBox). */
export const WhatsApp: FC<IconProps> = ({ className }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true">
    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
  </svg>
)

export const Model: FC<IconProps> = (p) => <Svg {...p}>
  <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
  <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
  <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
  <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
  <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
  <path d="M6 18a4 4 0 0 1-1.967-.516" />
  <path d="M19.967 17.484A4 4 0 0 1 18 18" />
</Svg>
export const Steer: FC<IconProps> = (p) => <Svg {...p}><path d="M5 20v-7a5 5 0 0 1 5-5h9m-5-5 5 5-5 5" /></Svg>
export const Queue: FC<IconProps> = (p) => <Svg {...p}><path d="M4 6h16M4 12h10M4 18h10m4-3 3 3-3 3" /></Svg>
export const Chevrons: FC<IconProps> = (p) => <Svg {...p}><path d="m5 6 6 6-6 6m8-12 6 6-6 6" /></Svg>

export const ReadBook: FC<IconProps> = (p) => <Svg {...p}><path d="M12 7v14m0-14C9 4 5 3 2 3v16c4 0 7 1 10 2m0-14c3-3 7-4 10-4v16c-4 0-7 1-10 2" /></Svg>
export const Terminal: FC<IconProps> = (p) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 8 3 3-3 3m6 1h4" /></Svg>

export const ArrowDown: FC<IconProps> = (p) => <Svg {...p}><path d="M12 4v16m7-7-7 7-7-7" /></Svg>

export const Clock: FC<IconProps> = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
export const Search: FC<IconProps> = (p) => <Svg {...p}><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></Svg>
export const More: FC<IconProps> = (p) => <Svg {...p}><g fill="currentColor" stroke="none"><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="20" cy="12" r="1.5" /></g></Svg>

const speedometerPaths = ["M128 416h256v48H128zM256 288c17.7 0 32-14.3 32-32s-14.3-32-32-32c-3 0-6 .4-8.8 1.2l-66.7-48.7-4 3.5 48.9 66.7c-.9 2.9-1.4 6-1.4 9.3 0 17.7 14.3 32 32 32z", "M256 48C141.1 48 48 141.1 48 256c0 48.3 16.5 92.7 44.1 128h58.8l4-4 22.1-22.1-22.9-22.9-22.1 22c-19.9-24.3-32.1-54-35.2-85H128v-32H96.8c3.1-31 15.3-60.7 35.2-85l22.1 22 22.9-22.9-22-22.1c24.3-19.9 54-32.1 85-35.2V128h32V96.8c31 3.1 60.7 15.3 85 35.2l-22 22.1 22.9 22.9 22.1-22c19.9 24.3 32.1 54 35.2 85H384v32h31.2c-3.1 31-15.3 60.7-35.2 85l-22.1-22-22.9 22.9 22.1 22.1 4 4h58.8c27.6-35.3 44.1-79.7 44.1-128 0-114.9-93.1-208-208-208z"]
export const speedometerIcon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${speedometerPaths.map(d => `<path d="${d}"/>`).join('')}</svg>`)}`
export const Speedometer: FC<IconProps> = ({ className }) => <svg className={className} width="16" height="16" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">{speedometerPaths.map(d => <path key={d} d={d} />)}</svg>

export const Lightning: FC<IconProps> = p => <Svg {...p}><path d="m13 2-10 12h8l-1 8 11-13h-8l1-7Z" /></Svg>
export const Reset: FC<IconProps> = p => <Svg {...p}><path d="M3 11a9 9 0 1 1 2.8 7M3 4v7h7" /></Svg>

export const Stopwatch: FC<IconProps> = (p) => <Svg {...p}><path d="M10 2h4M12 2v3m6 1 2-2M12 9v4" /><circle cx="12" cy="13" r="8" /></Svg>
