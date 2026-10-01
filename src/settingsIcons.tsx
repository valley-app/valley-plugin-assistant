import type { SVGProps, ReactElement } from 'react'
import { React } from './runtime'
import data from './settingsIcons.json'

type IconNode = { tag: string; attr: Record<string, string>; child?: IconNode[] }
function renderNode(node: IconNode, key: number): ReactElement {
  return React.createElement(node.tag, { ...node.attr, key }, ...(node.child ?? []).map(renderNode))
}
const icon = (name: keyof typeof data) => (props: SVGProps<SVGSVGElement>): ReactElement => {
  const node = data[name] as IconNode
  return React.createElement('svg', { width: '1em', height: '1em', fill: 'currentColor', stroke: 'currentColor', strokeWidth: 0, 'aria-hidden': true, ...node.attr, ...props }, ...(node.child ?? []).map(renderNode))
}
export const SiAnthropic = icon('SiAnthropic')
export const SiGooglegemini = icon('SiGooglegemini')
export const SiMoonshotai = icon('SiMoonshotai')
export const SiOllama = icon('SiOllama')
export const RiDeepseekFill = icon('RiDeepseekFill')
export const RiGrokAiFill = icon('RiGrokAiFill')
export const RiOpenaiFill = icon('RiOpenaiFill')
export const LuChevronLeft = icon('LuChevronLeft')
export const LuChevronRight = icon('LuChevronRight')
export const LuPlug = icon('LuPlug')
export const LuPlus = icon('LuPlus')
export const LuTrash2 = icon('LuTrash2')
export const LuTriangleAlert = icon('LuTriangleAlert')
export const LuChevronDown = icon('LuChevronDown')
export const LuExternalLink = icon('LuExternalLink')
export const LuFolderOpen = icon('LuFolderOpen')
export const LuPlay = icon('LuPlay')
export const LuRefreshCw = icon('LuRefreshCw')
export const LuSquare = icon('LuSquare')
export const LuBot = icon('LuBot')
export const LuWind = icon('LuWind')
export const LuFlaskConical = icon('LuFlaskConical')

export const LuSettings = icon('LuSettings')
export const RiVoiceAiFill = icon('RiVoiceAiFill')
