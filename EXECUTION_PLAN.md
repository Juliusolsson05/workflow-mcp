# Execution layer plan

This plan turns a loaded Claude-compatible workflow into a running hierarchy of phases, logical
agent calls, provider activity, and results. It stops at the boundary needed by a future MCP server
and Agent Code UI. It does not implement either of those consumers.

The plan is deliberately one package with plain filenames. We should not create a framework of
folders or abstractions before the compatibility tests force one.

## Implementation status — 2026-07-14

Milestones 1–7 now have a tested baseline in `feat/workflow-execution`: closed events and pure
projection, a credential-free child worker, the shared scheduler and helpers, in-memory v2 journal
reuse, one-level composition, interrupted provider-session resume, fake-provider conformance, and
the pinned Codex SDK adapter. The full deterministic suite includes a 76-agent state fixture and a
17-agent execution fan-out. One real authenticated Codex workflow is covered by the opt-in suite.

The native-process benchmark harness for milestone 8 is implemented as `npm run benchmark:codex`,
but its 49 real turns are intentionally not run by CI or as a side effect of installation. Until
those measurements are recorded, default concurrency is the conservative value four. Durable
storage, MCP transport, and UI code remain outside this execution change exactly as planned.

## Outcome

Given a workflow such as `fat-bug-hunt`, the execution layer must be able to represent and run:

```text
workflow run
  -> phase or pipeline step
    -> logical agent call
      -> provider attempt
        -> command, file, tool, reasoning, and message activity
      -> structured or text outcome
```

The public result is not only the final JavaScript return value. A caller must also be able to
observe enough structured state to build the workflow inspector demonstrated by Claude Code:

- workflow name, description, status, duration, and run-wide agent counts;
- ordered phase or pipeline-step membership so a UI can show a selected agent as `1/17`;
- the selected logical agent's label and status;
- whether its result ran live or came from a resume journal;
- expandable prompt content and line count;
- ordered provider activity with full history and a compact “last N” view;
- structured output or text outcome;
- cancellation, failures, usage, and provider-session identity.

The executor must emit data, not terminal-shaped strings. Agent Code can choose how to render the
same events without teaching the runtime about boxes, keybindings, truncation, or colors.

## What the observed inspector tells us

The supplied `fat-bug-hunt` view adds several requirements that are easy to miss when designing
only around a final return value.

### Logical calls and provider attempts are different

An entry such as `find:main-sessions` is one logical `agent()` call. It may be satisfied by a live
Codex turn, a resumed provider thread, a Claude-compatible journal result, or eventually a retry.
Those attempts must not inflate the workflow's logical agent count.

The data model therefore needs both:

```text
logical agent ID    stable identity within the workflow run
provider attempt ID one concrete live/resumed provider execution
```

### Totals are dynamic

JavaScript branches and loops mean the executor cannot know the final number of agents before
running the workflow. The available denominator is the number of logical calls admitted so far. A
`parallel()` call normally admits all 17 thunks synchronously, so its phase quickly has 17 ordered
members; later stages may increase the run-wide denominator as they are reached.

At terminal run state, the denominator is final. While running, consumers must treat it as a
monotonically increasing admitted count, not a prediction.

Because the supplied inspector says `done` and offers `↑↓ agent` navigation, its `9/76 agents` and
`1/17` values are best understood as selected-agent ordinals, not completed-progress fractions.
The snapshot must therefore expose stable ordering separately from independent queued, running,
completed, failed, reused, skipped, and cancelled counts.

### Journal hits still need complete UI state

“Completed · from resume journal” means a cache hit cannot be an invisible optimization. It must
materialize a normal terminal logical-agent record with its prompt, result, call index, phase,
cache key, and `source: "journal"`. It simply has no new provider attempt.

### Activity is structured history

The selected agent showed the last three of 28 tool calls. We therefore need the entire ordered
activity sequence and stable activity IDs. The “last three” slice belongs in the UI projection;
the executor must not discard the first 25.

### Prompt and outcome are first-class artifacts

