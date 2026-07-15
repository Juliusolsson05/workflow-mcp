# The Claude Code `Workflow` tool, as seen from inside the model

## Provenance — read this first

This document is a first-person transcription of the `Workflow` tool as it is presented to the
model inside a real Claude Code session. It was written on **2026-07-15** by the model itself
(`claude-fable-5`) running in the Claude Code CLI, at the request of the repository owner, by
introspecting the tool definition injected into its own system prompt.

Why this document exists: workflow-mcp's compatibility promise is that a workflow file authored
here runs unmodified under Claude Code, and vice versa. The single most authoritative
specification of what Claude Code's runtime accepts is **the tool description Claude Code hands
its own model** — that text is the contract the authoring model is trained/instructed against,
and every `.claude/workflows/*.js` file in the raw corpus was written by a model reading exactly
this spec. The spec is not published anywhere else. Capturing it verbatim-in-substance, with the
model's own operational annotations, gives future sessions a stable reference that does not
require re-running a live Claude Code session to re-derive.

Epistemic labeling used throughout:

- **[SPEC]** — restates the injected tool description. Faithful in substance and, where quoted
  or shown as code, verbatim. This is the compatibility-critical material.
- **[OBSERVED]** — behavior the model has seen across sessions (permission dialogs, progress UI,
  notifications). Reliable but not normative.
- **[INFERENCE]** — the model's reading between the lines. Explicitly not a source of truth;
  verify against the raw corpus (persisted runs, journals, transcripts) before relying on it.

Versioning caveat: tool descriptions ship with the harness and change between Claude Code
releases without any changelog visible to the model. Treat this as a snapshot of the harness
installed on this machine on 2026-07-15. When the raw corpus and this document disagree, the
corpus (actual persisted artifacts) wins for on-disk formats; this document wins for authoring
semantics.

---

## 1. How the capability is delivered to the model

**[SPEC/OBSERVED]** There is no discovery step. The `Workflow` tool arrives exactly like `Bash`
or `Read`: a JSON-Schema tool definition plus a long natural-language description, injected into
the system prompt at session start. Everything the model knows about workflows — the script
format, every hook, the concurrency caps, the design doctrine, even the quality patterns it
tends to reproduce in generated scripts — comes from that one description. The model never
probes the filesystem to learn what a workflow is.

**[INFERENCE]** This is why generated workflow scripts across unrelated projects look so
stylistically similar (same `meta` shape, same `pipeline`-first structure, same
adversarial-verify idiom): they are all downstream of one prompt text. If workflow-mcp wants
Codex or other providers to author compatible files, the highest-leverage move is to hand those
providers a system-prompt excerpt equivalent to this document's §4–§8.

### 1.1 Tool input schema

**[SPEC]** The `Workflow` tool's input schema, reproduced field-for-field:

| Field | Type | Semantics |
| --- | --- | --- |
| `script` | string, max **524,288 chars** | Self-contained workflow script passed inline. Must begin with the `meta` export (§4). |
| `scriptPath` | string | Path to a script file on disk. **Takes precedence over `script` and `name`.** |
| `name` | string | Name of a predefined workflow — "built-in or from `.claude/workflows/`". Resolves to a self-contained script. |
| `args` | any JSON value | Exposed verbatim to the script as the global `args`. The spec explicitly warns: pass arrays/objects as real JSON values, **not** JSON-encoded strings — a stringified list reaches the script as one string and `args.filter`/`args.map` throw. |
| `resumeFromRunId` | string, pattern `^wf_[a-z0-9-]{6,}$` | Resume a prior run (§10). Same-session only; the prior run must be stopped first. |
| `description` | string | **Ignored.** The schema says so explicitly: "Ignored — set the workflow description in the script's `meta` block." |
| `title` | string | **Ignored**, same note pointing at `meta`. |

