# Workflow reliability and continuous-utilization implementation plan

Status: in progress; fail-closed audit hardening implemented on 2026-07-16, native creation-time containment still outstanding
Date: 2026-07-15
Scope: `workflow-mcp` runtime, service, persistence, provider lifecycle, worktree lifecycle, MCP
health surface, and the narrow Agent Code host callbacks required to make those guarantees real.

## Implementation status

This document intentionally remains the full end-state plan. The runtime now supervises attempts,
but the 2026-07-16 audit proved that a POSIX process group is not a complete ownership boundary:
real Codex shell tools can call `setsid()` and leave it. Both POSIX and Windows therefore advertise
`unconfirmed-descendants`; automatic replay remains disabled for the production Codex provider
until cgroup/supervisor or Job Object containment exists. This correction is deliberately explicit
instead of turning useful kill escalation into a false exactly-once guarantee.

Implemented in the first reliability slice:

- a service-wide, FIFO, work-conserving scheduler with a default ceiling of nine and independent
  narrower per-run ceilings;
- startup, idle-progress, active-operation, total-attempt, worker-startup, worker-heartbeat, and
  worker-idle watchdogs;
- same-session, same-workspace logical-agent retries with bounded exponential backoff, per-agent and
  per-run retry budgets, provider circuit breaking, and half-open probes;
- attempt-addressed cancellation escalation, provider termination hooks, and permit quarantine when
  termination cannot be proven;
- stable workspace identities and durable workspace/deadline/retry/stall events;
- serialized durable appends, event/manifest crash-tail repair, a process-owner fence, and concurrent
  idempotency-key coalescing;
- linked automatic restart recovery for safe read-only runs, with exact-source sparse sibling reuse
  for both automatic and manual recovery while edited source/arguments retain Claude-compatible
  longest-prefix behavior;
- scheduler, circuit, progress, retry, stall, lineage, and successor-run health through MCP status;
- deterministic tests for utilization, limits, stalls, retries, cancellation, circuit breaking,
  workspace reuse, owner fencing, automatic recovery, and the "call five of nine" crash case.

Still architectural follow-up rather than silently implied by the implementation:

- a separately installed persistent supervisor/daemon, so execution continues while Electron or the
  parent CLI process is absent;
- creation-time containment on every supported platform: a cgroup or equivalent process-owning
  supervisor on POSIX and a kill-on-close Job Object on Windows. Current process-group/taskkill
  escalation is best effort and never reported as authoritative descendant ownership;
- a durable capability/idempotency ledger for externally mutating tools. Mutable sandbox recovery is
  therefore opt-in, and unknown external side effects must not be described as exactly-once;
- append-log/SQLite compaction and bounded ingestion queues for histories materially larger than the
  current atomic private journal limits.

The “current behavior” sections below describe the baseline that motivated the plan. Where they
conflict with the status list above, the status list describes the implemented runtime and the
baseline text remains as design history and acceptance rationale.

Implemented in the process-ownership/self-healing slice:

- one data-only Codex provider-host process and POSIX process group per physical attempt, with
  attempt-addressed cooperative cancellation, escalation, descendant reaping, and settlement only
  after the process boundary is gone;
- agent-local timeout and infrastructure recovery, so a failed attempt does not cancel healthy
  siblings and replacement attempts keep the logical-agent identity, Codex thread, and workspace;
- durable termination, retry, recovery-started/completed, and `recovery_required` events plus
  terminal-state reconciliation that cannot simultaneously report a failed run and running agents;
- an explicit continuation turn containing interruption diagnostics instead of resending the
  original task to a resumed Codex thread;
- request-aware replay classification and optional isolated `CODEX_HOME` enforcement. A production
  host cannot claim inherited MCP servers are disabled without supplying that isolation boundary;
- a visible soft-stall phase before the hard deadline and a real nine-agent regression where one
  silent attempt is replaced while eight siblings continue;
- exact-source sparse manual recovery across a journal gap, while edited source/arguments retain
  longest-prefix compatibility.

Implemented in the 2026-07-16 audit-hardening slice:

- fail-closed Codex ownership and replay evidence: a private CODEX_HOME alone no longer attests
  that system/managed MCP configuration is absent, and restart recovery requires a matching
  provider fingerprint plus each unresolved attempt's concrete persisted replay assessment;
- storage-independent cancellation escalation, bounded event-sink delivery, best-effort worker
  IPC, and an admission fence after ambiguous external effects;
- journal format v2 containing every root/nested workflow identity, with inherited lineage seeded
  before a successor manifest is published and version-1 migration on open;
- canonical top-level/nested source confinement, symlink-root rejection, no-follow authoring, and
  an app-owned source-hash approval callback;
- one live successor per recovery lineage, per-run corruption quarantine, projected event-log size
  rejection, fair rotation across three or more runs, and schema-contract rejection instead of a
  fabricated successful null;
- an embedder-owned pre-attempt authentication hook and exact executable evidence in attempt
  diagnostics. Agent Code uses the hook to single-flight OAuth rotation and hand children an
  access-only snapshot; standalone hosts must supply equivalent policy if they copy credentials;
- explicit remaining limitation: no automatic production Codex replay is safe until native
  process containment and effective-config inspection land.

## Executive summary

The current runtime is durable enough to explain what happened after a normal failure, but it is
not yet a self-healing long-running workflow supervisor. One provider execution can stop producing
events without rejecting, keep a scheduler permit forever, and hold an entire `parallel()` barrier
open until the one-hour run-wide timeout cancels every healthy sibling. A process restart then
marks the run interrupted and requires a person to start a separate resume run. Provider-session
metadata may survive, but the logical agent's worktree does not have a durable identity and is not
automatically reused.