Prompts and structured outcomes can be hundreds of lines. Events should carry bounded previews
and references to full content. The first in-memory implementation may retain content directly,
but its types must already distinguish preview from full artifact so persistence does not require
an event-contract rewrite.

## Scope

The execution layer includes:

- a killable child process containing the restricted V8 workflow realm;
- `args`, `budget`, `agent`, `parallel`, `pipeline`, `phase`, `log`, and nested `workflow` globals;
- a shared scheduler, call cap, budget, timers, and cancellation signal;
- a provider-neutral agent interface and deterministic fake provider;
- structured execution events and a pure state projection;
- Claude-compatible journal keying and longest-prefix reuse;
- a Codex SDK provider adapter after fake-provider conformance passes;
- tests for the observed Claude `2.1.209` behavior.

It does not include:

- MCP tools or transports;
- SQLite or a daemon;
- Agent Code React components;
- multiple production providers;
- distributed scheduling;
- a plugin marketplace;
- token-by-token text synthesized from providers that do not expose it;
- execution of ignored raw reference files as trusted code.

## Plain file layout

Add files only as their milestone begins:

```text
src/
  runWorkflow.ts       public run handle and parent-process coordinator
  workflowWorker.ts    child-process entry and restricted V8 realm
  workerMessages.ts    data-only parent/child message union
  workflowEvents.ts    stable executor event types and event sink
  workflowState.ts     pure event-to-snapshot reducer
  agentProvider.ts     provider request, activity, result, and interface
  fakeProvider.ts      deterministic provider used by conformance tests
  workflowJournal.ts   call keys and longest-prefix reuse
  codexProvider.ts     @openai/codex-sdk adapter

test/
  runWorkflow.test.ts
  workflowHelpers.test.ts
  workflowState.test.ts
  workflowJournal.test.ts
  codexProvider.test.ts
  codexProvider.integration.test.ts
```

Do not create `core/`, `domain/`, `engine/`, `orchestration/`, `services/`, or one-folder-per-type.
If a file later becomes genuinely unmanageable, split it by a concrete responsibility and name
that responsibility directly.

## Public execution API

The intended top-level API is:

```ts
type RunWorkflowOptions = {
  workflow: LoadedWorkflow
  args?: unknown
  cwd: string
  provider: AgentProvider
  limits?: Partial<WorkflowLimits>
  budgetTokens?: number | null
  journal?: WorkflowJournal
  resolveWorkflow?: WorkflowResolver
  eventSink?: WorkflowEventSink
  signal?: AbortSignal
}

type WorkflowRun = {
  id: string
  events: AsyncIterable<WorkflowEvent>
  result: Promise<unknown>
  cancel(reason?: string): Promise<void>
}

function runWorkflow(options: RunWorkflowOptions): WorkflowRun
```

Returning a handle immediately is important. A 76-agent workflow must not hold an MCP tool call or
UI action open until the final result. The same handle works initially with an in-memory sink and
later with a durable service.

`runWorkflow()` owns orchestration but never evaluates workflow JavaScript in the credentialed
parent process. Provider credentials and SDK objects remain in the parent. Only cloned data crosses
the child-process boundary.

## Provider interface

Use one execution method with an event callback rather than separate `events()` and `result()`
consumers. The Codex SDK exposes one async generator; allowing two consumers would force a replay
buffer and create avoidable ownership races.

```ts
type AgentProvider = {
  execute(
    request: AgentRequest,
    context: {
      signal: AbortSignal
      emit(event: AgentProviderEvent): Promise<void>
    },
  ): Promise<AgentProviderResult>
}
```

`AgentRequest` contains only provider-relevant data:

```text
prompt
schema
model
effort
workingDirectory
sandbox policy
resolved agent-type instructions
provider session reference when resuming
```

It intentionally excludes phase, label, cache key, logical-agent ID, and workflow limits. Those
belong to the workflow runtime, even if the adapter includes them in telemetry.

`AgentProviderEvent` is a small normalized union:

```text
session.started
activity.started
activity.updated
activity.completed
warning
```

