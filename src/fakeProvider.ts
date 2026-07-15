import {
  AgentProviderAbortError,
  AgentProviderFailure,
  throwIfAgentProviderAborted,
} from './agentProvider.js'
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderExecutionContext,
  AgentProviderOutput,
  AgentProviderResult,
  AgentRequest,
  AgentUsage,
  ProviderSessionReference,
} from './agentProvider.js'

export type FakeProviderExpectedRequest = {
  prompt?: string | RegExp
  model?: string
  workingDirectory?: string
  /** Use null to assert that this call creates a new session rather than resuming one. */
  sessionId?: string | null
}

export type FakeProviderEmission = {
  /** Delay before this event, not since the beginning of the call. */
  delayMs?: number
  event: Exclude<AgentProviderEvent, { type: 'session.started' }>
}

export type FakeProviderOutcome =
  | {
      type: 'result'
      output: AgentProviderOutput
      usage?: AgentUsage
      diagnostics?: Readonly<Record<string, unknown>>
    }
  | {
      type: 'provider-failure'
      message: string
      code?: string
      retryable?: boolean
    }
  | { type: 'error'; error: Error }
  | { type: 'wait-for-abort' }

export type FakeProviderScript = {
  name?: string
  expect?: FakeProviderExpectedRequest
  /** Defaults to the resumed ID, or a deterministic `fake-session-N` for a new call. */
  sessionId?: string
  /** False simulates a provider wedged before it establishes a resumable session. */
  emitSession?: boolean
  events?: readonly FakeProviderEmission[]
  /** Delay after all activities and before the terminal outcome. */
  delayMs?: number
  outcome: FakeProviderOutcome
}

export type FakeProviderCallStatus = 'running' | 'completed' | 'provider-failure' | 'error' | 'aborted'

export type FakeProviderCall = {
  index: number
  scriptName?: string
  request: AgentRequest
  providerSession: ProviderSessionReference
  emittedEvents: AgentProviderEvent[]
  status: FakeProviderCallStatus
}

/**
 * This fake is deliberately queue-based. Invocation order is the only deterministic identity the
 * workflow runtime has before journal keys and logical-agent IDs are added. Prompt-keyed lookup
 * would hide duplicate-prompt ordering bugs and make concurrency tests pass for the wrong reason.
 */
export class FakeAgentProvider implements AgentProvider {
  readonly calls: FakeProviderCall[] = []
  readonly completionOrder: number[] = []
  readonly providerName: string

  #scripts: readonly FakeProviderScript[]
  #nextScript = 0
  #activeExecutions = 0
  #maxConcurrentExecutions = 0

  constructor(scripts: readonly FakeProviderScript[], options: { providerName?: string } = {}) {
    this.providerName = options.providerName ?? 'fake'
    if (this.providerName.length === 0) throw new FakeProviderSetupError('providerName must not be empty')
    scripts.forEach(validateScript)
    // Copy the outer queue so a test cannot reorder future outcomes while calls are in flight.
    this.#scripts = [...scripts]
  }

  get name(): string {
    return this.providerName
  }

  get activeExecutions(): number {
    return this.#activeExecutions
  }

  get maxConcurrentExecutions(): number {
    return this.#maxConcurrentExecutions
  }

  get remainingScripts(): number {
    return this.#scripts.length - this.#nextScript
  }

  assertExhausted(): void {
    if (this.remainingScripts !== 0) {
      throw new FakeProviderSetupError(`${this.remainingScripts} fake provider script(s) were not consumed`)
    }
  }

