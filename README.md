# workflow-mcp

`workflow-mcp` is the working name for a standalone runtime and Model Context Protocol server
that executes Claude Code dynamic-workflow files through interchangeable agent providers.

The central compatibility promise is intentionally simple:

> A workflow authored for `workflow-mcp` can be copied into `.claude/workflows/<name>.js` and
> run by a compatible Claude Code release without changing the JavaScript file.

The reverse direction matters too: real Claude workflow files should run through this runtime
without an importer or translation step. Provider selection, durable caching, custom metadata,
MCP transport, and Agent Code UI state belong outside the portable `.js` file.

The repository now contains the first compatibility baseline: a parser for one workflow file,
project/personal workflow discovery, a validation CLI, and tests against the local reference
corpus. It is not registered in Agent Code's `.gitmodules` and is not installed by Agent Code yet.
Agent execution, providers, caching, MCP transport, and UI integration remain future milestones.

## Current commands

```bash
npm install --include=dev
npm run check

# Validate one direct workflow path. Direct paths do not require a .js extension.
npm run build
node dist/cli.js validate ./path/to/workflow.js

# List personal and project workflows visible from a directory.
node dist/cli.js list ./path/to/project
```

The public API deliberately uses plain names:

```ts
import { findWorkflows, loadWorkflowFile, parseWorkflowSource } from 'workflow-mcp'
```

`parseWorkflowSource` parses a supplied string. `loadWorkflowFile` adds file-size and byte-hash
handling. `findWorkflows` performs `.js` discovery and user/project precedence. None of these
functions executes the workflow body.

## Why the name

The repository should be named `workflow-mcp`, and Agent Code should eventually mount it at
`packages/workflow-mcp`.

The name describes the public boundary instead of the first implementation backend:

- `claude-workflow-mcp` would incorrectly imply that Claude must execute every agent node;
- `codex-workflow-mcp` would expose an implementation detail and misstate file compatibility;
- `agent-workflows` is too broad and does not communicate the interoperable server surface;
- `workflow-mcp` says what a standalone user installs while leaving room for several providers.

An eventual npm package can use an available scope, but the source repository and executable can
remain `workflow-mcp`.

## Status and evidence boundary

This document records the research completed on 2026-07-14 against:

- Claude Code `2.1.209` installed on this machine;
- the public Claude workflow documentation and Claude Code changelog;
- the current public TypeScript and Python Codex SDKs;
- MCP `2025-11-25` plus the published 2026 Tasks-extension direction;
- 16 local workflow copies representing 12 unique source files;
- persisted metadata from eight real workflow runs;
- selected production workflow files found in public repositories.

There are three evidence grades throughout this document:

- **Documented**: stated by Anthropic, OpenAI, or the MCP specification.
- **Observed**: verified against the installed Claude Code `2.1.209` implementation or persisted
  local artifacts. This is a pinned compatibility profile, not a promise about future versions.
- **Project decision**: behavior `workflow-mcp` should own even when Claude stores or transports
  it differently.

The first supported profile should therefore be named `claude-code/2.1.209`. Future Claude
changes should add or update explicit profiles instead of silently changing old conformance
expectations.

## What a Claude dynamic workflow is

A dynamic workflow is a JavaScript orchestration program. The JavaScript owns loops, branches,
fan-out, intermediate values, and aggregation. Agent calls own model reasoning and side effects.
This keeps dozens or hundreds of intermediate agent results outside the parent conversation while
returning one final workflow value.

Claude Code discovers saved workflows as slash commands. Project workflows live under
`.claude/workflows/`; personal workflows live under `~/.claude/workflows/`. Workflows can also be
provided by plugins and invoked through the Agent SDK Workflow tool.

The minimum useful shape is:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files in parallel and verify findings',
  phases: [
    { title: 'Review', detail: 'Independent review agents' },
    { title: 'Verify', detail: 'Adversarial verification' },
  ],
}

phase('Review')
const findings = await parallel(
  args.files.map((file) => () =>
    agent(`Review ${file}`, {
      label: `review:${file}`,
      phase: 'Review',
      schema: {
        type: 'object',
        properties: { issues: { type: 'array', items: { type: 'string' } } },
        required: ['issues'],
        additionalProperties: false,
      },
    }),
  ),
)