Activity kinds initially cover:

```text
message
reasoning
command
file_change
tool_call
web_search
todo_list
error
```

Provider-native event names must not escape `codexProvider.ts`. The workflow event layer adds run,
phase, logical-agent, and attempt identity before publishing them.

## Event contract

Every event receives its sequence number and timestamp in the parent process. This creates one
ordering authority even when the worker and many providers emit concurrently.

```ts
type WorkflowEvent = {
  schemaVersion: 1
  runId: string
  sequence: number
  eventId: string
  timestamp: string
  type: WorkflowEventType
  phaseId?: string
  agentId?: string
  attemptId?: string
  parentId?: string
  payload: unknown
}
```

Initial event families:

```text
run.started
run.completed
run.failed
run.cancellation_requested
run.cancelled

phase.discovered
phase.entered

agent.admitted
agent.queued
agent.reused
agent.started
agent.activity.started
agent.activity.updated
agent.activity.completed
agent.completed
agent.failed
agent.skipped
agent.cancelled

log
warning
artifact.created
```

Do not add `phase.completed` until its meaning is proven. A workflow can assign an explicit old
phase to a later agent, so “the next `phase()` call happened” is not necessarily terminal. The
state projection can show a phase as complete when the run is terminal and all of its admitted
agents are terminal. We can add an explicit event later if Claude evidence establishes one.

Do not require `agent.output.delta`. The Codex TypeScript SDK currently publishes structured
activity and completed agent messages, not token-by-token message deltas. Providers that expose
deltas may map them to bounded activity updates, but workflow correctness cannot depend on them.

### Logical-agent payload

`agent.admitted` establishes the record used by counters and journal ordering:

```ts
type AgentAdmitted = {
  callIndex: number
  label: string
  phaseId?: string
  prompt: ContentReference
  options: NormalizedAgentOptions
  cacheKey: string
}
```

`agent.completed` or `agent.reused` contains:

```ts
type AgentOutcome = {
  source: 'live' | 'provider-resume' | 'journal'
  result: ContentReference
  structured: boolean
  usage?: AgentUsage
  providerSession?: ProviderSessionReference
}
```

Provider retries create new attempt IDs under the same logical agent ID. Counters use logical
agents; diagnostics may separately show attempt counts.

## State projection

`workflowState.ts` is a pure reducer:

```ts
function reduceWorkflowState(
  state: WorkflowSnapshot,
  event: WorkflowEvent,
): WorkflowSnapshot
```

The snapshot contains:

```text
run metadata and terminal status
elapsed timestamps
dynamic logical-agent totals by status
phases in first-seen/metadata order
logical agents in call-index order
attempts and ordered activity per agent
logs and warnings
final workflow result or error
```

This reducer is the proof that the execution contract can drive the observed inspector. React,
MCP, and persistence do not belong in its tests.

Required snapshot assertions for the `fat-bug-hunt`-shaped fixture:

- the run exposes its name and description;
- a phase containing 17 admitted calls preserves their order so a UI can derive `1/17` selection;
- selecting one agent exposes its full prompt and prompt line count;
- 28 activities remain ordered and a consumer can take the last three;
- structured output remains parsed data rather than an ANSI/text rendering;
- a journal hit is completed with `source: "journal"` and no live attempt;
- run-wide logical counts do not increase because of retries or provider resume.

## Parent and worker boundary

The parent process owns:

- provider credentials and SDK instances;
- event sequencing and publication;
- scheduler admission and provider concurrency;
- journal reads/writes;
- worktree lifecycle;
- cancellation policy and wall-clock timeout;
- nested workflow resolution.

The child process owns:

- the V8 context;
- ordinary workflow JavaScript state such as arrays, maps, loops, and closures;
- helper semantics for `parallel()` and `pipeline()`;
- current phase and bounded timers;
- correlation of `agent()` promises with parent responses.

The message protocol is data-only:

```text
parent -> child: start, agentResult, nestedWorkflowResult, cancel
child -> parent: ready, agentRequest, nestedWorkflowRequest, phase, log, complete, failed
```