  async execute(request: AgentRequest, context: AgentProviderExecutionContext): Promise<AgentProviderResult> {
    const index = this.#nextScript
    const script = this.#scripts[index]
    if (!script) throw new FakeProviderSetupError(`No fake provider script exists for call ${index}`)
    throwIfAgentProviderAborted(context.signal)
    assertExpectedRequest(script.expect, request, index)
    if (request.session !== undefined && request.session.provider !== this.providerName) {
      throw new FakeProviderSetupError(
        `Call ${index} cannot resume ${JSON.stringify(request.session.provider)} with the ${JSON.stringify(this.providerName)} provider`,
      )
    }
    this.#nextScript += 1

    const providerSession: ProviderSessionReference = {
      provider: this.providerName,
      id: script.sessionId ?? request.session?.id ?? `fake-session-${index + 1}`,
    }
    const call: FakeProviderCall = {
      index,
      ...(script.name === undefined ? {} : { scriptName: script.name }),
      request,
      providerSession,
      emittedEvents: [],
      status: 'running',
    }
    this.calls.push(call)
    this.#activeExecutions += 1
    this.#maxConcurrentExecutions = Math.max(this.#maxConcurrentExecutions, this.#activeExecutions)

    try {
      if (script.emitSession !== false) {
        await this.#emit(call, context, { type: 'session.started', session: providerSession })
      }
      for (const emission of script.events ?? []) {
        await abortableDelay(emission.delayMs ?? 0, context.signal)
        await this.#emit(call, context, emission.event)
      }

      await abortableDelay(script.delayMs ?? 0, context.signal)
      const result = await settleOutcome(script.outcome, providerSession, context.signal)
      call.status = 'completed'
      return result
    } catch (error) {
      if (error instanceof AgentProviderAbortError || context.signal.aborted) call.status = 'aborted'
      else if (error instanceof AgentProviderFailure) call.status = 'provider-failure'
      else call.status = 'error'
      throw error
    } finally {
      // Completion order records every terminal path, not just success. This makes it possible to
      // prove that scheduler settlement order cannot accidentally become workflow result order.
      this.completionOrder.push(index)
      this.#activeExecutions -= 1
    }
  }

  async #emit(
    call: FakeProviderCall,
    context: AgentProviderExecutionContext,
    event: AgentProviderEvent,
  ): Promise<void> {
    throwIfAgentProviderAborted(context.signal)
    await context.emit(event)
    call.emittedEvents.push(event)
  }
}

export class FakeProviderSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FakeProviderSetupError'
  }
}

async function settleOutcome(
  outcome: FakeProviderOutcome,
  providerSession: ProviderSessionReference,
  signal: AbortSignal,
): Promise<AgentProviderResult> {
  switch (outcome.type) {
    case 'result':
      return {
        output: outcome.output,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        providerSession,
        ...(outcome.diagnostics === undefined ? {} : { diagnostics: outcome.diagnostics }),
      }
    case 'provider-failure':
      throw new AgentProviderFailure(outcome.message, {
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
        providerSession,
      })
    case 'error':
      throw outcome.error
    case 'wait-for-abort':
      await waitForAbort(signal)
      throw new FakeProviderSetupError('waitForAbort unexpectedly resolved')
  }
}

function assertExpectedRequest(
  expected: FakeProviderExpectedRequest | undefined,
  request: AgentRequest,
  index: number,
): void {
  if (!expected) return
  let promptMatches = true
  if (typeof expected.prompt === 'string') promptMatches = request.prompt === expected.prompt
  else if (expected.prompt) {
    // Global/sticky regexes retain lastIndex. Reset it so reusing one expectation across fake calls
    // does not make every second identical prompt fail depending on the previous call.
    expected.prompt.lastIndex = 0
    promptMatches = expected.prompt.test(request.prompt)
    expected.prompt.lastIndex = 0
  }
  if (!promptMatches) {
    throw new FakeProviderSetupError(`Call ${index} prompt did not match its script`)
  }
  if (expected.model !== undefined && request.model !== expected.model) {
    throw new FakeProviderSetupError(`Call ${index} expected model ${JSON.stringify(expected.model)}`)
  }
  if (expected.workingDirectory !== undefined && request.workingDirectory !== expected.workingDirectory) {
    throw new FakeProviderSetupError(`Call ${index} expected working directory ${JSON.stringify(expected.workingDirectory)}`)
  }
  if (expected.sessionId !== undefined && (request.session?.id ?? null) !== expected.sessionId) {
    throw new FakeProviderSetupError(`Call ${index} expected session ${JSON.stringify(expected.sessionId)}`)
  }
}

