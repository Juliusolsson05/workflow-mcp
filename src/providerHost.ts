import { Codex } from '@openai/codex-sdk'

import {
  AgentProviderAbortError,
  AgentProviderFailure,
} from './agentProvider.js'
import type {
  AgentProviderExecutionContext,
  AgentProviderResult,
  AgentRequest,
  ProviderSessionReference,
} from './agentProvider.js'
import { executeCodexTurn } from './codexProvider.js'
import {
  isParentToProviderHostMessage,
} from './providerHostProtocol.js'
import type {
  ParentToProviderHostMessage,
  ProviderHostToParentMessage,
  SerializedProviderHostError,
} from './providerHostProtocol.js'

const DEFAULT_HEARTBEAT_MS = 5_000

/**
 * Start the credentialed Codex provider host in the current Node process.
 *
 * WHY one host owns exactly one attempt: an attempt-addressed OS process group is the only boundary
 * the parent can terminate without risking healthy siblings. Pooling turns in one host would save
 * a small Node startup cost but would make a hard kill global again—the incident this architecture
 * exists to prevent. The evaluator remains a separate credential-free process.
 */
export function startCodexProviderHost(): void {
  if (typeof process.send !== 'function') {
    throw new Error('Codex provider host requires a Node IPC channel')
  }

  let started = false
  let terminal = false
  let controller: AbortController | undefined
  let heartbeat: NodeJS.Timeout | undefined
  let eventSequence = 0
  const eventAcknowledgements = new Map<number, {
    resolve(): void
    reject(error: unknown): void
  }>()

  const send = (message: ProviderHostToParentMessage): Promise<void> => new Promise((resolve, reject) => {
    if (typeof process.send !== 'function' || !process.connected) {
      reject(new Error('Provider host parent IPC channel is closed'))
      return
    }
    process.send(message, (error) => error ? reject(error) : resolve())
  })

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }

  const finish = async (message: ProviderHostToParentMessage): Promise<void> => {
    if (terminal) return
    terminal = true
    stopHeartbeat()
    try {
      await send(message)
    } finally {
      // A clean IPC disconnect lets the parent distinguish a delivered terminal record from an
      // abrupt host crash. The parent still waits for `close` and reaps the entire process group
      // before it resolves the provider promise.
      process.disconnect?.()
    }
  }

  const onStart = async (message: Extract<ParentToProviderHostMessage, { type: 'start' }>): Promise<void> => {
    if (started) throw new Error('Provider host received start twice')
    started = true
    controller = new AbortController()
    const intervalMs = Number.isSafeInteger(message.heartbeatIntervalMs) && message.heartbeatIntervalMs > 0
      ? message.heartbeatIntervalMs
      : DEFAULT_HEARTBEAT_MS
    heartbeat = setInterval(() => {
      if (!terminal) void send({ type: 'heartbeat', at: new Date().toISOString() }).catch(() => undefined)
    }, intervalMs)
    heartbeat.unref?.()

    await send({ type: 'ready', pid: process.pid })
    const client = new Codex(message.options)
    const context: AgentProviderExecutionContext = {
      signal: controller.signal,
      emit: async (event) => {
        const sequence = ++eventSequence
        await send({ type: 'event', sequence, event })
        // WHY every event is acknowledged: Codex command/tool updates can arrive much faster than
        // Electron can durably project them. Backpressuring here bounds host and main-process IPC
        // memory while preserving the provider's event order.
        await new Promise<void>((resolve, reject) => {
          eventAcknowledgements.set(sequence, { resolve, reject })
        })
      },
    }

    try {
      const result = await executeCodexTurn(client, message.request, context, message.modelAliases)
      await finish({ type: 'result', result })
    } catch (error) {
      await finish({ type: 'error', error: serializeProviderError(error) })
    }
  }

  process.on('message', (raw: unknown) => {
    if (!isParentToProviderHostMessage(raw) || terminal) return
    if (raw.type === 'event.acknowledged') {
      const acknowledgement = eventAcknowledgements.get(raw.sequence)
      if (!acknowledgement) return
      eventAcknowledgements.delete(raw.sequence)
      acknowledgement.resolve()
      return
    }
    if (raw.type === 'cancel') {
      controller?.abort(raw.reason)
      return
    }
    void onStart(raw).catch(async (error: unknown) => {
      await finish({ type: 'error', error: serializeProviderError(error) }).catch(() => undefined)
    })
  })

  process.on('disconnect', () => {
    controller?.abort('Provider host parent disconnected')
    stopHeartbeat()
    for (const acknowledgement of eventAcknowledgements.values()) {
      acknowledgement.reject(new Error('Provider host parent disconnected before acknowledging event'))
    }
    eventAcknowledgements.clear()
  })
}

function serializeProviderError(error: unknown): SerializedProviderHostError {
  if (error instanceof AgentProviderFailure) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(error.code === undefined ? {} : { code: error.code }),
      retryable: error.retryable,
      circuitImpact: error.circuitImpact,
      ...(error.providerSession === undefined ? {} : { providerSession: error.providerSession }),
    }
  }
  if (error instanceof AgentProviderAbortError || (error instanceof Error && error.name === 'AbortError')) {
    return {
      name: 'AbortError',
      message: error instanceof Error ? error.message : 'Provider host execution aborted',
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    }
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
  return { name: 'Error', message: String(error) }
}

export function deserializeProviderHostError(error: SerializedProviderHostError): Error {
  if (error.name === 'AgentProviderFailure') {
    const failure = new AgentProviderFailure(error.message, {
      ...(error.code === undefined ? {} : { code: error.code }),
      retryable: error.retryable ?? false,
      ...(error.circuitImpact === undefined ? {} : { circuitImpact: error.circuitImpact }),
      ...(error.providerSession === undefined ? {} : { providerSession: error.providerSession }),
    })
    if (error.stack !== undefined) failure.stack = error.stack
    return failure
  }
  if (error.name === 'AbortError') {
    const aborted = new AgentProviderAbortError(error.message)
    if (error.stack !== undefined) aborted.stack = error.stack
    return aborted
  }
  const result = new Error(error.message)
  result.name = error.name
  if (error.stack !== undefined) result.stack = error.stack
  return result
}

// Retain imports in the declaration output: they document the protocol's terminal payload types.
void (undefined as AgentProviderResult | AgentRequest | ProviderSessionReference | undefined)