That behavior is incompatible with the main product requirement:

> A workflow with many expensive agents and a concurrency target of nine should be safe to leave
> unattended. It should keep all available slots busy while runnable work exists, detect stalled
> attempts in minutes rather than tens of minutes, retry only the affected logical agent, preserve
> its worktree and provider session, surface clean errors, and recover automatically after a host
> restart whenever doing so cannot duplicate unsafe side effects.

This plan adds four related control-plane capabilities:

1. **A work-conserving hierarchical scheduler.** Nine is the single-run operating target. If at
   least nine runnable calls exist, nine provider attempts should be active. Retry backoff,
   worktree cleanup, persistence, and a slow tail from an earlier author-created batch must not
   consume provider permits unnecessarily.
2. **A per-logical-agent attempt supervisor.** Each live attempt has startup, progress, active
   operation, absolute-runtime, cancellation, and hard-kill deadlines. Retryable failure and
   silence create another attempt under the same logical agent instead of immediately returning
   `null` or cancelling the whole run.
3. **Durable execution resources.** Provider sessions, worktree leases, attempt state, ambiguous
   side-effect state, and retry decisions are persisted before they become recovery-critical.
4. **Automatic recovery with honest semantics.** Completed work is reused, incomplete safe work
   resumes automatically, and potentially duplicated external effects enter an explicit
   `recovery_required` state rather than being silently run twice.

The work should be delivered incrementally. The first useful release does not require the final
daemon architecture: a scheduler invariant, attempt watchdog, retry loop, and durable worktree
lease will solve the most common "one of nine agents never returns" failure inside a live host.
Later milestones move ownership outside Electron and remove the remaining full-process failure
domain.

## Current behavior and concrete gaps

### A silent provider attempt has no local deadline

`CodexAgentProvider.execute()` awaits the SDK event generator until it closes. The scheduler passes
the run-wide abort signal directly to that call. There is no per-attempt `AbortController`, no
startup deadline, no last-progress clock, no final-response deadline, and no attempt maximum.

The resulting failure chain is:

```text
Codex process or stream stops making progress
  -> provider execute Promise remains pending
  -> logical agent remains running
  -> semaphore permit remains owned
  -> workflow JavaScript continues waiting for that agent promise
  -> run-wide one-hour timer eventually cancels every attempt
```

The heap can remain small and every process can appear alive throughout this failure. Process
existence is not evidence of agent progress.

### Retry-shaped types exist without a retrying executor

The event model already supports multiple attempts for one logical agent, and `agent.failed`
already carries `retrying: true`. `AgentProviderFailure` already exposes `retryable`. The executor,
however, creates only `agent_N_attempt_1`, ignores `retryable`, journals provider failure as `null`,
and returns that `null` to workflow JavaScript immediately.

This is useful compatibility groundwork, but it creates a dangerous false sense that retries are
implemented. The first milestone must connect these existing concepts into an actual state machine.

### Worktree lifetime is attempt-local rather than logical-agent-local

The working-directory preparer returns a path and cleanup callback to one stack frame. The path is
not durably recorded before provider start. Agent Code currently creates the directory under the OS
temporary directory and names it with the current run and agent IDs.

Consequences:

- a retry would naturally create a second fresh worktree unless the runtime is restructured;
- a process crash loses the association between the journal call and the surviving directory;
- a new resume run can resume a Codex thread into a different filesystem state;
- a clean but recovery-relevant worktree may be removed by the OS before resume;
- cleanup can block while still holding one of the nine provider permits.

For long-running mutating workflows, the worktree is part of the agent's durable execution state,
not an incidental temporary directory.

### Restart recovery is terminal marking, not automatic continuation

`WorkflowService.initialize()` currently appends `run.interrupted` to every nonterminal manifest.
That is honest, but it stops there. Recovery requires a manual MCP/UI resume that creates a new run.

The service also has no persisted owner lease or fencing generation. Two app instances, a stale
owner, or a daemon handover cannot prove which process owns a run. A future automatic recovery loop
must not start until this ownership question is solved, or two supervisors could execute the same
logical call concurrently.

### Heavy event persistence can become the source of apparent stalls

Every durable event currently performs an event append and `fsync`, a manifest replacement, and an
agent transcript mirror append. The private provider journal synchronously serializes and replaces
the complete snapshot after every admission, provider session, and result.

These choices made the first durability rules easy to reason about, but high-frequency activity and
large completed results turn them into main-process latency and approximately quadratic journal
serialization. A watchdog must be able to distinguish a stuck provider from a blocked persistence
sink; otherwise storage pressure will cause healthy attempts to be killed and retried.

## Required behavioral invariants

These invariants are the product contract. Tests should name them directly.

### Logical-agent identity

1. One call to workflow `agent()` creates exactly one logical agent.
2. Retry, provider-session resume, and crash recovery add attempts beneath that logical agent; they
   never inflate logical-agent totals.
3. A logical agent has at most one live provider attempt at a time.
4. A terminal successful result is published and journaled exactly once.
5. A retryable failed attempt is never exposed to workflow JavaScript as a final `null` while more
   attempts remain.

### Scheduler utilization

1. For a running, unpaused workflow, when the runnable queue contains work:

   ```text
   active provider attempts = min(provider limit, active + runnable work)
   ```

2. Worktree preparation, agent-type resolution, retry backoff, result persistence, transcript
   mirroring, and worktree cleanup do not own a provider permit.
3. A timed-out attempt does not release its permit until its provider process is confirmed exited
   or isolated strongly enough that it can no longer consume credentials or mutate state.
4. Retry backoff requeues the logical agent and releases the provider permit so another agent can
   run.