function validateScript(script: FakeProviderScript, index: number): void {
  const prefix = `Fake provider script ${index}`
  validateDelay(script.delayMs, `${prefix} delayMs`)
  if (script.sessionId !== undefined && script.sessionId.length === 0) {
    throw new FakeProviderSetupError(`${prefix} sessionId must not be empty`)
  }
  if (script.emitSession !== undefined && typeof script.emitSession !== 'boolean') {
    throw new FakeProviderSetupError(`${prefix} emitSession must be boolean`)
  }
  if (!script.outcome || typeof script.outcome !== 'object') {
    throw new FakeProviderSetupError(`${prefix} must have an outcome`)
  }
  if (!['result', 'provider-failure', 'error', 'wait-for-abort'].includes(script.outcome.type)) {
    throw new FakeProviderSetupError(`${prefix} has an unknown outcome`)
  }
  if (script.outcome.type === 'result') {
    validateOutput(script.outcome.output, prefix)
    if (script.outcome.usage !== undefined) validateUsage(script.outcome.usage, prefix)
  }
  if (
    script.outcome.type === 'provider-failure' &&
    (typeof script.outcome.message !== 'string' || script.outcome.message.length === 0)
  ) {
    throw new FakeProviderSetupError(`${prefix} provider failure message must not be empty`)
  }
  if (script.outcome.type === 'error' && !(script.outcome.error instanceof Error)) {
    throw new FakeProviderSetupError(`${prefix} error outcome must contain an Error`)
  }
  for (const [eventIndex, emission] of (script.events ?? []).entries()) {
    validateDelay(emission.delayMs, `${prefix} event ${eventIndex} delayMs`)
    validateEvent(emission.event, `${prefix} event ${eventIndex}`)
  }
}

function validateOutput(output: AgentProviderOutput, prefix: string): void {
  if (!output || typeof output !== 'object') throw new FakeProviderSetupError(`${prefix} result output is invalid`)
  if (output.type === 'text' && typeof output.text === 'string') return
  if (output.type === 'structured' && 'value' in output) return
  throw new FakeProviderSetupError(`${prefix} result output is invalid`)
}

function validateEvent(event: FakeProviderEmission['event'], prefix: string): void {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new FakeProviderSetupError(`${prefix} is invalid`)
  }
  if (event.type === 'warning') {
    if (typeof event.message !== 'string') throw new FakeProviderSetupError(`${prefix} warning message is invalid`)
    return
  }
  if (event.type === 'activity.updated') {
    if (event.activityId.length === 0) throw new FakeProviderSetupError(`${prefix} activityId must not be empty`)
    if (!event.patch || typeof event.patch !== 'object') {
      throw new FakeProviderSetupError(`${prefix} activity patch is invalid`)
    }
    if (event.patch.kind !== undefined && !ACTIVITY_KINDS.has(event.patch.kind)) {
      throw new FakeProviderSetupError(`${prefix} activity kind is invalid`)
    }
    return
  }
  if (event.type === 'activity.started' || event.type === 'activity.completed') {
    if (event.activity.id.length === 0) throw new FakeProviderSetupError(`${prefix} activity id must not be empty`)
    if (!ACTIVITY_KINDS.has(event.activity.kind)) {
      throw new FakeProviderSetupError(`${prefix} activity kind is invalid`)
    }
    return
  }
  throw new FakeProviderSetupError(`${prefix} has an unknown event type`)
}

const ACTIVITY_KINDS = new Set([
  'message',
  'reasoning',
  'command',
  'file_change',
  'tool_call',
  'web_search',
  'todo_list',
  'error',
])

function validateUsage(usage: AgentUsage, prefix: string): void {
  if (!usage || typeof usage !== 'object') throw new FakeProviderSetupError(`${prefix} usage is invalid`)
  for (const [name, count] of Object.entries(usage)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new FakeProviderSetupError(`${prefix} usage.${name} must be a non-negative safe integer`)
    }
  }
  if (!('inputTokens' in usage) || !('outputTokens' in usage)) {
    throw new FakeProviderSetupError(`${prefix} usage requires inputTokens and outputTokens`)
  }
}

function validateDelay(delayMs: number | undefined, label: string): void {
  if (delayMs !== undefined && (!Number.isFinite(delayMs) || delayMs < 0)) {
    throw new FakeProviderSetupError(`${label} must be a finite non-negative number`)
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAgentProviderAborted(signal)
  if (delayMs === 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new AgentProviderAbortError(signal.reason))
    }
    function finish(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  throwIfAgentProviderAborted(signal)
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new AgentProviderAbortError(signal.reason)), {
      once: true,
    })
  })
}
