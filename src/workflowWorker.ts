import vm from 'node:vm'

import type {
  ParentToWorkerMessage,
  WorkerAgentOptions,
  WorkerToParentMessage,
  WorkerWorkflowTarget,
  WorkflowWorkerLimits,
} from './workerMessages.js'
import { serializeWorkerError, WORKFLOW_WORKER_HEARTBEAT_INTERVAL_MS } from './workerMessages.js'

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

type RealmResolve = (json: string, isUndefined: boolean) => void
type RealmReject = (name: string, message: string, stack?: string, code?: string) => void

const BLOCKED_VALUE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

let started = false
let terminal = false
let cancelled = false
let cancelReason = 'Workflow cancelled'
let budgetTotal: number | null = null
let budgetSpent = 0
let limits: WorkflowWorkerLimits = {
  maxCollectionItems: 4_096,
  maxLogCharacters: 10_000,
  maxValueDepth: 64,
  maxValueNodes: 100_000,
  synchronousTimeoutMs: 30_000,
}
let requestSequence = 0
let timerSequence = 0

const pendingAgents = new Map<string, PendingRequest>()
const pendingWorkflows = new Map<string, PendingRequest>()
const timers = new Map<number, NodeJS.Timeout>()
let heartbeatTimer: NodeJS.Timeout | undefined

type ElectronParentPort = {
  postMessage(message: WorkerToParentMessage): void
  on(event: 'message', listener: (event: { data: ParentToWorkerMessage }) => void): void
}

const electronParentPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort

function send(message: WorkerToParentMessage): void {
  if (electronParentPort) {
    electronParentPort.postMessage(message)
    return
  }
  if (process.send && process.connected) process.send(message)
}

function nextRequestId(prefix: string): string {
  requestSequence += 1
  return `${prefix}_${requestSequence}`
}

function cancellationError(): Error {
  const error = new Error(cancelReason)
  error.name = 'AbortError'
  return error
}

function ensureRunning(): void {
  if (cancelled) throw cancellationError()
  if (terminal) throw new Error('Workflow already reached a terminal state')
}

function clearTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

function rejectPending(error: Error): void {
  for (const pending of pendingAgents.values()) pending.reject(error)
  for (const pending of pendingWorkflows.values()) pending.reject(error)
  pendingAgents.clear()
  pendingWorkflows.clear()
}

function pendingRealmRequest(resolveRealm: RealmResolve, rejectRealm: RealmReject): PendingRequest {
  return {
    resolve(value: unknown): void {
      // Never pass a host object into the untrusted realm. Even an Array or Error that looks like
      // data carries a host constructor, and constructor.constructor is enough to recover Node's
      // Function and then process. JSON text plus a primitive undefined marker forces every result
      // to be reconstructed with the workflow realm's own prototypes.
      if (value === undefined) {
        resolveRealm('', true)
        return
      }
      const json = JSON.stringify(value)
      if (json === undefined) throw new TypeError('Workflow response cannot cross the realm boundary')
      resolveRealm(json, false)
    },
    reject(error: Error): void {
      // The same rule applies to failures: a host Error must never become a workflow rejection.
      // The realm callback creates its own Error from these primitive fields.
      rejectRealm(
        error.name,
        error.message,
        error.stack,
        'code' in error && typeof error.code === 'string' ? error.code : undefined,
      )
    },
  }
}

function finish(message: Extract<WorkerToParentMessage, { type: 'complete' | 'failed' }>): void {
  if (terminal) return
  terminal = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  clearTimers()
  rejectPending(new Error('Workflow ended before a pending request completed'))

  // IPC delivery is asynchronous. Exiting immediately after process.send() intermittently loses
  // the only terminal record, which would leave the parent guessing whether a clean exit meant
  // success. Disconnect only from the send callback so the terminal message wins that race.
  if (electronParentPort) {
    // Electron's MessagePort has no delivery callback. Posting before the next macrotask is the
    // strongest portable handoff available, and the parent terminates the utility process after it
    // has observed this terminal message rather than relying on a self-disconnect.
    electronParentPort.postMessage(message)
  } else if (process.send && process.connected) {
    process.send(message, () => {
      if (process.connected) process.disconnect()
    })
  }
}