Every request has a correlation ID. Unknown messages, duplicate terminal responses, unserializable
payloads, or messages after termination fail the run instead of being ignored.

The parent must be able to kill the child process. A worker thread is insufficient as the primary
trust boundary because it shares the process and cannot give us an honest memory/credential
isolation story.

## Restricted JavaScript realm

The worker receives the already parsed workflow body and evaluates an async wrapper so top-level
`await` and `return` behave like Claude workflows.

The V8 context must have:

- a null-prototype global;
- string and WASM code generation disabled;
- no `process`, `require`, Node builtins, fetch, filesystem, environment, or dynamic import;
- deterministic restrictions for `Date.now()`, argumentless `new Date()`, and `Math.random()`;
- frozen injected capabilities;
- tracked, bounded `setTimeout` and `clearTimeout` wrappers;
- cloned `args` and cloned/sanitized return values;
- a 30-second synchronous execution limit and a separate run wall-clock limit.

Node explicitly states that `vm` is not a security mechanism. The killable credential-free child
process is therefore mandatory, and remote multi-tenant deployment remains out of scope without
an OS container or microVM.

Before implementing all helpers, spike timeout behavior for four cases:

```text
while (true) {}
await Promise.resolve(); while (true) {}
setTimeout(() => { while (true) {} }, 0)
an unresolved agent promise followed by cancellation
```

The test process must never hang. If `vm` timeout does not cover a resumed microtask or timer, the
parent wall-clock kill is the backstop and the limitation must be documented rather than hidden.

## Scheduler and admission

One scheduler is shared across the run and one allowed nested workflow level.

Defaults for the Claude `2.1.209` profile:

```text
concurrency = min(16, max(2, cpuCount - 2))
maximum logical agent calls = 1,000
maximum parallel or pipeline input = 4,096
synchronous VM timeout = 30 seconds
```

The caller may lower limits. Workflow code may never raise them.

Call indexes are assigned synchronously when `agent()` is invoked, before waiting for a scheduler
slot or provider. This preserves deterministic journal order when `parallel()` invokes many thunks
at once.

Cancellation performs, in order:

1. mark cancellation requested and reject new admission;
2. cancel queued logical calls without starting providers;
3. abort every live provider attempt;
4. tell the worker to reject pending capability calls;
5. allow a short cleanup grace period;
6. kill the worker if it does not terminate;
7. publish exactly one terminal run event.

Terminal-event races must be tested. Completion, failure, cancellation, provider error, and worker
exit may happen concurrently, but only one may win.

## Helper behavior

### `agent()`

The worker normalizes prompt and options, then asks the parent to admit the call. The parent owns
schema validation, journal lookup, scheduling, worktree selection, provider execution, result
validation, usage charging, and terminal events.

The first version must match the observed distinctions:

- provider/API terminal failure becomes a logged `null` result;
- user/policy skip becomes `null`;
- invalid schema fails before provider execution;
- ordinary runtime errors reject the `agent()` promise;
- missing or invalid structured output rejects;
- unknown options do not affect execution or cache identity.

Use a standards-based JSON Schema validator rather than maintaining a custom recursive checker.
The exact dependency and supported draft must be pinned in the implementation PR after verifying it
accepts the schemas in the sanitized corpus and Codex output-schema surface.

### `parallel()`

Validate all entries, invoke every thunk without awaiting earlier entries, and use the shared
scheduler for actual provider concurrency. Preserve input order. Convert each slot's synchronous
throw, rejection, or budget-admission failure to `null` while allowing siblings to finish.

### `pipeline()`

Start every input item independently. Each item proceeds to its next stage as soon as its previous
stage resolves; there is no global stage barrier. Pass `(previous, original, index)` exactly.
Only `null` skips the remaining stages. Preserve original input order in the final array.

Pipeline stages are JavaScript callbacks, not runtime phase definitions. The event layer groups
agents by explicit/current phase and label. It must not invent stages by parsing label text such as
`find:main-sessions`.