return findings.filter(Boolean)
```

The file is a JavaScript dialect rather than an ordinary ESM module: Claude accepts top-level
`await` and top-level `return` after extracting the metadata declaration and wrapping the body.

## Compatibility contract

### Portable workflow file

The `.js` file may rely only on the Claude-compatible workflow realm. It must not require an MCP
extension, a provider-specific import, a Node builtin, or metadata that Claude needs to understand.

The portable surface for the `2.1.209` profile is:

```text
export const meta
args
budget
agent(prompt, options)
parallel(thunks)
pipeline(items, ...stages)
phase(title)
log(value)
workflow(nameOrDescriptor, childArgs)
console
setTimeout / clearTimeout
top-level await / return
```

### Runtime-owned state

The following may be richer than Claude because none of it has to live in the workflow file:

- custom metadata and catalog tags;
- provider selection and credentials;
- durable cross-session cache;
- MCP run identifiers and authorization ownership;
- event history, artifacts, transcripts, and UI projections;
- cost policy, concurrency ceilings, and deployment policy;
- crash recovery and idempotency keys.

The runtime may do more internally, but it must not cause its authoring tools to emit files that
Claude rejects.

### Environment dependencies

File compatibility is not the same as environment independence. A workflow that uses
`agentType: 'security-auditor'` still requires that agent type to exist in Claude. A nested
`workflow('validate', args)` still requires the child workflow to be installed. A workflow with an
absolute path may parse everywhere but only make sense on one machine.

The validator should report these as dependencies or portability warnings. It should not rewrite
the workflow or reject valid Claude syntax.

## Discovery and precedence

Observed Claude Code `2.1.209` behavior:

1. Only files ending in `.js` are discoverable.
2. `.mjs`, `.cjs`, and `.ts` are recognized as near misses and skipped.
3. User workflows are read from `~/.claude/workflows`.
4. Project workflow directories are discovered while walking from the repository root toward the
   current working directory.
5. When project workflows share the exact same name, the definition closest to the current working
   directory wins.
6. A project definition beats a personal definition with the same name.
7. Workflow names are exact and case-sensitive; they are not trimmed or normalized.
8. Plugin workflows normally use the visible identity `<plugin-name>:<workflow-name>`, so plugin
   composition is not equivalent to inserting plain local names into one map.
9. Local definitions beat an exact plugin-visible identity, and local/plugin identities beat an
   exact built-in identity.
10. The surviving personal/project list is sorted with raw `meta.name.localeCompare()`. The later
    combined built-in/plugin/local resolver is not globally resorted.
11. Symlinked files can participate subject to Claude's normal path/read safety checks.

Claude Code `2.1.178` introduced the documented nearest-directory save and lookup behavior. The
compatibility suite needs collisions at every layer because discovery mistakes can execute a
different workflow than the user approved.

## Source and metadata grammar

### File constraints

Observed for `2.1.209`:

- file size limit: 524,288 bytes before UTF-8 decoding;
- inline source limit: 524,288 JavaScript string code units;
- Acorn parses with the latest ECMAScript grammar, module source type, top-level await, and
  top-level return enabled;
- comments and a BOM may precede metadata because they are not AST statements;
- the first AST statement must be exactly one exported `const` declaration named `meta`;
- the initializer must be an object literal;
- the remaining source becomes the executable body.

The required declaration shape is:

```js
export const meta = { ... }
```

`export let meta`, `export var meta`, another statement before it, multiple declarations in the
same statement, or a computed initializer are incompatible.

### Pure-literal metadata

Claude accepts these metadata values:

- Acorn literal values, including the regexp and bigint values that Acorn represents as literals;
- arrays without holes or spreads;
- plain object initializers with noncomputed keys;
- negative numeric literals;
- template literals without interpolation.

Claude rejects:

- variable references and function calls;
- interpolated templates;
- spreads;
- sparse arrays;
- computed properties;
- methods, getters, and setters;
- arbitrary unary expressions;
- the keys `__proto__`, `constructor`, and `prototype`.

### Normalized metadata fields

Observed normalized fields are:

```ts
type WorkflowMeta = {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: Array<{
    title: string
    detail?: string
    model?: string
  }>
}
```

`name` and `description` must be strings with `length > 0`. Claude does not trim them: a whitespace
name is accepted and remains distinct, including during collision resolution. `phases` is not
proven mandatory in the installed parser, although all 12 unique local workflows use it. Invalid
phase entries are dropped rather than making the whole file invalid.

Unknown literal metadata keys are accepted by the parser but discarded from Claude's normalized
metadata. Consequently, custom metadata inside `meta` may remain syntactically compatible but is
not a reliable integration channel. `workflow-mcp` should store custom metadata in a sidecar or its
own database, keyed by workflow identity and source hash.

## JavaScript execution realm

Claude Code `2.1.209` uses a Node `vm` context with a null-prototype global and disables string and
WASM code generation. It injects:

```text
agent, parallel, pipeline, workflow, phase, log,
args, budget, console, setTimeout, clearTimeout
```

The following are deliberately unavailable or rejected:

- `require` and Node builtins;
- direct filesystem, shell, environment, and network access;
- dynamic `import()`;
- `Date.now()`;
- argumentless `new Date()`;
- `Math.random()`;
- `with`;
- `await using`.

The deterministic time/random restrictions protect resume identity. Workflows should receive
timestamps or random seeds through `args` when those values are truly inputs.

Synchronous JavaScript has a 30-second execution timeout. Final values cross a sanitizing clone
boundary and must be JSON-compatible; returning a function fails. Functions are omitted from
objects, dangerous prototype keys are blocked, cycles are rejected, and large arrays are bounded.

One observed official workflow avoids the `URL` class because the workflow realm is not a normal
Node or browser global environment. Our authoring validator must target Claude's actual globals,
even if the implementation runner happens to expose more internally.

## `args`

`args` is the invocation input after a JSON-style clone into the workflow realm. If omitted it is
`undefined`.

Real workflows use several shapes:

- raw strings;
- structured objects and arrays;
- object-or-JSON-string normalization for compatibility with different invokers.

The current Agent SDK declaration is narrower than observed documentation and real workflows.
`workflow-mcp` should accept any JSON-compatible value and preserve `undefined` when no input was
provided.

## `budget`

The injected object is frozen and shaped as:

```ts
type WorkflowBudget = {
  total: number | null
  spent(): number
  remaining(): number
}
```

Without an explicit token target, `total` is `null` and `remaining()` is `Infinity`. Budget checks
are admission controls: already-running calls are not retroactively killed when another call uses
the remainder.

The official local `extract-rules` workflow uses `budget.remaining()` to stop a loop-until-dry
search. Budget behavior is therefore part of the compatibility core, not optional accounting UI.

## `agent()`

The observed public shape is:

```js
await agent(prompt, {
  label,
  phase,
  schema,
  model,
  effort,
  isolation,
  agentType,
})
```

Observed semantics:

- primitive prompts are converted with JavaScript string coercion;
- objects and functions do not receive automatic JSON serialization;
- the fallback label is the first 60 prompt characters after collapsing whitespace;
- phase defaults to the current phase;
- unknown option fields are ignored;
- invalid effort values fall back to inherited/default effort;
- an invalid JSON Schema throws a `TypeError` before useful execution;
- schema mode requires a successful structured-output tool result;
- completion without the required structured output throws;
- API/terminal provider failure is logged and returns `null`;
- a user-skipped call returns `null`;
- ordinary execution errors reject the promise;
- `agentType` must resolve and be allowed or the call throws;
- `isolation: 'worktree'` creates per-call Git worktree isolation;
- installed code also contains remote isolation support, but availability is environment-specific;
- the internal default stall window is 180 seconds with up to five stall retries;
- no workflow may admit more than 1,000 agent calls.

The installed local concurrency calculation is:

```js
Math.min(16, Math.max(2, cpuCount - 2))
```

The internal `stallMs` option is not publicly documented and should not be treated as a portable
authoring feature merely because it exists in one build.

All 12 unique local workflows use schemas. Supported structured-output behavior and independent
validation are therefore required before the runtime can claim useful compatibility.

## `parallel()`

`parallel()` is a barrier over lazily invoked functions:

```js
const results = await parallel([
  () => agent('first'),
  () => agent('second'),
])
```

Observed semantics:

- input must be an array with at most 4,096 entries;
- every entry must be a function, not an already-started promise;
- an empty array returns `[]`;
- all thunks are invoked without waiting for earlier results;
- execution is still bounded by the shared workflow scheduler;
- settlement order does not change result order;
- a synchronous throw or asynchronous rejection in one slot becomes `null` and is logged;
- budget-admission failure in one slot also becomes `null`;
- one failed slot does not reject the outer `parallel()` call.

Real workflows index `results[i]` against the original batch. Stable input ordering is therefore
a correctness invariant rather than a presentation detail.

## `pipeline()`

`pipeline()` moves every original item through every stage without a global stage barrier:

```js
const results = await pipeline(
  items,
  (item, original, index) => agent(`Inspect ${item}`),
  (inspection, original, index) => agent(`Verify ${JSON.stringify(inspection)}`),
)
```

Observed semantics:

- the first argument must be an array with at most 4,096 entries;
- every remaining argument must be a function;
- an empty array returns `[]`;
- all items begin concurrently under the shared scheduler;
- item A may reach stage three while item B remains in stage one;
- every stage receives `(previousResult, originalItem, index)`;
- an intermediate value of exactly `null` skips remaining stages for that item;
- `undefined` does not skip later stages;
- a thrown or rejected stage turns only that item into `null`;
- final result order matches original input order.

The local deep-research workflow depends on barrier-free progression, shared synchronous `Map`
state, a global fetch cap, and a pipeline stage returning a nested `parallel()` promise. A
wave-based implementation with barriers would be observably incompatible.

## `phase()` and `log()`

`phase(title)` updates the default phase for subsequent agents and emits progress the first time a
distinct title is encountered. Metadata phases preseed phase identity and presentation. Agent
options may assign a phase explicitly.

`log(value)` emits bounded progress text. Both functions use ordinary string coercion for primitive
values; objects become generic object strings unless the workflow serializes them itself.

Logs are product events in our runtime, not diagnostic console output. They must enter the durable
event ledger so reconnecting MCP clients see the same history as live clients.

## Nested `workflow()`

Observed accepted forms are:

```js
await workflow('saved-name', childArgs)
await workflow({ scriptPath: '/path/to/workflow.js' }, childArgs)
```

Behavior in `2.1.209`:

- names resolve through normal discovery and precedence;
- `scriptPath` parses a direct file unless the session allows bundled names only;
- child `args` is the explicit second argument and is not implicitly inherited;
- the child shares the scheduler, concurrency, 1,000-call cap, budget, cancellation, timers, and
  cache/journal chain;
- child agents appear under a synthetic child phase;
- `phase()` inside the child is intentionally a no-op;
- child logs receive a workflow-name prefix;
- repeated child calls receive `#2`, `#3`, and later phase suffixes;
- a child cannot invoke another workflow: nesting is limited to one child level;
- child errors are logged and rethrown.