function cloneForParent(value: unknown): unknown {
  const seen = new Set<object>()
  let nodes = 0

  const visit = (current: unknown, depth: number, arraySlot: boolean): unknown => {
    nodes += 1
    if (nodes > limits.maxValueNodes) throw new TypeError('Workflow value contains too many nodes')
    if (depth > limits.maxValueDepth) throw new TypeError('Workflow value is nested too deeply')

    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') return Number.isFinite(current) ? current : null
    if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
      return arraySlot ? null : undefined
    }
    if (typeof current === 'bigint') throw new TypeError('Workflow values cannot contain bigint')

    if (seen.has(current)) throw new TypeError('Workflow values cannot contain cycles')
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        if (current.length > limits.maxCollectionItems) {
          throw new TypeError(`Workflow array exceeds ${limits.maxCollectionItems} entries`)
        }
        return current.map((entry) => visit(entry, depth + 1, true))
      }

      if (Object.prototype.toString.call(current) === '[object Date]') {
        const timestamp = (current as Date).getTime()
        if (!Number.isFinite(timestamp)) throw new TypeError('Workflow value contains an invalid Date')
        return (current as Date).toISOString()
      }

      // Null-prototype output prevents a value produced by untrusted workflow JavaScript from
      // changing the prototype of an object in the credentialed parent during deserialization.
      const result = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(current)) {
        if (BLOCKED_VALUE_KEYS.has(key)) {
          throw new TypeError(`Workflow value contains blocked key ${JSON.stringify(key)}`)
        }
        const entry = visit((current as Record<string, unknown>)[key], depth + 1, false)
        // Claude's boundary follows JSON-style omission for functions and undefined object fields.
        if (entry !== undefined) result[key] = entry
      }
      return result
    } finally {
      seen.delete(current)
    }
  }

  const cloned = visit(value, 0, false)
  if (cloned === undefined && value !== undefined) {
    throw new TypeError('Workflow returned a value that cannot cross the execution boundary')
  }
  return cloned
}

function normalizeAgentOptions(value: unknown): WorkerAgentOptions {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return {}
  const input = value as Record<string, unknown>
  const options: WorkerAgentOptions = {}

  if (typeof input.label === 'string') options.label = input.label
  if (typeof input.phase === 'string') options.phase = input.phase
  if (input.schema !== undefined) options.schema = cloneForParent(input.schema)
  if (typeof input.model === 'string') options.model = input.model
  if (typeof input.effort === 'string') options.effort = input.effort
  if (typeof input.isolation === 'string') options.isolation = input.isolation
  if (typeof input.agentType === 'string') options.agentType = input.agentType
  return options
}

function fallbackLabel(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
}

function normalizeWorkflowTarget(value: unknown): WorkerWorkflowTarget {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const scriptPath = (value as Record<string, unknown>).scriptPath
    if (typeof scriptPath === 'string') return { scriptPath }
  }
  throw new TypeError('workflow() expects a saved workflow name or { scriptPath }')
}

function makeBridge(metadataPhases: string[]) {
  let currentPhase: string | undefined
  const knownPhases = new Set(metadataPhases)

  const emitLog = (level: 'log' | 'info' | 'warn' | 'error', text: string): void => {
    send({ type: 'log', level, text: text.slice(0, limits.maxLogCharacters) })
  }

  return Object.freeze({
    agent(
      prompt: string,
      optionsJson: string | undefined,
      resolveRealm: RealmResolve,
      rejectRealm: RealmReject,
    ): void {
      ensureRunning()
      const options = normalizeAgentOptions(
        optionsJson === undefined ? undefined : JSON.parse(optionsJson) as unknown,
      )
      if (options.label === undefined) options.label = fallbackLabel(prompt)
      if (options.phase === undefined && currentPhase !== undefined) options.phase = currentPhase
      const requestId = nextRequestId('agent')
      pendingAgents.set(requestId, pendingRealmRequest(resolveRealm, rejectRealm))
      send({ type: 'agent.request', requestId, prompt, options })
    },

    workflow(
      targetJson: string,
      argsJson: string,
      argsUndefined: boolean,
      resolveRealm: RealmResolve,
      rejectRealm: RealmReject,
    ): void {
      ensureRunning()
      const requestId = nextRequestId('workflow')
      const target = normalizeWorkflowTarget(JSON.parse(targetJson) as unknown)
      const args = argsUndefined ? undefined : cloneForParent(JSON.parse(argsJson) as unknown)
      pendingWorkflows.set(requestId, pendingRealmRequest(resolveRealm, rejectRealm))
      send({
        type: 'workflow.request',
        requestId,
        target,
        ...(args === undefined ? {} : { args }),
      })
    },

    phase(value: unknown): void {
      ensureRunning()
      const title = String(value)
      const firstSeen = !knownPhases.has(title)
      knownPhases.add(title)
      currentPhase = title
      send({ type: 'phase', title, firstSeen })
    },

    log(text: string): void {
      ensureRunning()
      emitLog('log', text)
    },

    console(level: 'log' | 'info' | 'warn' | 'error', text: string): void {
      ensureRunning()
      emitLog(level, text)
    },

    budgetSpent(): number {
      return budgetSpent
    },

    budgetRemaining(): number {
      return budgetTotal === null ? Number.POSITIVE_INFINITY : Math.max(0, budgetTotal - budgetSpent)
    },

    setTimer(callback: unknown, delayValue: unknown): number {
      ensureRunning()
      if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function')
      if (timers.size >= limits.maxCollectionItems) throw new RangeError('Workflow has too many pending timers')
      const numericDelay = Number(delayValue)
      const delay = Number.isFinite(numericDelay) ? Math.max(0, Math.min(numericDelay, 2_147_483_647)) : 0
      timerSequence += 1
      const timerId = timerSequence
      const timer = setTimeout(() => {
        timers.delete(timerId)
        if (cancelled || terminal) return
        try {
          Reflect.apply(callback, undefined, [])
        } catch (error) {
          finish({ type: 'failed', error: serializeWorkerError(error) })
        }
      }, delay)
      timers.set(timerId, timer)
      return timerId
    },

    clearTimer(timerId: unknown): void {
      const numericId = Number(timerId)
      if (!Number.isInteger(numericId)) return
      const timer = timers.get(numericId)
      if (!timer) return
      clearTimeout(timer)
      timers.delete(numericId)
    },
  })
}

