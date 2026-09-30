import type { GuardAuditEntry, GuardFileOperation, GuardPolicy } from '@valley/plugin-sdk/guard/types'
import { backendApi } from './runtime'

export const readGuardPolicy = (_root: string): Promise<GuardPolicy> => backendApi().policy.read()
export const guardFilePath = (_root: string, path: string, operation: GuardFileOperation): Promise<void> => backendApi().policy.checkFile(path, operation)
export const appendGuardAudit = (_root: string, entry: GuardAuditEntry): Promise<void> => backendApi().policy.audit(entry)