TinyUSB's public `full-check.js` is a concrete nested-workflow fixture.

## Persistence, cache, and resume

Claude persists per-run source, metadata, progress, logs, totals, results, and workflow-agent
transcripts beneath the active Claude session directory. Current local evidence includes eight run
records, eight workflow journals, and 392 agent transcript/metadata pairs.

Observed journal version two records are JSONL:

```json
{"type":"started","key":"v2:<sha256>","agentId":"..."}
{"type":"result","key":"v2:<sha256>","agentId":"...","result":{}}
```

Cache identity is a chained SHA-256 over the preceding call key, prompt, and canonicalized
execution-affecting options. Included options are:

- `schema`;
- `model`;
- `effort`;
- `isolation`;
- `agentType`.

Excluded values are:

- `label`;
- `phase`;
- unknown options.

Nested objects are key-sorted before hashing and functions are omitted. Resume reuses the longest
unchanged sequential call prefix. Once one call misses, every later call executes live even if a
later historical key happens to exist. A `started` entry without a result respawns. `null` results
are not reusable cache entries.

Claude documents same-session resume. `workflow-mcp` may add durable cross-session caching, but it
must keep that state external and define stronger invalidation around side effects. A cached
read-only research result and a cached write-capable agent are not equally safe to replay.

## Local corpus findings

