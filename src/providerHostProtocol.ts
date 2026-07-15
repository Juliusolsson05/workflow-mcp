import type { CodexOptions } from '@openai/codex-sdk'

import type {
  AgentProviderEvent,
  AgentProviderResult,
  AgentRequest,
  ProviderSessionReference,
} from './agentProvider.js'

/**
 * The provider host protocol is intentionally data-only. Passing callbacks, ChildProcess objects,
 * or Electron handles across this seam would couple workflow-mcp to one launcher and make process
 * ownership impossible to verify in a plain Node integration test. Every message is compatible
 * with Node's JSON IPC serializer so packaged Electron and standalone Node use identical bytes.
 */

export type SerializedCodexHostOptions = Omit<CodexOptions, 'env'> & {
  env?: Record<string, string>
}

export type ProviderHostStartMessage = {
  type: 'start'
  request: AgentRequest
  options: SerializedCodexHostOptions
  modelAliases: Readonly<Record<string, string | null>>
  heartbeatIntervalMs: number
}

export type ProviderHostCancelMessage = {
  type: 'cancel'
  reason: string
}

export type ProviderHostEventAcknowledgedMessage = {
  type: 'event.acknowledged'
  sequence: number
}

export type ParentToProviderHostMessage =
  | ProviderHostStartMessage
  | ProviderHostCancelMessage
  | ProviderHostEventAcknowledgedMessage

export type ProviderHostReadyMessage = { type: 'ready'; pid: number }
export type ProviderHostHeartbeatMessage = { type: 'heartbeat'; at: string }
export type ProviderHostEventMessage = {
  type: 'event'
  sequence: number
  event: AgentProviderEvent
}
export type ProviderHostResultMessage = { type: 'result'; result: AgentProviderResult }

export type SerializedProviderHostError = {
  name: string
  message: string
  stack?: string
  code?: string
  retryable?: boolean
  providerSession?: ProviderSessionReference
}

export type ProviderHostErrorMessage = { type: 'error'; error: SerializedProviderHostError }

export type ProviderHostToParentMessage =
  | ProviderHostReadyMessage
  | ProviderHostHeartbeatMessage
  | ProviderHostEventMessage
  | ProviderHostResultMessage
  | ProviderHostErrorMessage

export function isParentToProviderHostMessage(value: unknown): value is ParentToProviderHostMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const type = (value as { type?: unknown }).type
  return type === 'start' || type === 'cancel' || type === 'event.acknowledged'
}

export function isProviderHostToParentMessage(value: unknown): value is ProviderHostToParentMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const type = (value as { type?: unknown }).type
  return type === 'ready' || type === 'heartbeat' || type === 'event' ||
    type === 'result' || type === 'error'
}