const INITIALIZE_REALM = `
(() => {
  'use strict'
  const bridge = globalThis.__workflowBridge
  const argsJson = globalThis.__workflowArgsJson

  // Capture realm intrinsics before user code can replace JSON.parse, Error, or Promise. The host
  // bridge deliberately returns no Promise or object: every capability result enters as JSON text
  // and is rebuilt here so workflow code can never walk a host constructor back to Node process.
  const RealmPromise = Promise
  const RealmError = Error
  const RealmString = String
  const parseJson = JSON.parse
  const stringifyJson = JSON.stringify
  const request = (start) => new RealmPromise((resolve, reject) => {
    start(
      (json, isUndefined) => resolve(isUndefined ? undefined : parseJson(json)),
      (name, message, stack, code) => {
        const error = new RealmError(message)
        error.name = name
        if (stack !== undefined) error.stack = stack
        if (code !== undefined) error.code = code
        reject(error)
      },
    )
  })

  const agent = (prompt, options) => request((resolve, reject) => {
    const optionsJson = options === undefined ? undefined : stringifyJson(options)
    bridge.agent(RealmString(prompt), optionsJson, resolve, reject)
  })
  const workflow = (targetValue, argsValue) => {
    let target
    if (typeof targetValue === 'string') target = targetValue
    else if (
      typeof targetValue === 'object' &&
      targetValue !== null &&
      typeof targetValue.scriptPath === 'string'
    ) target = { scriptPath: targetValue.scriptPath }
    else throw new TypeError('workflow() expects a saved workflow name or { scriptPath }')

    const targetJson = stringifyJson(target)
    const serializedArgs = stringifyJson(argsValue)
    return request((resolve, reject) => {
      bridge.workflow(
        targetJson,
        serializedArgs === undefined ? '' : serializedArgs,
        serializedArgs === undefined,
        resolve,
        reject,
      )
    })
  }
  const phase = (title) => bridge.phase(title)
  const renderLog = (values) => values.map((value) => RealmString(value)).join(' ')
  const log = (...values) => bridge.log(renderLog(values))

  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions')
    if (thunks.length > globalThis.__workflowMaxCollectionItems) {
      throw new RangeError('parallel() input exceeds the workflow collection limit')
    }
    for (let index = 0; index < thunks.length; index += 1) {
      if (typeof thunks[index] !== 'function') {
        throw new TypeError('parallel() entries must be functions')
      }
    }
    // Budget-exceeded slots are matched by error NAME because that is Claude's own realm contract:
    // its parallel/pipeline catch WorkflowBudgetExceededError specifically and report one aggregate
    // "slots dropped" line instead of a per-slot failure log. Everything else still logs per entry.
    let droppedForBudget = 0
    const settleFailure = (error) => {
      if (error && error.name === 'WorkflowBudgetExceededError') {
        droppedForBudget += 1
        return null
      }
      bridge.console('warn', renderLog(['parallel() entry failed:', error?.message ?? String(error)]))
      return null
    }
    const results = await Promise.all(thunks.map((thunk) => {
      try {
        return Promise.resolve(thunk()).catch(settleFailure)
      } catch (error) {
        return Promise.resolve(settleFailure(error))
      }
    }))
    if (droppedForBudget > 0) {
      bridge.console('warn', 'parallel: ' + droppedForBudget + ' slot' + (droppedForBudget === 1 ? '' : 's') + ' dropped — token budget exceeded')
    }
    return results
  }

  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new TypeError('pipeline() expects an array as its first argument')
    if (items.length > globalThis.__workflowMaxCollectionItems) {
      throw new RangeError('pipeline() input exceeds the workflow collection limit')
    }
    for (const stage of stages) {
      if (typeof stage !== 'function') throw new TypeError('pipeline() stages must be functions')
    }

    let droppedForBudget = 0
    const isCoverageGap = (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const marker = value.__workflowAgentFailure
      return marker !== null && typeof marker === 'object' &&
        marker.schemaVersion === 1 && marker.coverageGap === true
    }
    const results = await Promise.all(items.map(async (original, index) => {
      let current = original
      try {
        for (const stage of stages) {
          // WHY coverage gaps are terminal pipeline values, not ordinary stage output: feeding a
          // failed research assignment into later agents wastes budget and can turn supervisor
          // metadata into prompts a workflow never intended. Keep the typed placeholder in the
          // result array for synthesis, but stop only this item while healthy siblings advance.
          if (current === null || isCoverageGap(current)) break
          current = await stage(current, original, index)
        }
        return current
      } catch (error) {
        if (error && error.name === 'WorkflowBudgetExceededError') {
          droppedForBudget += 1
          return null
        }
        bridge.console('warn', renderLog(['pipeline() item failed:', error?.message ?? String(error)]))
        return null
      }
    }))
    if (droppedForBudget > 0) {
      bridge.console('warn', 'pipeline: ' + droppedForBudget + ' slot' + (droppedForBudget === 1 ? '' : 's') + ' dropped — token budget exceeded')
    }
    return results
  }

  const workflowConsole = Object.freeze({
    log: (...values) => bridge.console('log', renderLog(values)),
    info: (...values) => bridge.console('info', renderLog(values)),
    warn: (...values) => bridge.console('warn', renderLog(values)),
    error: (...values) => bridge.console('error', renderLog(values)),
  })

  const budget = Object.freeze({
    total: globalThis.__workflowBudgetTotal,
    spent: () => bridge.budgetSpent(),
    remaining: () => bridge.budgetRemaining(),
  })

  const setTimeout = (callback, delay) => bridge.setTimer(callback, delay)
  const clearTimeout = (timerId) => bridge.clearTimer(timerId)

  const NativeDate = Date
  class WorkflowDate extends NativeDate {
    constructor(...values) {
      if (values.length === 0) throw new Error('Argumentless Date is unavailable in workflow code')
      super(...values)
    }
    static now() {
      throw new Error('Date.now() is unavailable in workflow code')
    }
  }
  Object.freeze(WorkflowDate)
  Object.defineProperty(Math, 'random', {
    value() { throw new Error('Math.random() is unavailable in workflow code') },
    configurable: false,
    writable: false,
  })

  Object.defineProperties(globalThis, {
    agent: { value: Object.freeze(agent), enumerable: true },
    parallel: { value: Object.freeze(parallel), enumerable: true },
    pipeline: { value: Object.freeze(pipeline), enumerable: true },
    workflow: { value: Object.freeze(workflow), enumerable: true },
    phase: { value: Object.freeze(phase), enumerable: true },
    log: { value: Object.freeze(log), enumerable: true },
    args: { value: argsJson === undefined ? undefined : JSON.parse(argsJson), enumerable: true },
    budget: { value: budget, enumerable: true },
    console: { value: workflowConsole, enumerable: true },
    setTimeout: { value: Object.freeze(setTimeout), enumerable: true },
    clearTimeout: { value: Object.freeze(clearTimeout), enumerable: true },
    Date: { value: WorkflowDate },
  })

  delete globalThis.__workflowBridge
  delete globalThis.__workflowArgsJson
  delete globalThis.__workflowBudgetTotal
  delete globalThis.__workflowMaxCollectionItems
})()
`