The user-level search found 16 workflow source copies representing 12 unique SHA-256 contents:

- two discoverable project/worktree files;
- eight persisted run-script copies;
- six installed official Anthropic plugin workflows.

Two duplication groups explain the difference:

- live `fat-bug-hunt.js` equals its persisted run script;
- three `code-review` run scripts are byte-identical;
- the worktree `render-layer-deep-dig.js` equals its persisted run script.

No personal `~/.claude/workflows` directory was present. No additional workflow sources were found
in the searched Development, Documents, Downloads, temporary, Trash, headless-package, Claude
Desktop application-support, or plugin-cache locations after excluding dependency/build trees.

### Unique local source hashes

| Workflow | SHA-256 |
| --- | --- |
| `extract-rules` | `4b755f1f075c933f9a58ad01e73447d967a852729e6784a486fb9b2fd3ef5c2e` |
| `harden-scan` | `55f4588c168e9cca2a487317bd8ed4f6f89ebcfa397fae3d2daad935a4c42115` |
| `portfolio-assess` | `43f714b9ab894f6cd207a34f12f004dbc3d6401eaf64582aa239837d50a3abba` |
| `reimagine-scaffold` | `71c5b839d4cfbbf003612a5c3fe6eefe8b30b9d4fccd88cd7b13b5e00e500236` |
| `uplift-deltas` | `ad1308cb25607e3e3e4c0f71bdcdeb9e0f6a26ae9a48eb5d46f73da54e71bc20` |
| `uplift-migrate` | `c8d61c9764c5afe21398ae68592b07d7c6ce478011cdf2558bbb4323513675ad` |
| `pr442-verify` | `e5b92383826ef2e8f6d40d0f2bed83c4a164b7db0f738d0f30581cdd7288db53` |
| `code-review` | `baf5f49eb76136edfc54f0aad29d1aaf676c13a6fa63d6501e49509b0dad435b` |
| `fat-bug-hunt` | `7228f59f19bfa9ebbdedbf4b717870b0047a5dc4209d31629bf1c62def71c4aa` |
| `pr442-fix` | `d0ce581c4044015d146f906bda154c27c454db4528ecf9093c948b58e6a825c0` |
| `render-layer-deep-dig` | `623e87ea912ee1edb96107fd2c77db1a32b8504d87ddc2fa4666fb1ffd21fcd3` |
| `deep-research` | `c64d40ac02008b5465b95af8fb3f8b8b74fbcb3d2d55ac703dec6b88b5c3cf47` |

### Distinct orchestration shapes

- `extract-rules`: loop until dry, token-budget admission, cross-round `Map` deduplication,
  verification, a two-judge priority panel, and a final structured DTO.
- `harden-scan` and `uplift-deltas`: category finders, deduplication, adversarial verification, and
  secondary severity confirmation.
- `portfolio-assess`: pipeline fan-out followed by deterministic JavaScript calculation and sort.
- `reimagine-scaffold`: write-capable agents assigned to disjoint directories.
- `uplift-migrate`: dependency-graph validation, escalating dependency-aware batches, a per-batch
  circuit breaker, feedback sharing, and blocked/failed/retryable units.
- `code-review`: string arguments, explicit phases, early exits, barriered find, group-by-location
  verification, conditional sweep, and synthesis.
- `fat-bug-hunt`: broad fan-out, agent-assisted deduplication, and nested adversarial voting.
- `deep-research`: multi-stage pipeline, URL deduplication, a global fetch cap, nested three-vote
  quorum, caught agent failures, null skips, and salvage returns.
- `pr442-verify`, `pr442-fix`, and `render-layer-deep-dig`: focused fan-out, synthesis, fixes, and
  explicit per-agent effort.

### Important evidence from real journals

The eight run records contained seven completed runs and one killed run. Persisted embedded source
matched the corresponding script bytes. Across the journals, 392 `started` records produced only
277 `result` records, including completed workflows with missing result records. Agent counts and
run completion cannot therefore be inferred from reusable cache entries alone.

## Public corpus and source quality

Public code search finds many apparent workflow files, but quantity is misleading. Copies,
unfinished examples, invalid formatting, and other runtimes' dialects frequently live under a
`.claude/workflows` path.

### Recommended positive references

