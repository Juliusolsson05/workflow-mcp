# Per-agent output inspection

**Status:** implemented · **Branch:** `feat/agent-output-inspection` · **Date:** 2026-07-21

## The gap

A workflow can now *run* and *recover* large fan-outs well. It cannot be *inspected* afterwards.

What exists:

| Tool | Covers |
| --- | --- |
| `workflow_run_status` | overall run/agent health |
| `workflow_run_events` | the event stream, with bounded previews |
| `workflow_result_read` | the workflow's single final returned artifact |
| `orchestration_read_run_outputs` | orchestration-created agents only — not agents created inside a workflow |

Nothing returns **what an individual agent inside a workflow actually returned**. `agent.completed`
carries a `ContentReference` whose inline `content` is capped at `maxLogCharacters` (10 000 UTF-16
units) with a 4 000-unit `preview` — see `workflowResultMaterialization`, `runWorkflow.ts:2935-2977`.
Past that it sets `truncated: true` and there is no locator to follow.

The observed failure: reviewing a large fan-out required opening `transcripts/journal.jsonl` by hand
and extracting results from the server's private storage. That only works when the MCP client and
the server share a filesystem. A remote client is simply stuck.

## What is actually true today (verified, not assumed)

Three findings shaped this design. Each contradicts an obvious first guess.

1. **Full agent results are already persisted, untruncated.** `JournalResultRecord.result`
   (`workflowJournal.ts:42-65`) holds the complete value; it is written on every completion
   (`runWorkflow.ts:1575`) and for coverage gaps (`runWorkflow.ts:2339-2342`). Truncation is
   confined to the *event stream* copy. **So this is a missing read API over existing data, not
   missing data.** That is what makes retroactive coverage of already-finished runs possible.

2. **`journal.jsonl` is not JSONL.** It is a single-line atomic JSON snapshot document
   (`{format, version, snapshots[]}`, `persistentWorkflowJournal.ts:23-33`) rewritten and fsynced in
   full on *every* admit and result. Serving one agent's result from it means `JSON.parse`-ing
   *every* agent's result into memory, bounded only by `MAX_FILE_BYTES` = 256 MiB. Acceptable as a
   compatibility fallback; wrong as the steady-state backing store. This is why per-agent artifacts
   are a correctness/scale fix, not a tidiness one.

3. **`transcripts/agent-<id>.jsonl` cannot back a transcript tool.** It is appended best-effort,
   unfsynced, *after* the canonical append, and its own comment calls it "a discoverability aid,
   never a second source of truth" (`fileWorkflowStore.ts:818-836`). It has no checksum, so the
   `v1.<sha256>.<offset>` cursor contract cannot fence it, and no reader exists anywhere in the repo.
   The transcript tool therefore pages **`events.jsonl` filtered by `agentId`**, reusing the
   `workflow_run_events` cursor contract.

Identity needs no new modelling. `WorkflowAgentSnapshot` (`workflowState.ts:91-123`) is already the
logical agent — `{id, callIndex, label, phaseId, status, cacheKey, attempts[]}` — and
`agent.failed{retrying:true}` fails the *attempt* while returning the *agent* to `queued`, leaving
abandoned attempts in `attempts[]` (`workflowState.ts:842-849`).

## Why artifacts must be best-effort, and why that forces the design

The tempting design is "persist every agent result as an artifact, serve from it, done." That is
unsafe as stated. `persistResult` hard-rejects lone surrogates with `invalid-result`
(`fileWorkflowStore.ts:558-566`), refuses writes once the manifest is terminal (537-542), and is a
run-scoped singleton keyed on fixed filenames (589-606). Route agent completion through it unchanged
and a durability failure in an **observability** path can fail an otherwise-successful agent — at
agent 147 of 200, with retry semantics on top.

So the artifact write must be best-effort: persist, and on failure emit `agent.completed` without an
`artifactId` and warn. That is exactly the posture `#appendAgentTranscript` already takes.

But the moment the artifact is optional, **a fallback that always works becomes mandatory** — and
that fallback is the journal. Hence: read-substrate first, artifacts as an acceleration layer, with
the read tools preferring the artifact and silently falling back. The fallback is not legacy debt;
it is what makes the fast path allowed to fail.

## Tool surface

Four tools, appended to the existing surface (the "nine stable tools" become thirteen — this string
appears in `WORKFLOW_MCP_INSTRUCTIONS`, `docs/ARCHITECTURE.md:116-128`, and a test assertion in
`test/workflowMcp.test.ts:17-41`).

```
workflow_agent_list(runId)
  → { runId, runStatus, cursor, agents: [{ agentId, callIndex, label, phaseId, phaseTitle,
      status, reused, coverageGap, attempts: [{ attemptId, attemptNumber, status, ... }],
      result: { available, source: 'artifact'|'journal'|'none', artifactId?, sizeBytes?, ... } }] }

workflow_agent_result_read(runId, agentId, cursor?, maxBytes?)
  → WorkflowAgentResultPage  (WorkflowResultPage + agentId + source)

workflow_agent_results_read(runId, phase?, cursor?, maxBytes?)
  → { runId, items: WorkflowAgentResultPage[], nextCursor?, hasMore }

workflow_agent_transcript_read(runId, agentId, after?, limit?)
  → { runId, agentId, events, fromCursor, toCursor, hasMore }
```

