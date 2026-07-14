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
})
