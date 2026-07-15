/**
 * Browser-safe projection entry.
 *
 * WHY this is a separate package subpath: the root entry intentionally exposes filesystem,
 * process, MCP, and Codex SDK functionality. A renderer only needs immutable event reduction; a
 * hard subpath keeps accidental Node imports out of browser bundles by construction.
 */
export { createWorkflowState, projectWorkflowState, reduceWorkflowState } from './workflowState.js'
export type {
  WorkflowActivitySnapshot,
  WorkflowActivityStatus,
  WorkflowAgentCounts,
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowArtifactSnapshot,
  WorkflowAttemptSnapshot,
  WorkflowAttemptStatus,
  WorkflowLogSnapshot,
  WorkflowPhaseSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshot,
  WorkflowSnapshot as WorkflowState,
  WorkflowWarningSnapshot,
} from './workflowState.js'
export type {
  AgentAdmitted,
  AgentAttemptStarted,
  AgentSessionStartedEvent,
  AgentOutcome,
  ContentReference,
  NormalizedAgentOptions,
  WorkflowActivityDetails,
  WorkflowDefinitionReference,
  WorkflowErrorReference,
  WorkflowEvent,
  WorkflowEventType,
} from './workflowEvents.js'
export type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
} from './workflowProtocol.js'
