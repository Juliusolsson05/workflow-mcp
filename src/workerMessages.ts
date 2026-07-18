/** Evaluator liveness cadence; parent policy validation must leave room for at least one tick. */
export const WORKFLOW_WORKER_HEARTBEAT_INTERVAL_MS = 5_000

export type WorkflowWorkerLimits = {
  maxCollectionItems: number
  maxLogCharacters: number
  maxValueDepth: number
  maxValueNodes: number
  synchronousTimeoutMs: number
}

export type WorkerAgentOptions = {
  label?: string
  phase?: string
  schema?: unknown
  model?: string
  effort?: string
  isolation?: string
  agentType?: string
}

export type WorkerWorkflowTarget = string | { scriptPath: string }

export type SerializedWorkerError = {
  name: string
  message: string
  stack?: string
  code?: string
}

export type ParentToWorkerMessage =
  | {
      type: 'start'
      runId: string
      body: string
      filePath?: string
      argsJson?: string
      budgetTotal: number | null
      budgetSpent: number
      metadataPhases: string[]
      heartbeatIntervalMs: number
      limits: WorkflowWorkerLimits
    }
  | {
      type: 'agent.result'
      requestId: string
      result:
        | { type: 'success'; value: unknown; coverageGap?: true }
        | { type: 'error'; error: SerializedWorkerError }
      budgetSpent: number
    }
  | {
      type: 'workflow.result'
      requestId: string
      result:
        | { type: 'success'; value: unknown }
        | { type: 'error'; error: SerializedWorkerError }
      budgetSpent: number
    }
  | {
      type: 'cancel'
      reason: string
    }

export type WorkerToParentMessage =
  | { type: 'ready' }
  | {
      type: 'heartbeat'
      pendingRequests: number
      timers: number
    }
  | { type: 'phase'; title: string; firstSeen: boolean }
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | {
      type: 'agent.request'
      requestId: string
      prompt: string
      options: WorkerAgentOptions
    }
  | {
      type: 'workflow.request'
      requestId: string
      target: WorkerWorkflowTarget
      args?: unknown
    }
  | { type: 'complete'; value: unknown }
  | { type: 'failed'; error: SerializedWorkerError }

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    }
  }

  // Errors created inside node:vm have the realm's Error prototype, so `instanceof Error` is false
  // in the worker host. Preserve only primitive diagnostic fields; passing the realm object itself
  // would violate the constructor-isolation boundary enforced for every other capability value.
  if (typeof error === 'object' && error !== null) {
    const value = error as Record<string, unknown>
    if (typeof value.name === 'string' && typeof value.message === 'string') {
      return {
        name: value.name,
        message: value.message,
        ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
      }
    }
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error),
  }
}