5. Queue ordering is deterministic. Retries cannot starve never-attempted calls.
6. With one workflow and at least nine runnable calls, the runtime converges back to nine active
   attempts after every completion, failure, or retry transition without waiting for an unrelated
   batch to drain.

### Durability and recovery

1. Provider-session identity is durable before any later activity depends on it.
2. Worktree identity is durable before provider start.
3. A completed result is durable before the worker promise resolves.
4. A recovery owner holds a lease and fencing generation; stale owners cannot append or execute.
5. Automatic recovery never treats an in-flight external side effect as definitely absent or
   definitely complete without evidence.
6. One corrupt historical run cannot prevent healthy runs or the service itself from starting.

### Cancellation and shutdown

1. Cancellation is staged: request, cooperative abort, bounded grace, hard kill, confirmed reap.
2. Cancellation of one attempt does not cancel its siblings unless run cancellation was requested.
3. Run shutdown is bounded even when a provider, event sink, listener, worktree command, or worker
   ignores cancellation.
4. Exactly one terminal run event wins completion/failure/cancellation races.

## Work-conserving scheduling and the "two agents left" problem

### What the scheduler can and cannot fill

The current semaphore can fill an empty slot immediately **only when another `agent.request` is
already admitted or queued**. `parallel()` invokes every supplied thunk without awaiting earlier
thunks, so this is naturally work-conserving when a workflow gives it all independent work:

```js
return await parallel(allIndependentTasks.map(task => () => agent(promptFor(task))))
```

An author-created barrier hides future work from the scheduler:

```js
for (const batch of chunks(allIndependentTasks, 9)) {
  results.push(...await parallel(batch.map(task => () => agent(promptFor(task)))))
}
```

When seven calls from the first batch finish and two remain, the next batch does not exist from the
runtime's perspective. Starting it speculatively would require evaluating JavaScript past an
unresolved `await`, which would change language semantics. The runtime must not silently do that.

The complete solution therefore has two halves.

### Scheduler-side changes

Extract a scheduler from `runWorkflow.ts` with explicit state rather than a semaphore-only API:

```ts
type SchedulerSnapshot = {
  providerLimit: number
  activeAttempts: number
  runnableAgents: number
  preparingAgents: number
  retryWaitingAgents: number
  blockedAgents: number
}

interface WorkflowScheduler {
  enqueue(agent: LogicalAgentExecution): void
  cancel(agentId: string): void
  setPaused(paused: boolean): void
  snapshot(): SchedulerSnapshot
}
```

The scheduler owns a pump loop. Every state transition that can free capacity schedules a pump in
the next microtask. The pump starts attempts until either the provider ceiling is reached or no
runnable work remains. Starting an attempt must reserve capacity synchronously before awaiting so
two completions cannot over-admit concurrently.

Use separate limits:

```text
provider concurrency       9 per single active run by default
service provider ceiling   9 by default across all runs; configurable by host
worktree preparation       2 by default
result/journal writers      bounded independently
cleanup                     background reconciler, no provider permit
```

When multiple runs are active, use hierarchical admission: per-run FIFO queues feeding a
service-wide round-robin provider queue. With one run it receives all nine slots. With several runs,
one noisy workflow cannot launch nine processes per run and exhaust the machine.

Fairness ordering within a run should be:

1. never-attempted admitted agents;
2. stalled agents whose immediate resume can complete an open barrier;
3. other eligible retries ordered by `nextAttemptAt`;
4. no unbounded priority boost for repeated failure.

The exact retry priority should be verified under a 100-agent randomized-duration test. The
invariant is bounded starvation, not a particular heap implementation.

### Workflow-side changes and diagnostics

Document that provider concurrency belongs to the scheduler. Workflow authors should not chunk
independent work into groups of nine merely to honor the limit. Pass the complete independent set
to `parallel()` or `pipeline()` and allow admission control to enforce nine.

Add a structured utilization diagnostic when all of these remain true for a grace period:

```text
active attempts < provider limit
runnable queue = 0
workflow worker has unresolved capability promises
at least one running logical agent exists
```

The diagnostic should say that the runtime is underfilled because no additional work has been
admitted, not claim a scheduler failure. It should include active, queued, preparing, retry-waiting,
and unresolved worker request counts.

Add an optional portable extension only if real workflows continue to need manual chunking after
documentation fixes:

```js
await pool(items, async (item, index) => agent(prompt(item, index)))
```

`pool()` should submit all items to the existing scheduler and preserve result order. It must not
carry its own concurrency number because a second concurrency authority will drift from the host
policy. Since `parallel(items.map(...))` already has this behavior, `pool()` is a readability and
authoring aid, not the first fix.

### Utilization acceptance tests

1. Admit 100 fake calls with varied durations and concurrency nine. Whenever at least one queued
   call exists, observe nine active calls except during a bounded event-loop transition.
2. Make seven calls finish quickly and two slowly while 91 remain queued. Prove the next seven start
   immediately rather than waiting for the two slow calls.
3. Put a retryable failure into one active slot. Prove backoff releases that slot and another queued
   call starts.
4. Make worktree cleanup block. Prove provider utilization remains nine.
5. Run two workflows and prove the service-wide cap is respected while both make progress.
6. Create a workflow with an explicit nine-item barrier and prove the diagnostic reports
   `no-runnable-work` rather than falsely reporting nine available queued calls.

## Per-attempt liveness supervisor

### State model

Add explicit logical-agent and attempt states. They need not all become top-level run statuses, but
they must be observable and testable.