**[INFERENCE]** The vestigial `description`/`title` parameters strongly suggest an earlier
harness revision took metadata as tool arguments before `meta` became the source of truth.
Compatibility work should treat `meta` as authoritative and never depend on call-site metadata.

**[SPEC]** Run identifiers follow `wf_[a-z0-9-]{6,}`. The tool result returned to the model
includes the `runId` and the path where the script was persisted (§9.1).

---

## 2. The permission gate: when the model may start a workflow

**[SPEC]** The description is unusually forceful about opt-in. The model may call `Workflow`
**only** when one of these holds:

1. The user's prompt contains the keyword **`ultracode`** (the harness confirms via a
   system-reminder), or ultracode is toggled on for the session (also confirmed by reminder).
2. The user asked for orchestration **in their own words** — the spec gives examples: "use a
   workflow", "run a workflow", "fan out agents", "orchestrate this with subagents". The spec
   stresses the ask must be in the user's words; "a task that would merely benefit from a
   workflow does not count."
3. A skill or slash command the user invoked instructs the model to call `Workflow`.
4. The user asked to run a specific named or saved workflow.

For anything else — "even a task that would clearly benefit from parallelism" — the model is
told to use the single `Agent` tool, or to *describe* what a workflow could do, estimate rough
cost, and ask; and to mention the user can say "use a workflow" next time to skip the ask.

**[SPEC]** The stated rationale: "Workflows can spawn dozens of agents and consume a large
amount of tokens; the user must request that scale, not have it inferred."

### 2.1 Ultracode as a standing mode

**[SPEC]** When a system-reminder says ultracode is ON, the opt-in becomes standing: the model
should author and run a workflow for **every substantive task by default**, aiming for the most
exhaustive correct answer with token cost explicitly declared a non-constraint. Multi-phase work
(understand → design → implement → review) is expected to become several workflows in sequence,
with the model staying in the loop between phases. Solo (non-workflow) work is reserved for
conversational turns and trivial mechanical edits. A reminder saying ultracode is OFF reverts to
the opt-in rule above.

**[OBSERVED]** Launching a workflow surfaces a permission dialog to the user showing
`meta.description`; the run then appears in the `/workflows` live view.

**[INFERENCE for workflow-mcp]** The gate is a *harness/model policy*, not a runtime property.
Nothing in the file format encodes authorization. A standalone runtime can and should treat
authorization as its own concern (MCP client consent, CLI invocation being inherently explicit)
without expecting any opt-in marker inside portable `.js` files.

---

## 3. Execution model

**[SPEC]** Workflows run **in the background**. The tool call returns immediately with a task
ID; a `<task-notification>` block arrives in the model's context when the workflow completes.
The user can watch live progress with the `/workflows` command.

**[SPEC]** The recommended authoring flow is explicitly **hybrid**: scout inline first with
cheap tools (list files, find channels, scope the diff) to discover the work-list, *then* call
`Workflow` to pipeline over it. Quote-in-substance: "You don't need to know the shape before the
task — only before the orchestration step."

**[SPEC]** Common single-phase workflow shapes the spec names, intended to be chained across
turns with the model reading each result before deciding the next phase:

- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

**[SPEC]** The tool is positioned for "multi-step orchestration where control flow should be
deterministic (loops, conditionals, fan-out) rather than model-driven" — the script, not
turn-by-turn model decisions, owns the control flow.

---

## 4. Script format: the `meta` block