### `phase()` and `log()`

`phase()` changes the default phase for later agents and emits `phase.discovered` only the first
time a title appears. Metadata phase order is seeded before execution. `log()` emits bounded text
through the parent event stream; it never writes directly to stdout as its source of truth.

### `budget`

Budget admission is centralized in the parent. `spent()` and `remaining()` are worker RPC-backed
snapshots of the same ledger used by provider completion. Existing calls are not killed when a
sibling consumes the remaining budget.

The exact token accounting formula is a conformance question. Do not silently choose input-only,
output-only, or total tokens. Capture raw provider usage first, then pin Claude-compatible budget
accounting with an explicit test fixture.

### Nested `workflow()`

Resolve names and direct paths in the parent through the existing loader. The child shares limits,
budget, cancellation, journal chain, scheduler, and event sink. Reject a second nested level.

Nested execution should reuse the same worker only if that proves simpler without leaking globals;
otherwise spawn a second credential-free worker under the same parent run. This choice must be
made by a focused test of phase/log behavior, not by building a generic workflow tree.

## Journal and resume

Implement journaling after live fake-provider execution passes. Do not let cache concerns distort
the first scheduler.

The journal records logical calls in call-index order with Claude-compatible chained keys. It must
support:

- longest unchanged prefix reuse;
- source-hash separation;
- execution-affecting option hashing;
- label and phase changes without cache invalidation;
- started-without-result respawn;
- `null` as non-reusable;
- immediate materialization of `agent.reused` events;
- provider session references for interrupted live calls.

Journal persistence can begin behind an interface with an in-memory implementation. SQLite belongs
to the later service milestone, not this execution PR.

## Codex provider

`codexProvider.ts` maps one admitted logical call to the supported TypeScript SDK:

```text
prompt -> runStreamed()
schema -> outputSchema
model -> configured alias or explicit Codex model
effort -> modelReasoningEffort
cwd/worktree -> workingDirectory
policy -> sandboxMode, approvalPolicy, network, additional directories
cancel -> AbortSignal
session -> thread ID / resumeThread()
usage -> turn.completed usage
```

The adapter consumes the SDK generator once, emits normalized activity, captures the thread ID as
soon as `thread.started` arrives, and resolves only after a terminal turn event. It parses and
independently validates structured final text.

Default unattended policy is:

```text
sandbox = workspace-write
network = disabled
approval policy = never
extra writable directories = none
```

The server may grant a broader configured policy, but workflow JavaScript cannot request one.

The SDK inherits process environment unless given an explicit `env`. The production adapter must
pass a minimal allowlist sufficient for Codex authentication and execution; it must not forward
arbitrary server secrets to child Codex processes.

Claude model aliases such as `sonnet` cannot be sent to Codex literally. Use explicit runtime
configuration, for example `modelAliases`, and report an unmapped explicit model rather than
silently choosing a different capability tier.

## Fake provider

The fake provider is a production-shaped test tool, not a throwaway mock. It must be able to script:

- text and structured results;
- ordered activity events;
- token usage;
- deterministic delays;
- provider failures and ordinary errors;
- invalid JSON and schema violations;
- blocking until cancellation;
- provider session IDs and resume;
- concurrency tracking and reversed completion order.

All workflow-semantic tests use the fake provider. Real Codex tests prove adapter integration only;
they cannot be the oracle for deterministic scheduling or cache behavior.

## Implementation sequence

Each milestone ends in a usable vertical slice. Do not begin the next one with failing tests.

### Milestone 1: contracts and projection

Add `workflowEvents.ts`, `workflowState.ts`, and `agentProvider.ts`.

Acceptance gate:

- hand-authored events reduce into the complete `fat-bug-hunt`-shaped snapshot;
- dynamic totals, ordered 17-agent phase membership, 28 activities, structured outcome, and journal source
  are all representable;
- retries do not change logical counts;
- event unions are exhaustively type-checked.

### Milestone 2: worker realm

