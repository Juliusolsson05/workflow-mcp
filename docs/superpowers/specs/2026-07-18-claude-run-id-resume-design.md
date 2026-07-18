# Claude Run-ID Resume Design

## Goal

Let Workflow MCP continue a real Claude Workflow run when a caller supplies its native `wf_*` run ID, without requiring the caller to discover Claude's session-specific metadata path.

## Contract

- `workflow_resume({ runId: "wf_..." })` imports the matching Claude run from the current project's Claude state.
- `workflow_run({ resumeFromRunId: "wf_..." })` provides the same compatibility behavior.
- Existing Agent Code `run_*` continuation behavior remains unchanged.
- Explicit `claudeRunPath` import remains available.
- Discovery is confined to `~/.claude/projects/<project-key>/<session>/workflows/<run-id>.json` for the MCP scope's canonical working directory.
- A missing run returns `run-not-found`. Duplicate matching metadata files fail closed as `invalid-request` because a run ID must resolve to one historical execution.
- A metadata filename whose embedded `runId` differs from the requested ID fails closed before journal reuse.

## Architecture

`claudeResume.ts` owns bounded metadata discovery because it already owns Claude metadata parsing and byte limits. `WorkflowService` selects continuation by identifier namespace: `run_*` remains native-store recovery, while `wf_*` resolves scoped Claude metadata and enters the existing validated Claude importer. A configurable Claude projects root provides a deterministic test seam while production defaults to `~/.claude/projects`.

## Security

Discovery enumerates only direct Claude session directories and never accepts a caller-provided path segment. The existing realpath project-boundary check, source-hash comparison, workflow-name comparison, bounded metadata read, and bounded journal parser remain mandatory before execution.

## Verification

Regression coverage exercises both MCP entry points, missing IDs, duplicate IDs, metadata ID mismatch, and project scoping. The complete package build, browser-state typecheck, and Vitest suite must pass before opening the pull request.