**[SPEC]** Every script must begin with:

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
  phases: [                                            // one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
```

Rules, all stated explicitly in the spec:

- `meta` must be a **PURE LITERAL** — "no variables, function calls, spreads, or template
  interpolation." **[INFERENCE]** This exists so the harness can extract metadata by static
  parse, without executing the script — extraction happens before the permission dialog, i.e.
  before the user has consented to run anything.
- Required fields: `name`, `description`.
- Optional fields: `whenToUse` (shown in the workflow list), `phases`.
- `phases[].title` is matched **exactly** against `phase()` calls in the body. A `phase()` call
  with no matching meta entry "just gets its own progress group" — a soft fallback, not an
  error.
- A phase entry may carry `model` "when that phase uses a specific model override"
  **[INFERENCE]** — this appears to be display/estimation metadata only; the actual override is
  the `model` option on each `agent()` call.

---

## 5. Script language and sandbox

**[SPEC]** The body is **plain JavaScript, NOT TypeScript** — "type annotations (`: string[]`),
interfaces, and generics fail to parse." It runs in an **async context**: top-level `await` is
used directly, no wrapper function.

**[SPEC]** Available: standard JS built-ins (`JSON`, `Math`, `Array`, …). **Not** available:
filesystem access and Node.js APIs — none, at all. The script is pure orchestration; all real
work happens inside subagents, which have the full tool surface.

**[SPEC]** Deterministically banned — these **throw** when called:

- `Date.now()`
- `Math.random()`
- zero-argument `new Date()`

The spec gives the reason in-line: "they would break resume" (§10). Prescribed workarounds:
pass timestamps in via `args`; stamp results after the workflow returns; for randomness, vary
the agent prompt or label by index.

**[INFERENCE for workflow-mcp]** This is the tightest compatibility constraint in the whole
spec. A conforming runtime must (a) reject or stub these calls identically, or (b) accept that
real-world corpus files simply never call them — the authoring model was told they throw, so it
routes around them. Matching the throw is safer: a file that *does* call `Date.now()` should
fail the same way in both runtimes rather than silently diverge on replay.

---

## 6. The script API surface

Six globals. This section restates each signature and every documented behavior.

### 6.1 `agent(prompt, opts?) → Promise<any>`

**[SPEC]** Spawns a subagent.

Return value:

- Without `schema`: the subagent's **final text as a string**.
- With `schema` (a JSON Schema object): the subagent is **forced to call a `StructuredOutput`
  tool**, and `agent()` returns the validated object — "no parsing needed." Validation happens
  "at the tool-call layer so the model retries on mismatch" — i.e. schema violations bounce back
  to the *subagent* to retry, invisible to the workflow script.
- Returns **`null`** in exactly two cases: the user skips the agent mid-run, or the subagent
  dies on a terminal API error after retries. The spec's standing advice: `.filter(Boolean)`.

Options object, field by field:

| Option | Documented semantics |
| --- | --- |
| `label` | Overrides the display label in the progress UI. |
| `phase` | Explicitly assigns the agent to a progress group. The spec says to use this inside `pipeline()`/`parallel()` stages "to avoid races on the global `phase()` state — same phase string → same group box." |
| `schema` | JSON Schema forcing structured output, as above. |
| `model` | Per-agent model override. The spec's default guidance is emphatic: **omit it** — "the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit." |
| `effort` | Reasoning-effort override: `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`. Omit to inherit the session effort. Guidance: `'low'` for cheap mechanical stages; higher tiers only for the hardest verify/judge stages. |
| `isolation: 'worktree'` | Runs the agent in a fresh git worktree. Flagged **EXPENSIVE** — "~200–500 ms setup + disk per agent" — and to be used **only** when agents mutate files in parallel and would otherwise conflict. The worktree is auto-removed if unchanged. |
| `agentType` | Use a custom subagent type (e.g. `'general-purpose'`, `'code-reviewer'`) instead of the default workflow subagent. Resolved "from the same registry as the Agent tool" (`.claude/agents/*.md` frontmatter or SDK-registered agents). Composes with `schema`: "the custom agent's system prompt gets a StructuredOutput instruction appended." |

**[SPEC]** The subagent-side contract: workflow subagents "are told their final text IS the
return value (not a human-facing message), so they return raw data." This prompt-level framing
is why journaled return values in the corpus look like data dumps rather than chat prose.

**[SPEC]** Tool access inside workflow subagents: they "can reach all session-connected MCP
tools via ToolSearch — schemas load on demand per agent." Caveat, verbatim in substance:
"interactively-authenticated MCP servers (e.g. claude.ai) may be absent in headless/cron runs."

### 6.2 `pipeline(items, stage1, stage2, ...) → Promise<any[]>`

**[SPEC]** Runs each item through all stages independently with **NO barrier between stages**:
"Item A can be in stage 3 while item B is still in stage 1." Declared "the DEFAULT for
multi-stage work." Wall-clock is "slowest single-item chain, not sum-of-slowest-per-stage."

- Every stage callback receives `(prevResult, originalItem, index)` — the spec calls out using
  `originalItem`/`index` in later stages "to label work without threading context through stage
  1's return value."
- Error semantics: "A stage that throws drops that item to `null` and skips its remaining
  stages." The other items are unaffected.

### 6.3 `parallel(thunks) → Promise<any[]>`

**[SPEC]** Takes an array of zero-arg async functions, runs them concurrently, and is a
**BARRIER**: awaits all before returning.

- Error semantics: a thunk that throws (or whose agent errors) resolves to `null` in the result
  array — "the call itself never rejects." Hence `.filter(Boolean)` before use.
- Usage doctrine: "Use ONLY when you genuinely need all results together." (§8 for the full
  barrier doctrine.)

### 6.4 `phase(title)` and `log(message)`

**[SPEC]** `phase(title)` starts a new phase; subsequent `agent()` calls group under that title
in the progress display. It is global mutable state — the reason per-agent `opts.phase` exists
for concurrent stages. `log(message)` emits "a progress message to the user (shown as a narrator
line above the progress tree)."

### 6.5 `args`

**[SPEC]** The `args` tool-call input, verbatim, `undefined` if not provided. Named use case:
"parameterize named workflows — e.g. pass a research question, target path, or config object
directly instead of via a side-channel file."

### 6.6 `budget`

**[SPEC]** Shape: `{ total: number|null, spent(): number, remaining(): number }`, tied to the
user's `"+500k"`-style token directive for the turn.

- `total` is `null` when no target was set.
- `spent()` counts output tokens "this turn across the main loop and all workflows — the pool is
  shared, not per-workflow."
- `remaining()` is `max(0, total - spent())`, or `Infinity` with no target.
- The target is a **hard ceiling, not advisory**: "once `spent()` reaches `total`, further
  `agent()` calls throw."
- Two prescribed idioms: dynamic loops
  (`while (budget.total && budget.remaining() > 50_000) { ... }`) and static scaling
  (`const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`).
- Critical guard, spelled out in the spec: always condition loops on `budget.total` — with no
  target, `remaining()` is `Infinity` and an unguarded loop "would run straight to the
  1000-agent cap."

### 6.7 `workflow(nameOrRef, args?) → Promise<any>`

**[SPEC]** Runs another workflow inline as a sub-step and returns whatever it returns.

- `nameOrRef` is either a name (resolved from "the same registry as `{name: "..."}`" — built-ins
  plus `.claude/workflows/`) or `{scriptPath}` for a script file written earlier.
- The child **shares** the parent's concurrency cap, agent counter, abort signal, and token
  budget. Its agents appear "under a `▸ name` group in /workflows" and its tokens count toward
  `budget.spent()`.
- The `args` parameter becomes the child's `args` global.
- **Nesting is one level only**: `workflow()` inside a child throws.
- Throws on unknown name, unreadable `scriptPath`, or child syntax error — the spec says to
  catch if graceful handling is wanted.

---

## 7. Hard limits

**[SPEC]** All numeric limits stated in the description:

| Limit | Value | Notes from the spec |
| --- | --- | --- |
| Concurrent `agent()` calls per workflow | `min(16, cpu cores − 2)` | Excess calls queue and run as slots free. 100 items to `pipeline`/`parallel` all complete; only ~10 run at any moment. |
| Lifetime agent count per workflow | **1000** | "A runaway-loop backstop set far above any real workflow." |
| Items per single `pipeline()`/`parallel()` call | **4096** | "Passing more is an explicit error, not a silent truncation." |
| Inline `script` length | **524,288 chars** | From the tool input schema. |
| `resumeFromRunId` format | `^wf_[a-z0-9-]{6,}$` | From the tool input schema. |

**[INFERENCE]** The core-count-derived concurrency default is the harness protecting the local
machine (every subagent is a real process tree with tool execution), not an API rate concern.
workflow-mcp's own default (`WORKFLOW_MCP_CONCURRENCY`, default four native turns per this
repo's README) is more conservative because a provider turn is the scarce resource there; both
choices are runtime policy, not file-format semantics, and portable files must not depend on
either value.

---

## 8. The design doctrine baked into the spec

This section matters for corpus interpretation: these rules explain *why* real workflow files
look the way they do.

### 8.1 Pipeline-by-default; barriers need justification

**[SPEC]** "DEFAULT TO pipeline(). Only reach for a barrier … when you genuinely need ALL
prior-stage results together." A barrier is **correct** only when stage N needs cross-item
context from all of stage N−1:

- dedup/merge across the full result set before expensive downstream work;
- early-exit when the total count is zero ("0 bugs found → skip verification entirely");
- stage N's prompt references "the other findings" for comparison.

A barrier is **NOT** justified by: "I need to flatten/map/filter first" (do it inside a pipeline
stage), "the stages are conceptually separate," or "it's cleaner code." The spec includes a
smell test — if the script reads

```js
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter — no cross-item dependency
const c = await parallel(b.map(...))
```

the middle transform doesn't need the barrier; rewrite as a pipeline with the transform inside a
stage. "When in doubt: pipeline." Quantified rationale: "if 5 finders run and the slowest takes
3× the fastest, a barrier wastes 2/3 of the fast finders' idle time."

### 8.2 Canonical example — multi-stage review (verbatim from the spec)

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
// Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.
```

Note the shape: `return` at top level returns the workflow's result; nested `parallel` inside a
pipeline stage is fine (the barrier is per-item, not cross-item).

### 8.3 Canonical example — justified barrier (verbatim)

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))
```

### 8.4 Loop patterns (verbatim)

Loop-until-count:

```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Loop-until-budget (with the mandatory `budget.total` guard):

```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
```

### 8.5 Composed example — exhaustive review, loop-until-dry (verbatim)

```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {                                              // loop-until-dry
  const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
    agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
    parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
// dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.
```

### 8.6 Named quality patterns

**[SPEC]** The description enumerates these as composable shapes, "pick by task and compose
freely":

- **Adversarial verify** — N independent skeptics per finding, each prompted to REFUTE
  ("Default to refuted=true if uncertain."); kill the finding if a majority refute. Purpose:
  "prevents plausible-but-wrong findings from surviving."
- **Perspective-diverse verify** — when a finding can fail in more than one way, give each
  verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N
  identical refuters — "diversity catches failure modes redundancy can't."
- **Judge panel** — N independent attempts from different angles (MVP-first, risk-first,
  user-first), parallel judges score them, synthesize from the winner "while grafting the best
  ideas from runners-up." "Beats one-attempt-iterated when the solution space is wide."
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive
  rounds return nothing new. "Simple counters (while count < N) miss the tail."
- **Multi-modal sweep** — parallel agents each searching a different way (by-container,
  by-content, by-entity, by-time), each blind to the others.
- **Completeness critic** — a final agent asking "what's missing — modality not run, claim
  unverified, source unread?" whose findings become the next round of work.
- **No silent caps** — "if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what
  was dropped — silent truncation reads as 'covered everything' when it didn't."

**[SPEC]** Scaling guidance: "find any bugs" → a few finders, single-vote verify; "thoroughly
audit this" / "be comprehensive" → larger finder pool, 3–5-vote adversarial pass, synthesis
stage. Lean thorough for research/review/audit, brief for quick checks. And the patterns "aren't
exhaustive — compose novel harnesses when the task calls for it (tournament brackets,
self-repair loops, staged escalation, whatever fits)."

---

## 9. Persistence, iteration, and observability

### 9.1 Script persistence

**[SPEC]** The model is told to pass scripts inline via `script`, **not** to Write them to a
file first — because "every invocation automatically persists its script to a file under the
session directory and returns the path in the tool result." Iteration flow: edit that persisted
file with Write/Edit, re-invoke with `{scriptPath: "<path>"}` instead of resending the script.

**[INFERENCE]** This round-trip (author inline → harness persists → edit on disk → re-run by
path) is the origin of the persisted-script copies in `references/raw/local/claude-projects/`.

### 9.2 Journal and transcripts

**[SPEC]** Each run has a transcript directory containing:

- `journal.jsonl` — "records each agent's actual return value." The spec instructs the model,
  before diagnosing an empty/unexpected workflow result, to Read the journal rather than assume
  cached results are non-empty.
- `agent-<id>.jsonl` — per-subagent transcript files, named as the fallback when no journal is
  available: "Read agent-<id>.jsonl files in the transcript directory and hand-author a
  continuation script."

**[OBSERVED]** The tool result and task-notification give the model the transcript directory
path; the model reads the journal with the ordinary `Read` tool. The journal is *data the model
consumes*, not something it writes.

### 9.3 Live progress

**[OBSERVED]** `/workflows` shows a live progress tree: phase group boxes (titled from
`phase()` / `opts.phase`, matched against `meta.phases`), one line per agent (labeled from
`opts.label` or a derived default), and narrator lines from `log()` above the tree. Child
workflows launched via `workflow()` render as a collapsed `▸ name` group **[SPEC]**.

---

## 10. Resume semantics

**[SPEC]** Complete restatement, since this is the part workflow-mcp's linked-resume feature
must interoperate with:

- Invocation: `Workflow({scriptPath, resumeFromRunId})` after a pause, kill, or script edit. The
  prior run must be stopped first (via `TaskStop`). Same-session only.
- Semantics: "the longest unchanged prefix of `agent()` calls returns cached results instantly;
  the first edited/new call and everything after it runs live."
- Cache key: the pair "(prompt, opts)" per `agent()` call, positional in execution order —
  "Completed agent() calls with unchanged (prompt, opts) return their cached results instantly."
- Guarantee: "Same script + same args → 100% cache hit."
- This is the stated reason for the §5 nondeterminism bans: `Date.now()`/`Math.random()`/argless
  `new Date()` "are unavailable in scripts (they would break this)."

**[INFERENCE]** "Longest unchanged prefix" implies replay is sequential over the recorded call
log: the runtime re-executes the script, serving each `agent()` call from the journal as long as
the observed (prompt, opts) matches the recorded one at that position, and switching to live
execution at the first mismatch — everything after runs live even if later calls would match.
This makes the journal a deterministic-replay log, not a memo-cache keyed by content alone.
Verify against the corpus journals before hard-coding this in the resume implementation; the
v2-journal work in this repo is the ground truth for the on-disk shape.

---

## 11. Relationship to the rest of the harness

Context that isn't part of the `Workflow` description itself but bounds it:

- **`Agent` tool** **[SPEC]** — the single-subagent primitive. Runs in the background by
  default, supports `SendMessage` continuation of a previously spawned agent (workflow subagents
  have no such continuation channel), and per-call `isolation: 'worktree'` / `model` overrides.
  Workflow's `agentType` resolves from the same registry the `Agent` tool uses: agent types are
  listed in system-reminders and defined in `.claude/agents/*.md` frontmatter (or SDK `agents`).
  In this session the registry contains: `claude`, `claude-code-guide`, `Explore`, `Plan`,
  `general-purpose`, `statusline-setup`.
- **Skills as launch vector** **[OBSERVED]** — a skill's markdown can instruct the model to call
  `Workflow` (this satisfies opt-in rule 3 in §2). In this repository, `fat-bug-hunt` and
  `ui-smoke` are exactly that: user-invocable skills whose bodies drive `Workflow` calls.
- **Named workflow registry** **[SPEC]** — `{name}` and `workflow(name)` resolve from
  "built-in or from `.claude/workflows/`". The model cannot see the built-in list; project
  workflows are ordinary `.js` files in `.claude/workflows/`. **[INFERENCE]** Resolution order
  and whether a personal (`~/.claude/workflows/`) tier exists are not stated in the spec;
  workflow-mcp's find/list behavior should be validated against Claude Code's actual behavior,
  not this document.
- **Ultracode reminders** **[OBSERVED]** — system-reminder turns toggle the §2.1 standing mode;
  they are harness-controlled and arrive mid-conversation.

---

## 12. What the model explicitly cannot see

Enumerated so nobody mistakes this document for a runtime spec:

- **Scheduler internals** — how queued agents are prioritized, retry counts/backoff for the
  "terminal API error after retries" → `null` path, or how the abort signal propagates.
- **On-disk formats** — the journal line schema, run-record schema, and persisted-script wrapper
  format. Only the *names* (`journal.jsonl`, `agent-<id>.jsonl`) and *purpose* are in the spec.
  The raw corpus in `references/raw/local/claude-projects/` is the ground truth here.
- **The sandbox mechanism** — whether scripts run in an isolated interpreter, a worker, or a
  rewritten AST. Only the observable restrictions (§5) are specified.
- **Token accounting** — how `budget.spent()` is measured (which token classes, whose usage).
  Only "output tokens … across the main loop and all workflows" is stated.
- **The built-in workflow list** — referenced but never enumerated.
- **Version identity** — the tool description carries no version string. Diffing future
  snapshots of this document against harness releases is the only change-tracking available.

---

## 13. Compatibility checklist distilled for workflow-mcp

The portable-file contract, reduced to testable assertions. Each traces to a [SPEC] section
above:

1. File begins with `export const meta = {...}` as a pure literal; `name` + `description`
   required; `whenToUse`, `phases[{title, detail, model?}]` optional. (§4)
2. Body is plain JS, top-level await allowed, no TS syntax. (§5)
3. No fs/Node APIs; `Date.now()`, `Math.random()`, argless `new Date()` throw. (§5)
4. Globals provided: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, `budget`,
   `workflow`. (§6)
5. `agent()` returns string (no schema) / validated object (schema) / `null` (skip or terminal
   failure); never rejects for those two null cases. Opts: `label`, `phase`, `schema`, `model`,
   `effort` (5-tier enum), `isolation: 'worktree'`, `agentType`. (§6.1)
6. `pipeline` stages get `(prev, originalItem, index)`; a throwing stage nulls that item and
   skips its remaining stages; no cross-item barrier. (§6.2)
7. `parallel` is a barrier; per-thunk failure → `null` in results; the call never rejects. (§6.3)
8. `budget.total` null without a directive; `remaining()` then `Infinity`; ceiling enforcement
   makes `agent()` throw once exhausted. (§6.6)
9. `workflow()` nests exactly one level; shares cap/counter/abort/budget; throws on unknown
   name/unreadable path/child syntax error. (§6.7)
10. Limits: per-run concurrency policy (harness: `min(16, cores−2)`), 1000-agent lifetime cap,
    4096-item per-call cap (explicit error), 512 KiB script max. Portable files must not depend
    on the concurrency value. (§7)
11. Top-level `return` yields the workflow result. (§8.2)
12. Resume = longest-unchanged-prefix replay keyed on per-call (prompt, opts); same script +
    same args must be a total cache hit. (§10)
