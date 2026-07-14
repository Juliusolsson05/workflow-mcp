import type { Readable } from 'node:stream'

import type { ParentToWorkerMessage, WorkerToParentMessage } from './workerMessages.js'

export type WorkflowWorkerExit = {
  code: number | null
  signal: string | null
}

export type WorkflowWorkerLaunchOptions = {
  workerFilePath: string
  env: NodeJS.ProcessEnv
}

/**
 * The deliberately small process surface the workflow scheduler actually needs.
 *
 * WHY this does not expose ChildProcess: Electron's supported packaged-process primitive is
 * utilityProcess.fork, whose lifecycle and message APIs are similar but not structurally equal to
 * node:child_process. Keeping the runtime on this honest common denominator prevents Electron
 * concerns from leaking into the portable evaluator and avoids depending on Electron's runAsNode
 * fuse merely to execute a workflow.
 */
export interface WorkflowWorkerHandle {
  readonly stderr: Readable | undefined
  postMessage(message: ParentToWorkerMessage): void
  onMessage(listener: (message: WorkerToParentMessage) => void): () => void
  onExit(listener: (exit: WorkflowWorkerExit) => void): () => void
  onError(listener: (error: Error) => void): () => void
  isRunning(): boolean
  terminate(): void
}

export interface WorkflowWorkerLauncher {
  launch(options: WorkflowWorkerLaunchOptions): WorkflowWorkerHandle
}