```text
logical agent:
  admitted
  preparing
  queued
  running
  retry_wait
  recovery_required
  completed
  failed
  skipped
  cancelled

attempt:
  starting
  running
  suspected_stall
  cancelling
  completed
  failed
  killed
  abandoned
```

Track three clocks separately:

- `lastHeartbeatAt`: the provider execution host is responsive;
- `lastProviderEventAt`: the SDK/CLI emitted anything;
- `lastProgressAt`: meaningful work advanced, such as a new activity, changed activity output,
  completed tool, final message, or usage update.

A heartbeat must not reset progress indefinitely. Otherwise a healthy wrapper around a dead Codex
child would defeat stall detection forever.

### Initial timeout policy

Start with conservative host-owned defaults and tune from telemetry:

```text
provider startup timeout              90 seconds
no-progress suspect threshold          4 minutes
no-progress abort threshold            6 minutes
active operation maximum              20 minutes
absolute attempt maximum              45 minutes
cooperative cancellation grace         5 seconds
hard-kill confirmation grace           5 seconds
maximum attempts                       3
retry backoff                     2s, 10s, 30s plus jitter
provider circuit-breaker window        2 minutes
provider circuit-breaker threshold     5 infrastructure failures
```

The key requirement is not one universal number. A call that has completed its last tool and is
only waiting for a final response should be considered stalled much sooner than a known running
command. Add an attempt phase:

```text
starting
thinking_or_selecting_tool
operation_active
waiting_for_final_response
```

Each phase selects an appropriate deadline. `stallMs`, which Claude accepts as an agent option,
can be implemented as a per-call no-progress override, but the host must clamp it to safe minimum
and maximum values. It remains outside the Claude journal-key allowlist.

### Supervisor algorithm

Each attempt receives a child `AbortController` linked to the run signal. The supervisor owns a
single timer for the nearest deadline, rather than one polling interval per attempt.

On progress:

1. validate event identity and ordering;
2. update in-memory liveness clocks;
3. publish/coalesce the user-visible event;
4. reschedule the nearest deadline.

On a suspected stall:

1. record a bounded `agent.stalled`/warning event with the last known activity and clock ages;
2. request a provider health sample;
3. allow a short diagnostic grace period;
4. abort that attempt only;
5. wait for process exit;
6. hard-kill the process tree if necessary;
7. classify whether retry is safe;
8. emit `agent.failed { retrying: true }` and `agent.retry_scheduled` when eligible;
9. requeue without returning to workflow JavaScript;
10. otherwise enter `recovery_required` or terminal failure.

`Promise.race(providerPromise, timeout)` alone is forbidden. It makes the JavaScript caller move on
while provider work continues invisibly. Capacity may be released only after process ownership is
resolved.

### Provider execution handle

Replace or augment `AgentProvider.execute()` with a lifecycle-bearing handle:

```ts
type AgentExecutionHealth = {
  state: 'starting' | 'running' | 'exited'
  pid?: number
  childPids?: number[]
  lastHeartbeatAt?: string
}

type AgentExecutionHandle = {
  result: Promise<AgentProviderResult>
  abort(reason: string): void
  terminate(reason: string): Promise<void>
  health(): Promise<AgentExecutionHealth>
}

type AgentProvider = {
  start(request: AgentRequest, context: AgentProviderExecutionContext): AgentExecutionHandle
}
```

The scheduler should never receive raw `ChildProcess` or Electron types. The provider adapter owns
how its process is started, but the runtime owns deadlines and requires the lifecycle contract.

During migration, an adapter around the old `execute()` interface may support cooperative abort,
but it must advertise `hardKillSupported: false`. Production Codex execution should not be called
fully hardened until it provides confirmed termination.

## Retry classification and safety

### Failure taxonomy

Replace "all provider failures become null" with classification followed by retry exhaustion.

```text
retryable infrastructure:
  provider stream disconnected
  CLI exited abnormally
  timeout/stall
  transient network failure
  HTTP 408/429/5xx when identified
  temporary process/resource exhaustion

non-retryable request/configuration:
  invalid schema
  unsupported model or effort
  missing CLI/authentication
  forbidden working directory
  invalid agent type

runtime invariant failure:
  duplicate provider event IDs
  malformed adapter result
  journal ownership violation
  impossible attempt transition
```

`AgentProviderFailure.retryable` becomes authoritative when supplied. Codex mapping should set it
for known codes. Unknown errors default to non-retryable until evidence proves otherwise; an
unbounded optimistic retry policy hides deterministic bugs.

After retry exhaustion, preserve Claude-compatible workflow behavior where appropriate: a
terminal provider/API failure can become a failed logical agent whose JavaScript result is `null`.
The event history must still show every attempt and the exhaustion reason.

### Side-effect safety classes

Exactly-once tool execution cannot be promised across a process crash. A child may die after an
external system commits but before the provider records the result. Use explicit safety classes:

| Execution class | Default automatic action |
| --- | --- |
| Read-only filesystem, no write-capable MCP, no network | Retry/resume automatically |
| Writes isolated to the agent's durable worktree | Resume automatically in the same worktree |
| External call with an idempotency key | Retry automatically with the same key |
| External/destructive call without idempotency evidence | Enter `recovery_required` |
| Unknown tool capability after an interrupted call | Enter `recovery_required` |

Filesystem sandbox `read-only` is not sufficient evidence if the provider can call an MCP server
whose tools mutate remote state. The host must provide tool capability metadata or conservatively
mark those executions unknown.

Record an attempt's side-effect watermark:

```ts
type AttemptSafetyState = {
  highestObservedRisk: 'read_only' | 'worktree_write' | 'idempotent_external' | 'unknown_external'
  inFlightActivityId?: string
  executionUncertain: boolean
}
```

