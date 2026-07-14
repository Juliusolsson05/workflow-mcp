import type {
  AgentOutcome,
  AgentUsage,
  ArtifactCreatedEvent,
  ContentReference,
  NormalizedAgentOptions,
  ProviderSessionReference,
  WorkflowActivityDetails,
  WorkflowDefinitionReference,
  WorkflowErrorReference,
  WorkflowEvent,
  WorkflowEventType,
} from './workflowEvents.js'

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'cancellation_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type WorkflowAgentStatus =
  | 'admitted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type WorkflowAttemptStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowActivityStatus = 'running' | 'completed' | 'failed'

export type WorkflowActivitySnapshot = WorkflowActivityDetails & {
  status: WorkflowActivityStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  error?: WorkflowErrorReference
  updateCount: number
}

export type WorkflowAttemptSnapshot = {
  id: string
  number: number
  source: 'live' | 'provider-resume'
  provider: string
  status: WorkflowAttemptStatus
  startedAt: string
  completedAt?: string
  providerSession?: ProviderSessionReference
  usage?: AgentUsage
  error?: WorkflowErrorReference
  activities: WorkflowActivitySnapshot[]
}

export type WorkflowAgentSnapshot = {
  id: string
  callIndex: number
  label: string
  phaseId?: string
  prompt: ContentReference
  options: NormalizedAgentOptions
  cacheKey: string
  status: WorkflowAgentStatus
  admittedAt: string
  queuedAt?: string
  startedAt?: string
  completedAt?: string
  outcome?: AgentOutcome
  error?: WorkflowErrorReference
  skippedReason?: string
  cancelledReason?: string
  attempts: WorkflowAttemptSnapshot[]
}

export type WorkflowPhaseSnapshot = {
  id: string
  title: string
  detail?: string
  model?: string
  source: 'metadata' | 'runtime'
  discoveredAt: string
  enteredAt?: string
  completedAt?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error?: WorkflowErrorReference
  agentIds: string[]
  /**
   * WHY this is a boolean rather than a normal running/completed state: an explicit phase can be
   * assigned another agent much later, so no intermediate event proves phase completion. It only
   * becomes safe to call a phase complete after the run is terminal and every member is terminal.
   */
  complete: boolean
}

export type WorkflowAgentCounts = {
  total: number
  admitted: number
  queued: number
  running: number
  completed: number
  failed: number
  skipped: number
  cancelled: number
  /** Journal reuse is a subset of completed, not a second logical agent. */
  reused: number
  attempts: number
}

export type WorkflowLogSnapshot = {
  eventId: string
  sequence: number
  timestamp: string
  phaseId?: string
  agentId?: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: ContentReference
}

export type WorkflowWarningSnapshot = {
  eventId: string
  sequence: number
  timestamp: string
  phaseId?: string
  agentId?: string
  attemptId?: string
  message: string
  code?: string
  details?: unknown
}

export type WorkflowArtifactSnapshot = ArtifactCreatedEvent['payload'] & {
  eventId: string
  sequence: number
  timestamp: string
  phaseId?: string
  agentId?: string
  attemptId?: string
}

export type WorkflowSnapshot = {
  schemaVersion: 1
  runId: string
  sequence: number
  status: WorkflowRunStatus
  workflow?: WorkflowDefinitionReference
  startedAt?: string
  completedAt?: string
  cancellationReason?: string
  result?: ContentReference
  error?: WorkflowErrorReference
  currentPhaseId?: string
  counts: WorkflowAgentCounts
  phases: WorkflowPhaseSnapshot[]
  agents: WorkflowAgentSnapshot[]
  logs: WorkflowLogSnapshot[]
  warnings: WorkflowWarningSnapshot[]
  artifacts: WorkflowArtifactSnapshot[]
}

const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
const TERMINAL_AGENT_STATUSES = new Set<WorkflowAgentStatus>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

export function createWorkflowState(runId: string): WorkflowSnapshot {
  return {
    schemaVersion: 1,
    runId,
    sequence: 0,
    status: 'pending',
    counts: emptyCounts(),
    phases: [],
    agents: [],
    logs: [],
    warnings: [],
    artifacts: [],
  }
}

function emptyCounts(): WorkflowAgentCounts {
  return {
    total: 0,
    admitted: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    reused: 0,
    attempts: 0,
  }
}

