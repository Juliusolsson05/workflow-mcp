import {
  createWorkflowState,
  reduceWorkflowState,
} from '../src/state.js'
import type {
  StoredWorkflowEvent,
  WorkflowRunManifest,
  WorkflowState,
} from '../src/state.js'

// This file is a compile-only fixture. It deliberately uses the renderer's ES2020 + DOM library
// surface and no Node types, proving that the public state subpath cannot accidentally acquire an
// fs/process/Codex/MCP dependency through an innocent-looking type export.
const state: WorkflowState = createWorkflowState('run_browser')
declare const stored: StoredWorkflowEvent
declare const manifest: WorkflowRunManifest
void manifest
void reduceWorkflowState(state, stored.event)