Deliberate choices:

- **`artifactId` is optional on the read tool, unlike `workflow_result_read`.** The final-result tool
  can demand it because a completed run always has exactly one. An agent may be served from the
  journal, where there is no artifact to name. Passing it is still honoured as an integrity fence.
- **No run-terminal gate.** `readResult` requires a terminal run (`workflowService.ts:656-668`); per-agent
  reads must work while the run is in flight — that is the point. The list response therefore returns
  `runStatus` and `cursor` so a caller can poll deterministically, exactly as `workflow_run_events` does.
- **Bulk cursor is composite**: `v1.<agentId>.<sha256>.<offset>`, ordered by `callIndex` ascending
  (the codebase's canonical agent order, `workflowState.ts:634`), advancing to the next agent when one
  is exhausted. Per-item pages keep the `WorkflowResultPage` shape so the model learns one shape.
- **Coverage gaps are surfaced, not hidden.** `__workflowAgentFailure` placeholders
  (`workflowEvents.ts:186-197`) are the honest terminal value for an exhausted assignment, and a run
  where 3 of 40 agents hit gaps is precisely when they need reading. They are flagged
  (`coverageGap: true`) rather than filtered.
- **Logical agents, not physical attempts.** One entry per `agent_N`, with abandoned attempts as
  history inside it.

## Stages

**Stage 1 — read substrate (works retroactively on every existing run).**

1. DTOs in `workflowProtocol.ts` (pure — must stay Node-free so `tsconfig.browser-state.json` passes).
2. Journal reader: parse the persisted journal document, index `JournalResultRecord` by `agentId`.
   Join to snapshot agents on `cacheKey`, **not** `agentId` — for `exact-source-sparse` recovery the
   successor journal starts as a copy of the predecessor's records and carries the *predecessor's*
   ids until re-admission (`workflowJournal.ts:484-494, 703-719`).
3. `FileWorkflowStore`: `readAgentResult` (artifact first, journal fallback), `listAgentResults`.
4. `WorkflowService`: `listAgents`, `readAgentResult`, `readAgentResults`, `readAgentTranscript` —
   each going through `#assertScope` via `snapshot()`/`status()`, mirroring `readResult`'s guard order.
5. Four tools in `workflowMcp.ts`; instructions + `docs/ARCHITECTURE.md` updated.

**Stage 2 — artifacts as the fast path (new runs).**

6. Slot-keyed persistence in `FileWorkflowStore`: `artifacts/agent-<agentId>.data` + `.json`,
   artifactId `agent_result_sha256_<hex>`. `agentId` is validated against `/^agent_[0-9]+$/` before
   any path join rather than trusted to the sanitizer — the repo's stated rule is never to
   interpolate a caller value into a path (`fileWorkflowStore.ts:650-651`).
7. `runWorkflow.ts`: on agent success, materialize → persist (best-effort) → set `artifactId` on the
   existing optional `ContentReference.artifactId` slot (`workflowEvents.ts:31` — additive, no
   breaking change to the closed `AgentOutcome` type) → emit `artifact.created` carrying `agentId`
   (already projected into `WorkflowSnapshot.artifacts`, `workflowState.ts:997-1013`) → then
   `agent.completed`. Ordering preserves the existing bytes→locator→terminal invariant.
8. Failure of the artifact write is logged and dropped; the agent completes normally and the journal
   fallback serves the bytes.

## Verification

- `npm run check` = contract + typecheck (incl. `check:browser-state`) + core/system/corpus + package.
- Extend `test/workflowMcp.test.ts` and `test/workflowService.test.ts` **in place** — no new test
  files (house rule). The regression fixture is a `FakeAgentProvider` script returning
  `'x'.repeat(50_000)`: the journal keeps all 50 000, `agent.completed.preview` keeps 4 000 with
  `truncated: true`, and the new tools must return the full 50 000 across pages.
- Round-trip assertions: paging concatenation equals the original; a stale cursor (wrong checksum)
  is rejected with `invalid-cursor`; an unknown agent yields `agent-not-found`.

## Risks accepted

- Journal-backed reads are O(all results in the run) per page. Bounded by the existing 256 MiB file
  cap, confined to runs created before Stage 2 ships, and documented in the tool description.
- `snapshot()` replay is O(`events.jsonl`) on cache miss; `workflow_agent_list` pays it once, and the
  bulk reader resolves the agent list once rather than per page.
- UTF-16 vs UTF-8: previews count UTF-16 units, artifacts count UTF-8 bytes. Sizes reported by the
  new tools are byte counts; that is stated in the DTO comments rather than silently reconciled.