function agentIndex(state: WorkflowSnapshot, agentId: string, eventType: WorkflowEventType): number {
  const index = state.agents.findIndex((agent) => agent.id === agentId)
  if (index === -1) {
    throw new Error(`${eventType} referenced unknown agent ${JSON.stringify(agentId)}`)
  }
  return index
}

function attemptIndex(
  agent: WorkflowAgentSnapshot,
  attemptId: string,
  eventType: WorkflowEventType,
): number {
  const index = agent.attempts.findIndex((attempt) => attempt.id === attemptId)
  if (index === -1) {
    throw new Error(`${eventType} referenced unknown attempt ${JSON.stringify(attemptId)}`)
  }
  return index
}

function updateAgent(
  state: WorkflowSnapshot,
  agentId: string,
  eventType: WorkflowEventType,
  update: (agent: WorkflowAgentSnapshot) => WorkflowAgentSnapshot,
): WorkflowSnapshot {
  const index = agentIndex(state, agentId, eventType)
  const current = state.agents[index]
  if (!current) throw new Error(`Agent index ${index} disappeared during ${eventType}`)
  const agents = state.agents.slice()
  agents[index] = update(current)
  return { ...state, agents }
}

function updateAttempt(
  state: WorkflowSnapshot,
  agentId: string,
  attemptId: string,
  eventType: WorkflowEventType,
  update: (attempt: WorkflowAttemptSnapshot) => WorkflowAttemptSnapshot,
): WorkflowSnapshot {
  return updateAgent(state, agentId, eventType, (agent) => {
    const index = attemptIndex(agent, attemptId, eventType)
    const current = agent.attempts[index]
    if (!current) throw new Error(`Attempt index ${index} disappeared during ${eventType}`)
    const attempts = agent.attempts.slice()
    attempts[index] = update(current)
    return { ...agent, attempts }
  })
}

function applyAgentOutcome(
  state: WorkflowSnapshot,
  agentId: string,
  attemptId: string | undefined,
  outcome: AgentOutcome,
  timestamp: string,
  eventType: 'agent.completed' | 'agent.reused',
): WorkflowSnapshot {
  let next = updateAgent(state, agentId, eventType, (agent) => {
    // A retry error belongs to its attempt. Leaving it on a subsequently completed logical agent
    // would make an inspector show a successful result and a terminal error at the same time.
    const { error: _previousAttemptError, ...agentWithoutError } = agent
    return {
      ...agentWithoutError,
      status: 'completed',
      completedAt: timestamp,
      outcome,
    }
  })

  if (attemptId !== undefined) {
    next = updateAttempt(next, agentId, attemptId, eventType, (attempt) => ({
      ...attempt,
      status: 'completed',
      completedAt: timestamp,
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      ...(outcome.providerSession === undefined
        ? {}
        : { providerSession: outcome.providerSession }),
    }))
  }

  return next
}

function deriveCounts(agents: WorkflowAgentSnapshot[]): WorkflowAgentCounts {
  const counts = emptyCounts()
  counts.total = agents.length

  for (const agent of agents) {
    counts[agent.status] += 1
    counts.attempts += agent.attempts.length
    if (agent.outcome?.source === 'journal') counts.reused += 1
  }
  return counts
}

function derivePhases(
  phases: WorkflowPhaseSnapshot[],
  agents: WorkflowAgentSnapshot[],
  runStatus: WorkflowRunStatus,
): WorkflowPhaseSnapshot[] {
  const runIsTerminal = TERMINAL_RUN_STATUSES.has(runStatus)
  return phases.map((phase) => ({
    ...phase,
    complete:
      phase.status === 'completed' ||
      (phase.status !== 'failed' && runIsTerminal &&
      phase.agentIds.every((id) => {
        const agent = agents.find((candidate) => candidate.id === id)
        return agent !== undefined && TERMINAL_AGENT_STATUSES.has(agent.status)
      })),
  }))
}

function finalizeDerivedState(state: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...state,
    counts: deriveCounts(state.agents),
    phases: derivePhases(state.phases, state.agents, state.status),
  }
}

function assertNever(event: never): never {
  throw new Error(`Unhandled workflow event: ${JSON.stringify(event)}`)
}

/**
 * Project one authoritative event into a new immutable snapshot.
 *
 * WHY invalid ordering throws instead of being papered over: persistence and live delivery will
 * eventually replay exactly this stream. Accepting a cross-run event, a duplicate sequence, or
 * activity for an unknown attempt would produce a plausible but false inspector—the most
 * expensive kind of failure to diagnose in a 76-agent run.
 */