The resumed prompt may include a host-generated recovery preamble telling the agent to inspect the
existing worktree and avoid repeating uncertain effects. That preamble must be recorded in attempt
diagnostics without changing the logical journal key for the original workflow call.

### Retry budgets and circuit breaking

Per-agent `maxAttempts` is not enough. If the provider is globally unavailable, nine attempts can
all fail and retry simultaneously.

Add:

- maximum retry attempts per logical agent;
- maximum retry attempts per run;
- retry-token accounting where provider usage is available;
- exponential backoff with jitter;
- provider-wide circuit breaker;
- half-open probe attempts;
- a warning and health status while the circuit is open.

Opening the circuit stops new provider starts but does not cancel healthy running attempts. Queued
work remains queued and visible. The run-wide timeout should pause or receive an explicit extension
while host infrastructure is in a bounded circuit-open recovery period; otherwise a transient
provider outage silently consumes the entire workflow deadline.

## Durable worktree leases

### Resource identity

Move worktree ownership above individual attempts. Key it by stable workflow lineage and journal
call key, not only by run ID, because automatic recovery creates a new run generation.

```ts
type WorktreeLease = {
  leaseId: string
  workflowLineageId: string
  journalCallKey: string
  repositoryRoot: string
  baseRevision: string
  path: string
  createdAt: string
  updatedAt: string
  ownerGeneration: number
  status: 'preparing' | 'ready' | 'in_use' | 'preserved' | 'cleanup_pending' | 'removed'
  dirty?: boolean
}
```

Persist `preparing` before invoking Git, then `ready` after verifying the worktree. This makes every
crash window reconcilable:

- `preparing` with no directory: retry creation;
- directory exists but ready event missing: validate and adopt;
- `ready` with missing directory: fail cleanly or recreate only when no prior writes are possible;
- dirty directory after interrupted attempt: preserve and resume;
- clean terminal directory: schedule cleanup.

Store persistent workflow worktrees under an Agent Code/workflow state root, not `/tmp`. The
preparer should accept a requested durable identity/path from Workflow MCP rather than inventing
one independently.

### Preparation and cleanup scheduling

Preparation uses its own small semaphore. Provider capacity is acquired only after the worktree is
ready and agent-type instructions are resolved. Limit speculative preparation to a bounded window
around runnable calls so a 1,000-agent workflow does not create 1,000 worktrees immediately.

Cleanup moves to a reconciler after the logical agent is terminal. It never holds provider
capacity. Every Git command receives an abort signal and timeout. Dirty worktrees are preserved by
default and reported as artifacts/resources with a stable path.

On retry, reuse the same lease. On safe automatic restart, adopt it under the new owner generation.
On edited-workflow resume, reuse only when the journal call key and repository/base identity still
match; otherwise preserve the old directory and create a new one.

## Journaling and precise recovery

### Separate compatibility history from recovery state

Claude-compatible longest-prefix replay remains required for edited workflow source. It is not the
best recovery algorithm for an exact-source host crash: if call five of nine is unfinished but calls
six through nine completed, prefix invalidation reruns those four completed siblings.

Maintain two related representations:

1. **Compatibility journal:** preserves Claude v2 records and edited-source longest-prefix rules.
2. **Private recovery ledger:** records exact logical-call state, attempt history, successful `null`
   versus failure `null`, provider session, worktree lease, and safety watermark.

Automatic recovery may use sparse completed-call reuse only when all of these match:

```text
workflow identity
exact source hash
exact arguments hash
journal call key
host execution-policy compatibility
```

Edited source continues to use longest-prefix semantics. This avoids weakening Claude compatibility
while preventing unnecessary reruns after a host crash.

### Append-only mutation log

Replace synchronous whole-snapshot journal rewrites with bounded append-only records:

```text
call.admitted
workspace.preparing
workspace.ready
attempt.started
provider.session
attempt.progress_checkpoint
attempt.failed
attempt.retry_scheduled
call.completed
call.recovery_required
workspace.cleanup_disposition
```

Session, workspace-ready, completion, and recovery-required records are critical and must be synced
before the corresponding action becomes externally visible. High-frequency progress checkpoints
can be coalesced.

Periodically compact into a snapshot after an atomic checkpoint. Recovery reads the latest valid
checkpoint plus the append tail. Include checksums and a format version. Never rewrite a file whose
size is proportional to every earlier result on each new result.

## Process ownership and hard termination

### Immediate implementation

Give each attempt its own abort controller. On timeout, abort the Codex SDK call, wait a bounded
grace, and confirm that the adapter reports exit. Do not release scheduler capacity based only on
the abort call returning.

### Production implementation

Run provider execution in a dedicated credentialed provider host process, separate from both the
untrusted workflow VM and Electron main. The provider host streams normalized events and heartbeat
records over a small data-only protocol.

The supervisor must terminate the complete descendant process tree:

- POSIX: tracked descendants and/or a dedicated process group where the launch stack permits it;
- Windows: a Job Object or equivalent tree-kill mechanism;
- Electron: utility-process termination alone is insufficient if its Codex child can survive.

The pinned Codex SDK currently hides the child-process handle. Choose one explicitly reviewed path:

1. upstream or locally patch the SDK to expose lifecycle control;
2. wrap execution in a provider host that tracks and reaps descendants robustly;
3. use a supported future SDK process-control hook.

Do not silently replace the supported SDK with hand-built CLI parsing merely to gain a PID. If that
tradeoff becomes necessary, document and test every protocol difference first.

### Workflow evaluator watchdog

The credential-free workflow worker also needs:

- ready/startup deadline;
- periodic heartbeat;
- distinction between pending capability calls and a worker awaiting nothing;
- bounded async-idle timeout;
- confirmed termination.