- [Anthropic `pr-stamp-sweep.js`](https://github.com/anthropics/claude-code-action/blob/f1bd27ca5b54584506e40e17884d90bdaaa1a9b3/.claude/workflows/pr-stamp-sweep.js): official real-world
  structured arguments, validation, dynamic pipeline, conditional verification, logging, and
  aggregation.
- [TinyUSB `fanout-dev.js`](https://github.com/hathach/tinyusb/blob/ac595bc5cf64949332347a2b9d901de507a744a6/.claude/workflows/fanout-dev.js): string-or-object args,
  three-stage pipeline, custom agent type, xhigh effort, conditional worktree isolation, and null
  handling.
- [TinyUSB `validate.js`](https://github.com/hathach/tinyusb/blob/ac595bc5cf64949332347a2b9d901de507a744a6/.claude/workflows/validate.js): runtime-built thunk array,
  conditional stages, model, agent type, effort, schemas, and aggregation.
- [TinyUSB `full-check.js`](https://github.com/hathach/tinyusb/blob/ac595bc5cf64949332347a2b9d901de507a744a6/.claude/workflows/full-check.js): nested workflow composition.
- [Onion `onion-gap-probe.js`](https://github.com/onion-lang/onion/blob/d4f288365b7d0e6ab990c782eaf81968d6d6fd38/.claude/workflows/onion-gap-probe.js): non-English prompts,
  dynamic fan-out, token budget, inline schema, catch behavior, and logging.
- [Code.org `port-cucumber-to-playwright.js`](https://github.com/code-dot-org/code-dot-org/blob/bb113413b5e11d0e7a2b4dc9800421dac6f9e685/.claude/workflows/port-cucumber-to-playwright.js): six phases,
  multiple schemas, conditional execution, bounded repair loop, stress gates, and a final commit.
- [Salesforce `review-plan.js`](https://github.com/forcedotcom/salesforcedx-vscode/blob/61a5a945353c144566f7ac25220dabec4556b3a0/.claude/workflows/review-plan.js): sequential and parallel
  review, nullable schemas, custom agents, revision, and optional commit.
- [Microck Bun Rust port workflow](https://github.com/Microck/bun-rust-port-claude-artifacts/blob/1de61ae7e4d74513e8a1ec242293624ac4684eb7/.claude/workflows/phase-a-port.workflow.js): large archived source for
  scale, helper functions, implementation, verification, and conditional repair.

### Design references, not conformance authorities

- [Awesome Claude's workflow recipes](https://awesomeclaude.ai/claude-code-workflows) provide 24
  useful orchestration patterns, but they are embedded examples rather than proven checked-in
  sources.
- [Alexander Opalic's `ultra.js`](https://gist.github.com/alexanderop/b2493855e0052b89da3f6d962c5b0aa9)
  demonstrates nested reviewer panels and synthesis but depends on custom agents.
- A Red Hat `go-implement.js` reference was explicitly committed as an unfinished first part and
  should not become a correctness fixture.

### Negative and quarantined references

- The `pjt222/agent-almanac` workflow collection uses `.mjs` and claims direct discovery, but
  Claude Code `2.1.209` skips those files. They are useful near-miss fixtures only.
- One public workflow gist contains hard-wrapped newlines inside quoted strings and is
  syntax-invalid. It belongs in malformed-input tests, not the positive corpus.
- A `tournament.js` under `.claude/workflows` targets the Pi runtime and adds options such as
  `tools`, `skills`, `excludeTools`, and `basedOn`. A matching path does not prove Claude dialect
  compatibility.

## Approval, permissions, and side effects

Claude may ask for workflow-source approval before launch. Approval is invalidated when source
content changes. In unattended Agent SDK or print mode, there may be nobody available to answer a
permission request.

Workflow subagents run with edit acceptance but remain constrained by the outer session's tool
allowlist. Shell, web, and MCP operations outside the allowlist can pause for permission. There is
no ordinary mid-run workflow input beyond permission handling.

`workflow-mcp` must separate three decisions:

1. Is this workflow source trusted to execute as JavaScript?
2. Which agent capabilities may the workflow request?
3. Which filesystem, shell, network, and MCP operations may the selected provider perform?

The caller may request narrower limits but must never grant itself broader permissions than server
policy. Provider credentials remain inside the provider adapter and never enter the workflow VM.

## MCP architecture

MCP should be the interoperable control plane, not the internal execution model:

```text
MCP-capable host
      |
      v
workflow tools and resources
      |
      v
WorkflowService + durable event store
      |
      v
Claude-compatible JavaScript runtime
      |
      v
provider-neutral AgentProvider
      |-- Codex SDK
      |-- Claude adapter
      `-- future providers
```

This distinction prevents two forms of portability from being conflated:

1. any MCP-capable host can discover and control workflows;
2. any implemented provider can execute workflow agent nodes.

MCP solves the first. `AgentProvider` solves the second.

### Baseline MCP tools

The portable first contract should be:

```text
workflow_list
workflow_describe
workflow_validate
workflow_run
workflow_run_status
workflow_run_events
workflow_run_cancel
```

`workflow_run` should return a run handle immediately. It should accept a caller-generated
idempotency key so HTTP retries do not launch duplicate expensive runs. Caller limits are ceilings
intersected with server policy.

`workflow_run_events` should use durable cursor polling:

```json
{
  "runId": "run_...",
  "after": 142,
  "limit": 200,
  "waitMs": 20000
}
```

Agent Code may negotiate a custom live-notification extension for low-latency UI updates. Every
notification must carry the last durable cursor, and reconnecting clients must fill gaps through
`workflow_run_events`. Live delivery is an optimization; correctness never depends on it.

Do not add a separate WebSocket protocol initially.

### MCP resources

Recommended resource space:

```text
workflow://definitions/{workflowId}
workflow://runs/{runId}
workflow://runs/{runId}/artifacts/{artifactId}
```

Definition resources expose normalized Claude metadata plus runtime-owned sidecar metadata. Run
resources expose snapshots rather than entire histories. Large reports, patches, and transcripts
become artifacts referenced by tool results.

### MCP Tasks caution

MCP `2025-11-25` Tasks are experimental, and the published 2026 extension direction changes the
wire contract. Internal run state must not be modeled directly as either experimental Tasks
version. A negotiated Tasks adapter can map to the stable internal run model later.

## Durable event model

The event store is authoritative:

```ts
type WorkflowEvent = {
  schemaVersion: 1
  runId: string
  sequence: number
  eventId: string
  timestamp: string
  type: string
  phaseId?: string
  nodeId?: string
  agentId?: string
  parentId?: string
  payload: unknown
}
```

Initial event families:

```text
run.queued
run.started
run.completed
run.failed
run.cancellation_requested
run.cancelled

phase.started
phase.completed
phase.failed

agent.queued
agent.started
agent.output.delta
agent.completed
agent.failed

log
warning
artifact.created
```

Invariants:

- persist before publishing;
- monotonic sequence numbers per run;
- stable event IDs for deduplication;
- derive status as an event projection rather than maintaining unrelated truth;
- version payload unions;
- store large content as artifacts;
- coalesce provider token deltas into bounded event batches.

Provider event names must not leak into this contract. Codex and Claude streams are normalized by
their adapters.

## Provider adapter

The workflow engine should know only a provider-neutral interface:

```ts
interface AgentProvider {
  start(request: AgentRequest): Promise<AgentExecution>
  resume?(reference: ProviderSessionReference): Promise<AgentExecution>
}

interface AgentExecution {
  readonly sessionReference: ProviderSessionReference
  events(): AsyncIterable<AgentEvent>
  result(): Promise<AgentResult>
  cancel(): Promise<void>
}
```

Runtime scheduling, Claude-compatible cache identity, nested workflow behavior, and worktree
lifecycle belong above this interface. Provider model mapping, provider events, authentication,
and SDK lifecycle belong below it.

## Codex SDK findings

The official TypeScript `@openai/codex-sdk` is the natural first adapter for a Node package, but it
is not an in-process model runtime. As of 2026-07-14, the latest stable SDK is `0.144.4`. It depends
on the matching `@openai/codex` package, launches `codex exec --experimental-json` for every turn,
and exchanges JSONL over stdio. Using the SDK still matters: it gives us the supported typed
boundary and keeps CLI discovery, argument construction, JSONL parsing, and process cleanup out of
this project.

The public TypeScript surface maps cleanly onto most of one workflow `agent()` call:

| Workflow concern | Codex SDK surface | Adapter responsibility |
| --- | --- | --- |
| prompt | `thread.runStreamed(prompt)` | preserve Claude string-coercion behavior before the call |
| schema | `TurnOptions.outputSchema` | parse `finalResponse` as JSON and validate it independently |
| model | `ThreadOptions.model` | resolve provider-neutral/Claude aliases through configuration |
| effort | `ThreadOptions.modelReasoningEffort` | validate and map the observed effort values |
| cancellation | `TurnOptions.signal` | join the signal to workflow, timeout, and server cancellation |
| session identity | `thread.id` and `resumeThread(id)` | persist the ID before publishing resumable state |
| token usage | `turn.completed.usage` | charge the shared workflow budget once per completed turn |
| working directory | `ThreadOptions.workingDirectory` | choose the repository or runtime-created worktree |
| permissions | `sandboxMode`, `approvalPolicy`, network and extra-directory options | enforce server policy; never trust the workflow to broaden it |
| label and phase | no provider equivalent | keep these in workflow events and cache metadata |
| `agentType` | no direct SDK equivalent | resolve installed agent instructions before calling the provider |
| worktree isolation | no lifecycle API | create and clean the worktree above the provider adapter |

The SDK's public stream currently contains thread/turn lifecycle events and started, updated, or
completed items for agent messages, reasoning, commands, file changes, MCP calls, web searches,
todo lists, and errors. It does **not** currently expose token-by-token agent-message deltas in its
TypeScript `ThreadEvent` union. `agent.output.delta` therefore cannot be a Codex portability
requirement. The adapter can publish useful command/file/tool progress immediately, but must treat
the completed `agent_message` item as the first authoritative text result.

A local integration spike used SDK `0.144.4` with the installed Codex CLI `0.144.3` through
`codexPathOverride` and the existing ChatGPT login. It verified all of the following without a PTY
or private session-file parsing:

- a streamed read-only turn produced a thread ID, lifecycle events, usage, and the expected final
  response;
- JSON Schema output produced parseable conforming JSON while command start/completion events were
  delivered during the turn;
- aborting through `AbortSignal` while a command was active rejected with `AbortError`;
- the interrupted thread ID could immediately be passed to `resumeThread()` and completed a later
  turn successfully.

The basic adapter is consequently small. The production risk is fan-out, not API complexity. Each
TypeScript SDK turn starts a native Codex process, so a Claude-compatible parallel workflow may
start up to the runtime concurrency ceiling at once. The matching macOS arm64 Codex npm artifact
for `0.144.4` also reports an unpacked size of 311,570,619 bytes. We must benchmark process count,
memory, startup latency, and packaging before declaring high-fan-out execution ready.

The official Python `openai-codex` beta instead maintains one pinned `codex app-server` process and
uses stdio JSON-RPC. Its current high-level surface has stronger primitives for concurrent turn
routing, interrupt, steer, thread list/read/resume/fork, and authentication.

The phrase "use the Codex SDK, not the headless package" should therefore mean that this project
uses the supported SDK boundary instead of maintaining its own PTY/CLI parser. Neither public SDK
eliminates a native Codex subprocess.

The first implementation should use the TypeScript SDK behind `AgentProvider`, then benchmark:

- at least 20 parallel threads;
- process and memory cost;
- abort followed by resume;
- malformed or schema-invalid final output;
- server death during an active turn;
- isolated `CODEX_HOME` and credential boundaries.

If the per-turn process model is unsuitable, a Python `AsyncCodex` worker can replace the adapter
without changing workflow files or MCP tools.

Both SDKs accept an output schema but return the final structured response as text. The adapter
must parse and independently validate it. Completed provider items are authoritative; richer
provider progress is best-effort UI data rather than part of workflow correctness.

Default provider policy should be workspace-write with network disabled. Network access, extra
writable roots, and dangerous full access require explicit server policy. An unattended MCP server
must fail closed when approval cannot be delivered.

## JavaScript isolation and trust

Exact file compatibility favors V8/Node JavaScript semantics. QuickJS is attractive for sandboxing
but can introduce engine differences that violate the goal of running the same workflow file.

Claude itself uses Node `vm`, but Node explicitly documents that `vm` is not a security mechanism.
The practical first boundary is therefore:

```text
workflow source
    -> parser and metadata validation
    -> dedicated killable Node runner process
    -> restricted V8 context with Claude-compatible globals
    -> data-only RPC to the service/provider process
```

The runner receives no credentials and a minimal environment. It exposes no host objects beyond
carefully cloned capabilities. It has wall-clock, synchronous-execution, array, pending-call,
concurrency, memory, and process-lifetime limits.

For a local trusted repository, the subprocess plus explicit source approval matches the product's
initial threat model. A remotely exposed or multi-tenant server additionally needs a real OS
container or microVM boundary. Node `vm` must never be advertised as protection against malicious
workflow source.

## Persistence and process lifetime

A run does not belong to an MCP connection. Definitions, source hashes, runs, events, artifacts,
idempotency keys, provider session references, and authorization ownership need persistent state.

SQLite is sufficient initially and avoids inventing several partially durable files. A first MVP
may mark active runs `interrupted` after process death. Genuine continuation across Agent Code or
stdio-host shutdown requires either a supervised daemon or an independently hosted Streamable HTTP
service.

Do not claim durable/resumable MCP Tasks until active execution genuinely survives its transport
connection.

## Agent Code integration boundary

The standalone repository should eventually expose one public `WorkflowService` used by both its
CLI and Agent Code:

```text
workflow-mcp serve --stdio
workflow-mcp serve --http
workflow-mcp validate <file>
```

Agent Code can initially host the service through its existing loopback Streamable HTTP MCP host
and bridge durable events into renderer IPC. This avoids an additional packaged executable while
keeping the engine independent. Agent Code must import only documented public exports and never
reach into the submodule's internal files.

Expected future Agent Code touch points are `.gitmodules`, root dependency metadata, the main
process composition root, built-in MCP registration, shared IPC/event types, and a dedicated
renderer workflow feature. None of those integrations belong in this initial research seed.

## Intended standalone repository layout

```text
workflow-mcp/
├── README.md
├── SPEC.md
├── SECURITY.md
├── package.json
├── src/
│   ├── spec/
│   ├── discovery/
│   ├── runtime/
│   ├── runner/
│   ├── providers/
│   ├── events/
│   ├── store/
│   ├── mcp/
│   └── cli.ts
├── tests/
│   ├── fixtures/
│   ├── conformance/
│   └── integration/
└── references/
    ├── README.md
    └── raw/              # Ignored until provenance and sanitization review.
```

Keep it one package initially. A monorepo, distributed scheduler, plugin marketplace, multiple
databases, and custom transport would add architecture before conformance exists.

## Implementation sequence

### Phase 0: corpus and specification

1. Preserve raw local, official, and public evidence outside Git tracking.
2. Record source hashes, provenance, licenses, and expected positive/negative status.
3. Write a versioned `claude-code/2.1.209` compatibility profile.
4. Distill licensed/sanitized committed fixtures from the raw corpus.
5. Build a test matrix that separates documented, observed, and project-owned semantics.

### Phase 1: parser and fake-provider runtime

1. Implement discovery and exact metadata parsing.
2. Implement the restricted V8 runner boundary.
3. Implement `args`, `budget`, phase/log events, top-level await, and return.
4. Implement `agent`, `parallel`, and `pipeline` against a deterministic fake provider.
5. Verify limits, ordering, null behavior, and failure isolation.

### Phase 2: resume and composition

1. Implement the chained compatibility cache and longest-prefix resume behavior.
2. Implement nested workflow resolution with one-level nesting.
3. Implement worktree lifecycle and environment dependency validation.
4. Add cancellation and interrupted-run recovery.

### Phase 3: Codex provider

1. Implement the TypeScript Codex SDK adapter.
2. Normalize provider events.
3. Independently validate schema results.
4. Complete concurrency, abort/resume, crash, and credential-isolation spikes.

### Phase 4: MCP server

1. Implement definitions, run control, status, event cursor, cancellation, and resources.
2. Add stdio transport.
3. Add authenticated loopback Streamable HTTP.
4. Test disconnect/replay, duplicate idempotency keys, and authorization isolation.

### Phase 5: Agent Code

1. Create the standalone repository and replace this directory with a submodule.
2. Mount its public service in the Electron main process.
3. Bridge durable workflow events to the renderer.
4. Build workflow discovery, launch, phase/agent progress, logs, artifacts, and cancellation UI.

### Phase 6: additional providers and optional protocol adapters

1. Add Claude and other provider adapters without changing the file language.
2. Add negotiated MCP Tasks support only after its contract and lifecycle are stable.
3. Add live custom MCP notifications only as an optimization over the event cursor.

## Conformance matrix

The initial suite must cover more than happy-path example files.

### Parser and metadata

- BOM and comments before metadata;
- wrong first statement;
- `let`, `var`, multiple declarations, and non-object initializer;
- every accepted literal family;
- interpolation, spreads, sparse arrays, computed properties, methods, and forbidden keys;
- missing and empty required fields;
- malformed and partial phases;
- unknown metadata;
- 524,288-byte boundary;
- `.js` versus `.mjs`, `.cjs`, and `.ts`.

### Discovery

- personal, far-project, and near-project collisions;
- plugin and built-in collisions;
- normalized-name ordering;
- symlinks, unreadable files, oversized files, and near-miss extensions.

### Runtime realm

- every injected global and every intentionally absent Node/browser global;
- top-level await and return;
- time/random/import restrictions;
- timers and cancellation;
- string, object, array, null, and omitted args;
- unserializable and function final values;
- 30-second synchronous timeout.

### Agent

- prompt coercion and fallback labels;
- every public option independently;
- ignored unknown options;
- schema success, invalid schema, missing structured output, and validation retry exhaustion;
- API failure, user skip, null, synchronous throw, and asynchronous rejection;
- agent-type resolution;
- worktree isolation;
- concurrency and 1,000-call admission limits.

### Parallel

- empty, non-array, promise entries, sparse input, 4,096, and 4,097 entries;
- synchronous throw, rejection, null, and undefined;
- intentionally reversed completion order with stable result order;
- budget exhaustion and sibling continuation.

### Pipeline

- empty input, no stages, and invalid stages;
- exact callback arguments;
- null versus undefined;
- stage throw and rejection;
- proof of barrier-free progression;
- nested parallel stage;
- stable final order.

### Resume

- full cache hit;
- label-only and phase-only changes;
- changes to every hashed option;
- call insertion and deletion before and after cached calls;
- null result and started-only journal records;
- malformed and truncated journal;
- first-miss invalidation of every later entry.

### Nested workflows

- named and path resolution;
- discovery collisions;
- explicit and omitted child args;
- shared budget, cap, cancellation, and cache;
- repeated child phase numbering;
- child errors;
- attempted second-level nesting.

### MCP and durability

- idempotent run creation;
- cursor replay after disconnect;
- event persist-before-publish;
- cancellation races;
- process death and interrupted status;
- authorization separation between two clients;
- artifact access control;
- stdio shutdown behavior and HTTP reconnect.

## Known risks and open questions

- Claude's workflow API is new and can change between patch releases; compatibility must stay
  profile-based.
- Some useful behavior is observed from a closed implementation rather than documented.
- Exact JavaScript compatibility and strong untrusted-code isolation pull toward different engine
  choices; V8 compatibility wins locally, while remote service deployment needs an OS boundary.
- Provider outputs are nondeterministic. Differential tests must use deterministic fake providers
  for runtime semantics and reserve real-provider runs for integration behavior.
- Worktree side effects complicate caching and downstream visibility.
- Custom agent types and nested workflow names are environment dependencies that a single file
  cannot carry.
- The TypeScript Codex SDK's per-turn process cost may limit high-fan-out workflows.
- Neither public Codex SDK documents reattachment to a turn that was already active when the
  orchestrator died.
- Experimental MCP Tasks are not stable enough to define the internal run model.
- Raw corpus files may contain private prompts or credentials and remain ignored until reviewed.

## Primary sources

- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code directory structure](https://code.claude.com/docs/en/claude-directory)
- [Claude Code Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
- [Codex SDK documentation](https://developers.openai.com/codex/sdk)
- [Codex TypeScript SDK source](https://github.com/openai/codex/tree/main/sdk/typescript)
- [Codex app-server protocol](https://developers.openai.com/codex/app-server)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP lifecycle and capabilities](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [Node `vm` documentation](https://nodejs.org/api/vm.html)
