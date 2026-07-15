import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import type { ParentToWorkerMessage, WorkerToParentMessage } from './workerMessages.js'
import type {
  WorkflowWorkerExit,
  WorkflowWorkerHandle,
  WorkflowWorkerLauncher,
  WorkflowWorkerLaunchOptions,
} from './workerLauncher.js'

class NodeWorkflowWorkerHandle implements WorkflowWorkerHandle {
  readonly stderr
  readonly #child: ChildProcess

  constructor(child: ChildProcess) {
    this.#child = child
    this.stderr = child.stderr ?? undefined
  }

  postMessage(message: ParentToWorkerMessage): void {
    if (!this.#child.connected) return
    try {
      this.#child.send(message, (error) => {
        if (!error) return
        // WHY a callback is required even though send() is wrapped in try/catch: Node reports an
        // IPC pipe that closes between the connected check and the actual write asynchronously.
        // Without a callback that EPIPE becomes an uncaught `error` after cancellation has already
        // completed, occasionally crashing the otherwise healthy workflow host.
      })
    } catch {
      // WHY the lifecycle listener remains authoritative: send-after-exit is a symptom of the
      // process exit already being reported. Surfacing it as a second scheduler failure creates a
      // race whose winner differs between Node and Electron.
    }
  }

  onMessage(listener: (message: WorkerToParentMessage) => void): () => void {
    const wrapped = (message: WorkerToParentMessage): void => listener(message)
    this.#child.on('message', wrapped)
    return () => this.#child.removeListener('message', wrapped)
  }

  onExit(listener: (exit: WorkflowWorkerExit) => void): () => void {
    const wrapped = (code: number | null, signal: NodeJS.Signals | null): void => {
      listener({ code, signal })
    }
    this.#child.once('exit', wrapped)
    return () => this.#child.removeListener('exit', wrapped)
  }

  onError(listener: (error: Error) => void): () => void {
    this.#child.once('error', listener)
    return () => this.#child.removeListener('error', listener)
  }

  isRunning(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null
  }

  terminate(): void {
    if (!this.isRunning()) return
    if (this.#child.connected) this.#child.disconnect()
    if (!this.#child.killed) this.#child.kill('SIGKILL')
  }
}

/** The standalone Node adapter; Electron embedders inject their own utility-process adapter. */
export class NodeWorkflowWorkerLauncher implements WorkflowWorkerLauncher {
  launch(options: WorkflowWorkerLaunchOptions): WorkflowWorkerHandle {
    const child = fork(options.workerFilePath, [], {
      env: options.env,
      // Test runners and Electron add parent exec flags that can be invalid or dangerous for a
      // file child. The evaluator is complete JavaScript and never needs a loader or inspector.
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    return new NodeWorkflowWorkerHandle(child)
  }
}