A live worker awaiting a supervised agent is healthy. A worker with no pending request, no timer,
and no progress while its top-level Promise remains unresolved is likely a workflow bug and should
fail with a specific `workflow-worker-idle` error rather than consuming the whole run timeout.

## Service ownership and automatic restart recovery

### Single-owner lease and fencing

Persist service ownership:

```ts
type RunOwnerLease = {
  ownerId: string
  hostPid: number
  generation: number
  acquiredAt: string
  renewedAt: string
  expiresAt: string
}
```

Every append and recovery mutation carries the generation. A stale owner that wakes after losing
its lease must fail closed. Use an atomic lock/transaction, not a read-then-write convention.

On startup:

1. inspect nonterminal manifests;
2. verify the prior owner lease expired and process is absent;
3. fence the old generation;
4. append `run.interrupted` to the old immutable generation;
5. classify each incomplete logical call by recovery safety;
6. automatically create and start a linked recovery generation when safe;
7. leave unsafe calls `recovery_required` with clear operator guidance;
8. publish lineage so UI/MCP follows the new run automatically.

### Long-term daemon

The final architecture should move `WorkflowService` into a persistent local supervisor process:

```text
workflow definition / MCP client / Agent Code UI
                    |
                    v
       local authenticated workflow supervisor
          | scheduler | store | recovery | leases |
                    |
          provider attempt host processes
                    |
               Codex CLI trees
```

Renderer reload and Electron restart then become client disconnects rather than workflow crashes.
The supervisor can expose the existing authenticated loopback MCP/IPC-style service. Explicit user
quit policy should distinguish "close UI but keep workflows running" from "cancel all workflows."

The daemon is not required for the first watchdog/retry release, but the product must not claim that
workflows survive full app-process crashes until this ownership moves out of Electron main.

## Persistence and event throughput

### Split control records from telemetry

Control records determine recovery and must be durable immediately:

```text
run/attempt terminal transitions
provider session acquisition
workspace lease transitions
retry scheduling
recovery-required decisions
result commitment
owner lease/fencing
```

Telemetry can be bounded/coalesced:

```text
reasoning text updates
command aggregated-output updates
tool-call argument/result growth
heartbeat samples
repeated health snapshots
```

Coalesce activity updates by `(runId, agentId, attemptId, activityId)` over a short window. Preserve
start and terminal activity records. A UI does not need 100 durable copies of the same command's
ever-growing output.

### Writer architecture

Use one ordered writer per run, backed by a worker thread or dedicated service process so large
serialization does not monopolize Electron main. Group commits over a small interval while allowing
critical records to force immediate flush.

Add:

- event log rotation before the 512 MiB hard cap;
- periodic projected-state checkpoints;
- persistent cursor indexes;
- directory `fsync` where rename durability requires it;
- bounded queues with explicit backpressure;
- writer latency and queue depth health metrics;
- per-run corruption quarantine;
- atomic idempotency uniqueness for `(cwd, idempotencyKey)`;
- a store implementation with transactions, likely SQLite WAL, once the file format migration is
  designed.

The runtime must never classify a provider as stalled solely because `context.emit()` is blocked on
the durable writer. Provider ingestion and durable publication need a bounded queue so the
supervisor can report `storage_degraded` separately and pause admission before memory grows without
bound.

## Event, state, MCP, and UI surface

### Additive execution events

Prefer explicit events over encoding control state in prose warnings:

```text
agent.workspace.preparing
agent.workspace.ready
agent.stalled
agent.retry_scheduled
agent.recovery_required
agent.recovered
run.owner_acquired
run.recovery_started
run.storage_degraded
```

Existing `agent.failed { retrying: true }` remains the terminal record for one failed attempt.
`agent.retry_scheduled` describes when and why the next attempt is eligible. Update the pure state
reducer and browser-safe types in the same change. Old event logs must continue to replay.

### Health projection

Expose a bounded health summary without requiring consumers to reconstruct timers:

```ts
type WorkflowRunHealth = {
  state: 'healthy' | 'underfilled' | 'degraded' | 'recovering' | 'recovery_required'
  providerLimit: number
  activeAttempts: number
  runnableAgents: number
  preparingAgents: number
  retryWaitingAgents: number
  stalledAgents: number
  oldestProgressAgeMs?: number
  storageQueueDepth: number
  storageOldestAgeMs?: number
}
```

Per attempt expose:

- attempt number and state;
- last heartbeat, provider event, and meaningful progress timestamps;
- current operation/activity;
- next deadline and next retry time;
- provider session;
- process state without secrets;
- durable worktree path;
- safety/recovery classification.

Extend `workflow_run_status` with this health summary while preserving existing manifest fields.
Add a manual agent/run recovery action only for `recovery_required`; normal retry should not depend
on an MCP model remembering to call another tool.

The MCP instructions should explain:

- runs are self-healing within policy;
- `running` plus `recovering` is normal during a retry;
- manual resume is for edited source, exhausted recovery, or unsafe ambiguous side effects;
- callers should report a prolonged unhealthy state rather than repeatedly launching duplicate
  runs.

## Configuration policy

Reliability limits are host policy. Workflow source may request a narrower stall tolerance but may
not raise process, retry, or concurrency ceilings beyond the host configuration.

Add a typed policy:

```ts
type WorkflowReliabilityPolicy = {
  providerConcurrency: number
  serviceProviderConcurrency: number
  preparationConcurrency: number
  providerStartupTimeoutMs: number
  noProgressSuspectMs: number
  noProgressAbortMs: number
  activeOperationTimeoutMs: number
  attemptTimeoutMs: number
  cancellationGraceMs: number
  hardKillGraceMs: number
  maxAttemptsPerAgent: number
  maxRetriesPerRun: number
  circuitBreakerThreshold: number
  circuitBreakerWindowMs: number
  ownerLeaseDurationMs: number
  ownerLeaseRenewIntervalMs: number
}
```

Validate cross-field invariants such as suspect < abort < attempt maximum and renew interval < lease
duration. Persist the effective non-secret policy with the run so recovery does not silently change
semantics after an application upgrade.

Keep concurrency nine as the default operating point. Environment/host overrides can lower it or,
within a reviewed maximum, raise it. Workflow JavaScript cannot set it.

## Implementation sequence

### Milestone 0 — Baseline instrumentation and deterministic failure fixtures

Deliverables:

- scheduler snapshot and utilization breadcrumbs;
- per-attempt liveness timestamps in memory;
- fake provider modes for silence, ignored abort, delayed final response, retryable failure, and
  process exit;
- hermetic tests that cannot discover real `~/.claude/workflows` definitions;
- a repeatable nine-agent soak harness with seeded timings.

No automatic retry yet. This milestone proves the current failure and provides measurements needed
to tune defaults.

Exit criteria:

- a silent fake attempt is identified in diagnostics before the run-wide timeout;
- queue/active counts explain every observed underfilled interval;
- the test suite is independent of user home-directory contents.

### Milestone 1 — Work-conserving scheduler extraction

Deliverables:

- `workflowScheduler.ts` with explicit runnable/preparing/retry queues;
- pump-loop invariant and fairness tests;
- provider permits acquired only immediately before provider start;
- retry waits and cleanup outside provider capacity;
- service-wide admission interface, initially backed by the same process;
- underfilled/no-runnable-work diagnostic.

Exit criteria:

- the 100-agent tail test continuously fills nine slots while queued work exists;
- provider concurrency never exceeds nine;
- two concurrent runs respect the configured global ceiling.

### Milestone 2 — Attempt watchdog and retry state machine

Deliverables:

- `agentAttemptSupervisor.ts`;
- linked per-attempt abort controllers and deadline scheduling;
- attempts numbered under one logical agent;
- retry classification, backoff, budgets, and circuit breaker;
- explicit stalled/retry events and state projection;
- terminal provider `null` only after retry exhaustion;
- clean cancellation races.

Exit criteria:

- a deliberately silent one-of-nine attempt is aborted and replaced while eight siblings continue;
- the workflow finishes without waiting for the run-wide timer;
- an ignored abort never releases capacity until termination is resolved;
- deterministic configuration errors do not retry.

### Milestone 3 — Durable logical-agent workspaces

Deliverables:

- `workflowWorkspaceLease.ts` contract;
- persistent Agent Code worktree root and adoption/reconciliation;
- preparation pool and cleanup reconciler;
- workspace lifecycle events and recovery records;
- Git command timeouts and cancellation;
- retry in the same worktree.

Exit criteria:

- kill the attempt after a file edit and prove attempt two sees the edit;
- kill the host and prove startup finds the same dirty worktree;
- clean cleanup never consumes a provider slot;
- dirty work is never removed silently.

### Milestone 4 — Recovery ledger and automatic safe restart

Deliverables:

- append-only private recovery ledger;
- exact-source sparse completed-call reuse;
- successful-null versus failure-null distinction;
- run owner lease and fencing generation;
- automatic linked recovery run;
- safety classification and `recovery_required` state;
- lineage-following MCP/UI references.

Exit criteria:

- crash with call five unfinished and calls six through nine complete; only call five resumes;
- a stale owner cannot append or execute after fencing;
- read-only and worktree-only runs recover automatically;
- ambiguous external effects do not auto-repeat.

### Milestone 5 — Provider host and hard process-tree control

Status: provider-host isolation and best-effort escalation implemented; authoritative creation-time
containment remains outstanding on every platform. POSIX process groups are escapable through
`setsid()`, and Windows `taskkill /T` has a creation race without a kill-on-close Job Object.

Deliverables:

- data-only provider host protocol;
- heartbeat and health sampling;
- confirmed cooperative abort and forced tree termination;
- Codex SDK lifecycle integration;
- orphan process reconciler at service startup;
- platform-specific termination tests.

Exit criteria:

- a provider fixture that ignores SIGTERM is forcibly reaped with all descendants;
- no permit is leaked;
- no Codex descendant remains after cancellation, retry, or service crash simulation.

### Milestone 6 — Store throughput and corruption isolation

Deliverables:

- control/telemetry split and coalescing;
- group-commit ordered writer;
- journal append log and compaction;
- state checkpoints and log rotation;
- atomic idempotency index;
- per-run quarantine;
- storage health projection.

Exit criteria:

- sustained nine-agent activity does not block main/renderer heartbeats;
- recovery time remains bounded as event history grows;
- fault injection at each commit boundary yields either the old or new valid state;
- one corrupt run does not prevent service initialization.

### Milestone 7 — Persistent supervisor daemon

Deliverables:

- single-instance local supervisor;
- authenticated local control transport;
- Agent Code attach/detach behavior;
- explicit quit-versus-continue policy;
- upgrades and stale-daemon handling;
- end-to-end app crash/restart recovery.

Exit criteria:

- force-kill Electron while nine agents run;
- workflows continue under the supervisor;
- restart Agent Code and reattach without duplicate attempts or lost worktree state.

## File-level change map

Expected new files, following the package's plain-file convention:

```text
src/workflowScheduler.ts
src/agentAttemptSupervisor.ts
src/workflowReliabilityPolicy.ts
src/workflowWorkspaceLease.ts
src/workflowRecoveryLedger.ts
src/workflowOwnerLease.ts
src/providerHostProtocol.ts
src/providerHost.ts
```

Expected existing-file responsibilities:

- `runWorkflow.ts`: coordinate components and workflow semantics; stop owning raw retry timers and
  semaphore details directly.
- `agentProvider.ts`: lifecycle-bearing provider execution handle and safety/health metadata.
- `codexProvider.ts`: Codex error classification, normalized progress, provider host adapter.
- `workflowEvents.ts`: additive retry/stall/workspace/recovery events.
- `workflowState.ts`: pure projection of new logical-agent and attempt states.
- `workflowJournal.ts`: retain Claude compatibility matching; do not overload it with owner/process
  state.
- `persistentWorkflowJournal.ts`: migrate compatibility persistence without whole-snapshot hot-path
  rewrites.
- `workflowService.ts`: global admission, owner fencing, automatic recovery, health queries.
- `fileWorkflowStore.ts`: ordered writer/checkpoints/rotation during the storage milestone.
- `workflowMcp.ts`: health projection and explicit recovery-required controls.
- `fakeProvider.ts`: deterministic hang, retry, heartbeat, unsafe-side-effect, and kill fixtures.
- `workflowWorker.ts`: heartbeat/idle state and optional work-conserving authoring helper.

Narrow Agent Code host changes:

- `GitWorkflowWorktree.ts`: accept durable lease identity/path; stop using anonymous temporary roots;
- `ElectronWorkflowWorkerLauncher.ts`: asynchronous confirmed termination;
- `createWorkflowService.ts`: provide host reliability policy and service-wide admission owner;
- Workflow bridge/UI: display health/retry state without subscribing to unbounded raw activity.

## Test strategy

### Deterministic fake-provider cases

Add scripts for:

- never emits a provider session;
- emits session then becomes silent;
- emits heartbeat without meaningful progress;
- starts a command and never completes it;
- completes tools but never emits the final message;
- rejects retryable once then succeeds;
- rejects retryable until exhausted;
- rejects non-retryable;
- ignores abort forever;
- emits success concurrently with timeout;
- emits an event after cancellation;
- leaves an ambiguous external tool in flight;
- crashes its provider host with descendant processes.

Use a fake clock for deadline/backoff logic. Do not make the main suite sleep for minutes.

### Scheduler property tests

For seeded random agent durations and failures, assert throughout execution:

- `active <= limit`;
- if `runnable > 0` and circuit/pause are closed, the next pump reaches the limit;
- one live attempt per logical agent;
- terminal logical agents never reenter the queue;
- retries remain within budgets;
- every acquired permit is released exactly once;
- result order remains workflow input order, not completion order.

### Crash fault injection

Terminate at every important boundary:

```text
after run directory creation
after worktree preparing record
after Git worktree creation
after workspace ready
after provider start before session
after provider session persistence
during a tool
after result ledger append before event append
after event append before manifest/checkpoint
after completion before cleanup
during owner lease renewal
```

Recovery must either adopt a valid resource/state or report a precise recoverable error. It must
never guess that uncertain external work did not happen.

### Soak and acceptance suite

Create an opt-in local soak that runs at least 500 logical fake agents with concurrency nine and a
seeded mix of:

- 10% transient failures;
- 5% silent stalls;
- 2% ignored cooperative aborts;
- large activity payloads;
- slow worktree preparation;
- storage latency bursts;
- randomized host restart points.

Acceptance measurements:

- no silent stall remains undetected for 30 minutes; default idle stalls recover in under ten;
- provider utilization remains at nine whenever at least nine runnable agents exist;
- no provider/process/worktree permit leak;
- no orphan provider descendants;
- bounded memory and event-writer queue;
- every completed logical result appears once;
- every retry and recovery decision is visible;
- dirty worktrees survive;
- unsafe ambiguity pauses instead of duplicating effects.

## Rollout and safety

1. Ship instrumentation first with retries disabled.
2. Enable automatic retry for read-only fake/integration workloads.
3. Enable for read-only production Codex after hard termination is verified.
4. Enable same-worktree retry for isolated local writes.
5. Keep external/unknown tools manual until capability/idempotency evidence exists.
6. Enable automatic restart recovery behind a host feature flag.
7. Move the flag default only after the soak and forced-crash suite passes repeatedly.

Persist the effective policy and implementation version in diagnostics. A rollback must be able to
read old runs and leave newer unsupported recovery records quarantined rather than corrupting them.

## Definition of done

Workflow MCP is "safe to leave running" when all of the following are true:

- a single silent agent cannot hold a workflow for 30 minutes without a visible diagnosis and
  policy action;
- one failed attempt is retried beneath the same logical agent without losing its provider session
  or worktree;
- nine slots stay full whenever nine runnable agents exist;
- an artificial workflow batch barrier is diagnosed clearly instead of being confused with a
  scheduler bug;
- retries release capacity during backoff and cleanup;
- cancellation escalates through the directly owned host/original process group, while descendants
  which can escape that group remain explicitly unconfirmed and quarantined;
- completed siblings are not unnecessarily rerun after an exact-source crash recovery;
- restart recovery is automatic for safe work and explicit for ambiguous side effects;
- worktree state is durable and dirty work is never silently deleted;
- high-frequency telemetry cannot starve control records or freeze the host;
- status/MCP/UI show last progress, deadlines, attempts, retries, worktree, and recovery state;
- deterministic failure, crash, utilization, and soak tests enforce every invariant above.

Until those conditions hold, documentation and UI should describe the system as durable and
manually resumable, not as lossless or self-healing.