Add `workflowWorker.ts`, `workerMessages.ts`, and the first `runWorkflow.ts` path supporting
`args`, return values, `phase()`, `log()`, timers, cancellation, and failure.

Acceptance gate:

- top-level await and return work;
- prohibited globals and code generation fail;
- result cloning rejects functions, cycles, and dangerous keys;
- all four timeout/cancellation spikes terminate;
- worker exit produces one terminal run state.

### Milestone 3: fake-provider `agent()`

Add `fakeProvider.ts`, the shared scheduler, agent option normalization, schema handling, and agent
events.

Acceptance gate:

- 17 calls are admitted immediately but never exceed configured live concurrency;
- prompts, labels, phases, activities, structured results, usage, and provider sessions project
  correctly;
- null, skip, provider failure, ordinary error, invalid schema, and cancellation distinctions
  match the compatibility matrix;
- the 1,000-call ceiling is enforced before provider start.

### Milestone 4: `parallel()` and `pipeline()`

Acceptance gate:

- parallel settlement order cannot change result order;
- one parallel slot failure becomes `null` without cancelling siblings;
- pipeline items progress without a global barrier;
- `null` skips and `undefined` continues;
- nested `parallel()` inside a pipeline stage works under the same scheduler;
- the sanitized three-stage stress fixture completes with expected counts and ordering.

### Milestone 5: journal reuse

Add `workflowJournal.ts` and in-memory journal tests.

Acceptance gate:

- full and partial prefix hits match observed behavior;
- a 17-agent phase can contain a mix of live and journal outcomes;
- reused agents have no provider attempt but remain fully inspectable;
- started-only and `null` entries respawn;
- a first miss invalidates every later historical result.

### Milestone 6: nested workflow

Acceptance gate:

- name and direct-path resolution use the loader;
- child args are explicit and limits are shared;
- child logs/phases follow the pinned compatibility behavior;
- a second nesting level fails clearly;
- cancellation terminates parent and child activity.

### Milestone 7: Codex SDK adapter

Add the pinned SDK dependency, `codexProvider.ts`, mocked adapter tests, and an opt-in real
integration test.

Acceptance gate:

- existing ChatGPT login and API-key modes are documented;
- streamed commands/files/tools become normalized activities;
- structured output is independently validated;
- abort and resume work through the provider interface;
- no ambient test secret is present in the configured Codex environment;
- SDK/CLI version and provider session ID appear in diagnostics.

### Milestone 8: fan-out benchmark and default limits

Run 1, 4, 8, 16, and 20 concurrent no-write Codex agents in a disposable repository. Record:

```text
startup latency
wall-clock completion
peak process count
peak resident memory
failure/timeout rate
cancellation latency
package/runtime footprint
```

Do not assume Claude's ceiling of 16 is appropriate for a TypeScript SDK that starts one native
process per turn. Choose the Codex default from measurements while retaining a configurable server
ceiling.

## Verification commands

The implementation PR should eventually make these the ordinary checks:

```bash
npm run build
npm test
npm run test:integration -- --provider=fake
WORKFLOW_CODEX_INTEGRATION=1 npm run test:integration -- --provider=codex
```

The real Codex suite must be opt-in because it consumes account capacity and is nondeterministic.
CI correctness comes from the fake provider and sanitized fixtures.

## Definition of done

The execution layer is ready for MCP work when all of the following are true:

- a sanitized three-stage workflow with at least 17 first-stage agents runs to completion;
- helper ordering, failure, null, budget, and concurrency behavior matches the pinned profile;
- journal reuse produces inspectable logical agents indistinguishable from live agents except for
  source and attempt history;
- cancellation leaves no provider or worker process running;
- the pure snapshot can populate every data region visible in the supplied Claude inspector;
- Codex executes the same workflow through the provider interface without workflow-file changes;
- fan-out measurements justify the configured default;
- no MCP, React, SQLite, distributed scheduler, or provider-specific type has leaked into the
  workflow realm.

Only then should the next plan add durable storage and MCP tools. That sequence keeps the hard
compatibility behavior testable before transport and UI concerns begin multiplying states.
