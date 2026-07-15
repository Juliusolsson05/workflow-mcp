import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { ParentToWorkerMessage, WorkerToParentMessage } from '../src/workerMessages.js'
import type {
  WorkflowWorkerExit,
  WorkflowWorkerHandle,
  WorkflowWorkerLauncher,
  WorkflowWorkerLaunchOptions,
} from '../src/workerLauncher.js'

class SyntheticWorker implements WorkflowWorkerHandle {
  readonly stderr = undefined
  readonly events = new EventEmitter()
  running = true

  postMessage(message: ParentToWorkerMessage): void {
    if (message.type === 'start') {
      queueMicrotask(() => this.events.emit('message', { type: 'complete', value: 'embedded' }))
    }
    if (message.type === 'cancel') this.terminate()
  }

  onMessage(listener: (message: WorkerToParentMessage) => void): () => void {
    this.events.on('message', listener)
    queueMicrotask(() => this.events.emit('message', { type: 'ready' }))
    return () => this.events.removeListener('message', listener)
  }

  onExit(listener: (exit: WorkflowWorkerExit) => void): () => void {
    this.events.once('exit', listener)
    return () => this.events.removeListener('exit', listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.once('error', listener)
    return () => this.events.removeListener('error', listener)
  }

  isRunning(): boolean {
    return this.running
  }

  terminate(): void {
    if (!this.running) return
    this.running = false
    queueMicrotask(() => this.events.emit('exit', { code: 0, signal: null }))
  }
}

class WatchdogWorker implements WorkflowWorkerHandle {
  readonly stderr = undefined
  readonly events = new EventEmitter()
  readonly mode: 'never-ready' | 'idle'
  running = true
  heartbeat: NodeJS.Timeout | undefined

  constructor(mode: 'never-ready' | 'idle') {
    this.mode = mode
  }

  postMessage(message: ParentToWorkerMessage): void {
    if (message.type === 'start' && this.mode === 'idle') {
      this.heartbeat = setInterval(() => {
        this.events.emit('message', { type: 'heartbeat', pendingRequests: 0, timers: 0 })
      }, 5)
    }
    if (message.type === 'cancel') this.terminate()
  }

  onMessage(listener: (message: WorkerToParentMessage) => void): () => void {
    this.events.on('message', listener)
    if (this.mode !== 'never-ready') queueMicrotask(() => this.events.emit('message', { type: 'ready' }))
    return () => this.events.removeListener('message', listener)
  }

  onExit(listener: (exit: WorkflowWorkerExit) => void): () => void {
    this.events.once('exit', listener)
    return () => this.events.removeListener('exit', listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.once('error', listener)
    return () => this.events.removeListener('error', listener)
  }

  isRunning(): boolean { return this.running }

  terminate(): void {
    if (!this.running) return
    this.running = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    queueMicrotask(() => this.events.emit('exit', { code: 0, signal: null }))
  }
}

describe('WorkflowWorkerLauncher boundary', () => {
  it('executes through an injected non-ChildProcess handle and explicit worker entry', async () => {
    let launchOptions: WorkflowWorkerLaunchOptions | undefined
    const launcher: WorkflowWorkerLauncher = {
      launch(options) {
        launchOptions = options
        return new SyntheticWorker()
      },
    }
    const workflow = parseWorkflowSource(`export const meta = {
      name: 'embedded', description: 'Embedded worker fixture'
    }
    return 'source evaluator is replaced by the synthetic transport'`)
    const run = runWorkflow({
      workflow,
      cwd: process.cwd(),
      provider: new FakeAgentProvider([]),
      workerLauncher: launcher,
      workerFilePath: '/packaged/app/workflowWorker.js',
    })

    await expect(run.result).resolves.toBe('embedded')
    expect(launchOptions?.workerFilePath).toBe('/packaged/app/workflowWorker.js')
    expect(launchOptions?.env).not.toHaveProperty('HOME')
  })

  it('fails a worker which never reaches the ready boundary', async () => {
    const worker = new WatchdogWorker('never-ready')
    const run = runWorkflow({
      workflow: parseWorkflowSource(`export const meta = { name: 'stuck-start', description: 'fixture' }
        return null`),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([]),
      workerLauncher: { launch: () => worker },
      reliability: {
        workerStartupTimeoutMs: 20,
        workerHeartbeatTimeoutMs: 100,
        workerIdleTimeoutMs: 100,
      },
      limits: { cancellationGraceMs: 5 },
    })

    await expect(run.result).rejects.toMatchObject({ code: 'workflow-worker-startup-timeout' })
    expect(worker.running).toBe(false)
  })

  it('fails a responsive worker whose workflow awaits nothing forever', async () => {
    const worker = new WatchdogWorker('idle')
    const run = runWorkflow({
      workflow: parseWorkflowSource(`export const meta = { name: 'stuck-idle', description: 'fixture' }
        return await new Promise(() => {})`),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([]),
      workerLauncher: { launch: () => worker },
      reliability: {
        workerStartupTimeoutMs: 100,
        workerHeartbeatTimeoutMs: 100,
        workerIdleTimeoutMs: 20,
      },
      limits: { cancellationGraceMs: 5 },
    })

    await expect(run.result).rejects.toMatchObject({ code: 'workflow-worker-idle' })
    expect(worker.running).toBe(false)
  })
})
