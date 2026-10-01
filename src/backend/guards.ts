import type { ConfigurationApi } from './configuration/documents'
import type { GuardAuditEntry, GuardFileOperation, GuardPolicy } from '@valley/plugin-sdk/guard/types'
import { backendApi } from './runtime'

export const readGuardPolicy = (_root: string, api: ConfigurationApi = backendApi()): Promise<GuardPolicy> => api.policy.read()
export const guardFilePath = (_root: string, path: string, operation: GuardFileOperation, api: ConfigurationApi = backendApi()): Promise<void> => api.policy.checkFile(path, operation)
export const appendGuardAudit = (_root: string, entry: GuardAuditEntry): Promise<void> => backendApi().policy.audit(entry)