async function execute(message: Extract<ParentToWorkerMessage, { type: 'start' }>): Promise<void> {
  limits = message.limits
  budgetTotal = message.budgetTotal
  budgetSpent = message.budgetSpent
  // Start only after the parent provides its watchdog policy. A hard-coded 5s emitter paired with
  // a valid 1s parent deadline deterministically killed a healthy evaluator before its first tick.
  heartbeatTimer = setInterval(() => {
    if (terminal) return
    send({
      type: 'heartbeat',
      pendingRequests: pendingAgents.size + pendingWorkflows.size,
      timers: timers.size,
    })
  }, message.heartbeatIntervalMs)
  heartbeatTimer.unref?.()

  const sandbox = Object.create(null) as Record<string, unknown>
  sandbox.__workflowBridge = makeBridge(message.metadataPhases)
  sandbox.__workflowArgsJson = message.argsJson
  sandbox.__workflowBudgetTotal = message.budgetTotal
  sandbox.__workflowMaxCollectionItems = limits.maxCollectionItems

  const context = vm.createContext(sandbox, {
    name: `workflow:${message.runId}`,
    codeGeneration: { strings: false, wasm: false },
  })
  new vm.Script(INITIALIZE_REALM, { filename: 'workflow-runtime.js' }).runInContext(context, {
    timeout: limits.synchronousTimeoutMs,
  })

  const filename = message.filePath ?? `workflow:${message.runId}`
  const wrappedBody = `'use strict';\n(async () => {\n${message.body}\n})()`
  const script = new vm.Script(wrappedBody, { filename })
  const result = script.runInContext(context, { timeout: limits.synchronousTimeoutMs }) as Promise<unknown>
  const value = await result
  finish({ type: 'complete', value: cloneForParent(value) })
}

