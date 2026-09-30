import path from 'path-browserify'
import { CONFIG_DIR } from './constants'

export function assistantDir(vaultRoot: string): string {
  return path.join(vaultRoot, CONFIG_DIR, 'plugins', 'data', 'assistant')
}

export function rulesDir(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'rules')
}

export function runtimeDir(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'runtime')
}

export function chorusDir(vaultRoot: string): string {
  return assistantDir(vaultRoot)
}

export function chorusChatsDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'chats')
}

export function chorusChannelsDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'channels')
}

export function personalitiesDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'personalities')
}

export function personalityDir(vaultRoot: string, id: string): string {
  return path.join(personalitiesDir(vaultRoot), id)
}

export function chorusCommandsPath(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'commands.json')
}

export function chatDir(vaultRoot: string, meta: { id: string; source?: string; channelId?: string; chatRef?: string }): string {
  if (meta.source && meta.channelId && meta.chatRef) {
    return path.join(chorusChannelsDir(vaultRoot), safeSegment(meta.channelId), safeSegment(meta.id))
  }
  return path.join(chorusChatsDir(vaultRoot), safeSegment(meta.id))
}

export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.\.+/g, '_') || '_'
}

export function readmePath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'README.md')
}

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes('..')
}