export function reduceWorkflowState(
  state: WorkflowSnapshot,
  event: WorkflowEvent,
): WorkflowSnapshot {
  if (event.runId !== state.runId) {
    throw new Error(`Event for run ${JSON.stringify(event.runId)} cannot update ${JSON.stringify(state.runId)}`)
  }
  if (event.sequence <= state.sequence) {
    throw new Error(`Event sequence ${event.sequence} must be greater than ${state.sequence}`)
  }
  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    throw new Error(
      `${event.type} cannot update terminal workflow state ${JSON.stringify(state.status)}`,
    )
  }

  let next: WorkflowSnapshot = { ...state, sequence: event.sequence }

  switch (event.type) {
    case 'run.started':
      next = {
        ...next,
        status: 'running',
        workflow: event.payload.workflow,
        startedAt: event.timestamp,
      }
      break

    case 'run.completed':
      next = {
        ...next,
        status: 'completed',
        completedAt: event.timestamp,
        result: event.payload.result,
      }
      break

    case 'run.failed':
      next = {
        ...next,
        status: 'failed',
        completedAt: event.timestamp,
        error: event.payload.error,
      }
      break

    case 'run.cancellation_requested':
      next = {
        ...next,
        status: 'cancellation_requested',
        ...(event.payload.reason === undefined
          ? {}
          : { cancellationReason: event.payload.reason }),
      }
      break

    case 'run.cancelled':
      next = {
        ...next,
        status: 'cancelled',
        completedAt: event.timestamp,
        ...(event.payload.reason === undefined
          ? {}
          : { cancellationReason: event.payload.reason }),
      }
      break

    case 'run.interrupted':
      next = {
        ...next,
        status: 'interrupted',
        completedAt: event.timestamp,
        error: {
          name: 'WorkflowInterruptedError',
          code: 'run-interrupted',
          message: event.payload.reason,
        },
      }
      break

    case 'phase.discovered': {
      // The runtime promises one discovery event per phase. Guarding here preserves the original
      // order and prevents a later duplicate from silently rewriting metadata shown for old runs.
      if (next.phases.some((phase) => phase.id === event.phaseId)) {
        throw new Error(`phase.discovered repeated phase ${JSON.stringify(event.phaseId)}`)
      }
      next = {
        ...next,
        phases: [
          ...next.phases,
          {
            id: event.phaseId,
            title: event.payload.title,
            source: event.payload.source,
            discoveredAt: event.timestamp,
            agentIds: [],
            status: 'pending',
            complete: false,
            ...(event.payload.detail === undefined ? {} : { detail: event.payload.detail }),
            ...(event.payload.model === undefined ? {} : { model: event.payload.model }),
          },
        ],
      }
      break
    }

    case 'phase.entered': {
      const index = next.phases.findIndex((phase) => phase.id === event.phaseId)
      if (index === -1) {
        throw new Error(`phase.entered referenced unknown phase ${JSON.stringify(event.phaseId)}`)
      }
      const phases = next.phases.slice()
      const phase = phases[index]
      if (!phase) throw new Error(`Phase index ${index} disappeared during phase.entered`)
      phases[index] = { ...phase, enteredAt: event.timestamp, status: 'running' }
      next = { ...next, phases, currentPhaseId: event.phaseId }
      break
    }

    case 'phase.completed': {
      const index = next.phases.findIndex((phase) => phase.id === event.phaseId)
      if (index === -1) {
        throw new Error(`phase.completed referenced unknown phase ${JSON.stringify(event.phaseId)}`)
      }
      const phases = next.phases.slice()
      const phase = phases[index]
      if (!phase) throw new Error(`Phase index ${index} disappeared during phase.completed`)
      phases[index] = { ...phase, status: 'completed', complete: true, completedAt: event.timestamp }
      next = { ...next, phases }
      break
    }

    case 'phase.failed': {
      const index = next.phases.findIndex((phase) => phase.id === event.phaseId)
      if (index === -1) {
        throw new Error(`phase.failed referenced unknown phase ${JSON.stringify(event.phaseId)}`)
      }
      const phases = next.phases.slice()
      const phase = phases[index]
      if (!phase) throw new Error(`Phase index ${index} disappeared during phase.failed`)
      phases[index] = {
        ...phase,
        status: 'failed',
        complete: false,
        completedAt: event.timestamp,
        error: event.payload.error,
      }
      next = { ...next, phases }
      break
    }

    case 'agent.admitted': {
      if (next.agents.some((agent) => agent.id === event.agentId)) {
        throw new Error(`agent.admitted repeated agent ${JSON.stringify(event.agentId)}`)
      }
      if (next.agents.some((agent) => agent.callIndex === event.payload.callIndex)) {
        throw new Error(`agent.admitted repeated call index ${event.payload.callIndex}`)
      }

      const agent: WorkflowAgentSnapshot = {
        id: event.agentId,
        callIndex: event.payload.callIndex,
        label: event.payload.label,
        prompt: event.payload.prompt,
        options: event.payload.options,
        cacheKey: event.payload.cacheKey,
        status: 'admitted',
        admittedAt: event.timestamp,
        attempts: [],
        ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
      }
      const agents = [...next.agents, agent].sort((left, right) => left.callIndex - right.callIndex)
      next = { ...next, agents }

      if (event.phaseId !== undefined) {
        const index = next.phases.findIndex((phase) => phase.id === event.phaseId)
        if (index === -1) {
          throw new Error(`agent.admitted referenced unknown phase ${JSON.stringify(event.phaseId)}`)
        }
        const phases = next.phases.slice()
        const phase = phases[index]
        if (!phase) throw new Error(`Phase index ${index} disappeared during agent.admitted`)
        // Sort membership by the same call index used by journal identity. Event arrival normally
        // already has this order, but replaying concurrent emissions must not scramble `1/17`.
        const agentIds = [...phase.agentIds, event.agentId].sort((leftId, rightId) => {
          const left = agents.find((candidate) => candidate.id === leftId)
          const right = agents.find((candidate) => candidate.id === rightId)
          return (left?.callIndex ?? 0) - (right?.callIndex ?? 0)
        })
        phases[index] = { ...phase, agentIds }
        next = { ...next, phases }
      }
      break
    }

    case 'agent.queued':
      next = updateAgent(next, event.agentId, event.type, (agent) => ({
        ...agent,
        status: 'queued',
        queuedAt: event.timestamp,
      }))
      break

    case 'agent.reused':
      if (event.payload.source !== 'journal') {
        throw new Error('agent.reused outcome source must be journal')
      }
      if (event.attemptId !== undefined) {
        throw new Error('agent.reused cannot reference a provider attempt')
      }
      next = applyAgentOutcome(next, event.agentId, undefined, event.payload, event.timestamp, event.type)
      break

    case 'agent.started':
      next = updateAgent(next, event.agentId, event.type, (agent) => {
        if (agent.attempts.some((attempt) => attempt.id === event.attemptId)) {
          throw new Error(`agent.started repeated attempt ${JSON.stringify(event.attemptId)}`)
        }
        if (agent.attempts.some((attempt) => attempt.number === event.payload.attemptNumber)) {
          throw new Error(`agent.started repeated attempt number ${event.payload.attemptNumber}`)
        }
        const attempt: WorkflowAttemptSnapshot = {
          id: event.attemptId,
          number: event.payload.attemptNumber,
          source: event.payload.source,
          provider: event.payload.provider,
          status: 'running',
          startedAt: event.timestamp,
          activities: [],
          ...(event.payload.providerSession === undefined
            ? {}
            : { providerSession: event.payload.providerSession }),
        }
        return {
          ...agent,
          status: 'running',
          startedAt: agent.startedAt ?? event.timestamp,
          attempts: [...agent.attempts, attempt].sort((left, right) => left.number - right.number),
        }
      })
      break

    case 'agent.session.started':
      next = updateAttempt(next, event.agentId, event.attemptId, event.type, (attempt) => ({
        ...attempt,
        providerSession: event.payload.session,
      }))
      break

    case 'agent.activity.started':
      next = updateAttempt(next, event.agentId, event.attemptId, event.type, (attempt) => {
        if (
          attempt.activities.some(
            (activity) => activity.activityId === event.payload.activity.activityId,
          )
        ) {
          throw new Error(
            `agent.activity.started repeated activity ${JSON.stringify(event.payload.activity.activityId)}`,
          )
        }
        return {
          ...attempt,
          activities: [
            ...attempt.activities,
            {
              ...event.payload.activity,
              status: 'running',
              startedAt: event.timestamp,
              updatedAt: event.timestamp,
              updateCount: 0,
            },
          ],
        }
      })
      break

    case 'agent.activity.updated':
    case 'agent.activity.completed':
      next = updateAttempt(next, event.agentId, event.attemptId, event.type, (attempt) => {
        const index = attempt.activities.findIndex(
          (activity) => activity.activityId === event.payload.activityId,
        )
        if (index === -1) {
          throw new Error(
            `${event.type} referenced unknown activity ${JSON.stringify(event.payload.activityId)}`,
          )
        }
        const current = attempt.activities[index]
        if (!current) throw new Error(`Activity index ${index} disappeared during ${event.type}`)
        const activities = attempt.activities.slice()
        activities[index] = {
          ...current,
          updatedAt: event.timestamp,
          updateCount: current.updateCount + (event.type === 'agent.activity.updated' ? 1 : 0),
          ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
          ...(event.payload.content === undefined ? {} : { content: event.payload.content }),
          ...(event.payload.data === undefined ? {} : { data: event.payload.data }),
          ...(event.type === 'agent.activity.completed'
            ? {
                status: event.payload.error === undefined ? ('completed' as const) : ('failed' as const),
                completedAt: event.timestamp,
                ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
              }
            : {}),
        }
        return { ...attempt, activities }
      })
      break

    case 'agent.completed':
      next = applyAgentOutcome(
        next,
        event.agentId,
        event.attemptId,
        event.payload,
        event.timestamp,
        event.type,
      )
      break

    case 'agent.failed':
      next = updateAgent(next, event.agentId, event.type, (agent) => {
        let attempts = agent.attempts
        if (event.attemptId !== undefined) {
          const index = attemptIndex(agent, event.attemptId, event.type)
          const attempt = attempts[index]
          if (!attempt) throw new Error(`Attempt index ${index} disappeared during agent.failed`)
          attempts = attempts.slice()
          attempts[index] = {
            ...attempt,
            status: 'failed',
            completedAt: event.timestamp,
            error: event.payload.error,
          }
        }
        if (event.payload.retrying === true) {
          const {
            error: _previousError,
            completedAt: _previousCompletedAt,
            ...agentWithoutTerminalState
          } = agent
          return { ...agentWithoutTerminalState, status: 'queued', attempts }
        }
        return {
          ...agent,
          status: 'failed',
          completedAt: event.timestamp,
          error: event.payload.error,
          attempts,
        }
      })
      break

    case 'agent.skipped':
      next = updateAgent(next, event.agentId, event.type, (agent) => ({
        ...agent,
        status: 'skipped',
        completedAt: event.timestamp,
        ...(event.payload.reason === undefined ? {} : { skippedReason: event.payload.reason }),
      }))
      break

    case 'agent.cancelled':
      next = updateAgent(next, event.agentId, event.type, (agent) => {
        let attempts = agent.attempts
        if (event.attemptId !== undefined) {
          const index = attemptIndex(agent, event.attemptId, event.type)
          const attempt = attempts[index]
          if (!attempt) throw new Error(`Attempt index ${index} disappeared during agent.cancelled`)
          attempts = attempts.slice()
          attempts[index] = { ...attempt, status: 'cancelled', completedAt: event.timestamp }
        }
        return {
          ...agent,
          status: 'cancelled',
          completedAt: event.timestamp,
          attempts,
          ...(event.payload.reason === undefined ? {} : { cancelledReason: event.payload.reason }),
        }
      })
      break

    case 'log':
      next = {
        ...next,
        logs: [
          ...next.logs,
          {
            eventId: event.eventId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            level: event.payload.level ?? 'info',
            message: event.payload.message,
            ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          },
        ],
      }
      break

    case 'warning':
      next = {
        ...next,
        warnings: [
          ...next.warnings,
          {
            eventId: event.eventId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            message: event.payload.message,
            ...(event.payload.code === undefined ? {} : { code: event.payload.code }),
            ...(event.payload.details === undefined ? {} : { details: event.payload.details }),
            ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
            ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          },
        ],
      }
      break

    case 'artifact.created':
      next = {
        ...next,
        artifacts: [
          ...next.artifacts,
          {
            ...event.payload,
            eventId: event.eventId,
            sequence: event.sequence,
            timestamp: event.timestamp,
            ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
            ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          },
        ],
      }
      break

    default:
      return assertNever(event)
  }

  return finalizeDerivedState(next)
}

export function projectWorkflowState(runId: string, events: Iterable<WorkflowEvent>): WorkflowSnapshot {
  let state = createWorkflowState(runId)
  for (const event of events) state = reduceWorkflowState(state, event)
  return state
}