function receive(message: ParentToWorkerMessage): void {
  if (message.type === 'start') {
    if (started) {
      finish({ type: 'failed', error: serializeWorkerError(new Error('Workflow worker received start twice')) })
      return
    }
    started = true
    void execute(message).catch((error: unknown) => {
      finish({ type: 'failed', error: serializeWorkerError(error) })
    })
    return
  }

  if (message.type === 'cancel') {
    if (terminal) return
    cancelled = true
    cancelReason = message.reason
    clearTimers()
    rejectPending(cancellationError())
    return
  }

  if (message.type === 'agent.result') {
    budgetSpent = message.budgetSpent
    const pending = pendingAgents.get(message.requestId)
    if (!pending) return
    pendingAgents.delete(message.requestId)
    if (message.result.type === 'success') pending.resolve(message.result.value)
    else {
      const error = new Error(message.result.error.message)
      error.name = message.result.error.name
      if (message.result.error.stack !== undefined) error.stack = message.result.error.stack
      if (message.result.error.code !== undefined) Object.assign(error, { code: message.result.error.code })
      pending.reject(error)
    }
    return
  }

  budgetSpent = message.budgetSpent
  const pending = pendingWorkflows.get(message.requestId)
  if (!pending) return
  pendingWorkflows.delete(message.requestId)
  if (message.result.type === 'success') pending.resolve(message.result.value)
  else {
    const error = new Error(message.result.error.message)
    error.name = message.result.error.name
    if (message.result.error.stack !== undefined) error.stack = message.result.error.stack
    if (message.result.error.code !== undefined) Object.assign(error, { code: message.result.error.code })
    pending.reject(error)
  }
}

let transportStarted = false

/**
 * Install the worker-side transport for either Node child_process or Electron utilityProcess.
 *
 * WHY this is exported even though the standalone worker starts itself below: Electron's main
 * bundle needs a stable public entry it can call from its separately-built utility-process file.
 * Keeping that entry public prevents Agent Code from importing package internals, while the guard
 * makes the automatic standalone call and an explicit embedder call safely idempotent.
 */
export function startWorkflowWorker(): void {
  if (transportStarted) return
  transportStarted = true

  if (electronParentPort) {
    electronParentPort.on('message', (event) => receive(event.data))
  } else {
    process.on('message', (message: ParentToWorkerMessage) => receive(message))
    process.on('disconnect', () => {
      if (!terminal) {
        cancelled = true
        clearTimers()
        rejectPending(cancellationError())
      }
    })
  }
  process.on('uncaughtException', (error) => finish({ type: 'failed', error: serializeWorkerError(error) }))
  process.on('unhandledRejection', (error) => finish({ type: 'failed', error: serializeWorkerError(error) }))
  send({ type: 'ready' })
}

startWorkflowWorker()
