# The Workflow tool as the model sees it — a primary-source capture

## Provenance and fidelity

This document was written by the model itself (Claude, model id `claude-fable-5`) from inside a
live Claude Code CLI session on **2026-07-15**, on macOS (darwin), in the `agent-code` repository.
It transcribes and annotates the **in-context definition of the `Workflow` tool** — the tool
schema and long-form description that the Claude Code harness injects into the model's system
prompt. This is the *only* source of the model's knowledge about workflows: there is no separate
documentation the model reads, no filesystem probing, no runtime discovery. Everything below is
what the model "knows" when it decides to author and launch a workflow.

Fidelity notes, so future compatibility work can weigh this correctly:

- Sections marked **[verbatim-reconstructed]** reproduce the in-context text with near-verbatim
  wording and preserved ordering. Small transcription drift is possible; the structure, rules,
  numbers, and code examples are exact as seen.
- Sections marked **[model commentary]** are the model explaining what the text means in
  practice, or describing observable harness behavior around the tool (task notifications,
  permission dialogs, `/workflows`) that is *not* part of the tool description itself.
- The model sees the **contract**, not the implementation. Every runtime behavior below
  (caching, journal format, concurrency scheduling) is documented-as-promised, not verified
  against harness source. Where this repo's raw corpus (persisted runs, journals, transcripts
  under `references/raw/`) contradicts this document, the corpus wins — it is ground truth.

Related context also captured here because it shapes workflow behavior: the `Agent` tool
relationship, the subagent contract, ultracode mode, and how the harness surfaces workflow
lifecycle back to the model.

---

## 1. How the tool surfaces to the model

**[model commentary]**

The `Workflow` tool arrives exactly like `Bash` or `Read`: as one entry in the JSON-Schema tool
list at the top of the system prompt. Its entry has two parts:

1. A **`description`** field — an unusually long prose spec (several thousand words) that carries
   the entire programming model: script format, hooks, caps, doctrine, and worked examples.
2. A **`parameters`** JSON Schema — the tool-call inputs (`script`, `scriptPath`, `name`, `args`,
   `resumeFromRunId`, plus two ignored fields).

Some Claude Code sessions defer tool schemas and load them on demand via a `ToolSearch` tool; in
this session `Workflow` was loaded eagerly. Either way, once the schema is in context the model
can call it like any other tool.

The harness may also send mid-conversation `<system-reminder>` turns that change workflow
behavior — most importantly the ultracode on/off state (§9).

### 1.1 The parameter schema

**[verbatim-reconstructed]** — field-by-field, with the documented semantics:

| Field | Type | Semantics |
| --- | --- | --- |
| `script` | string, max **524288** chars | Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using `agent()`/`parallel()`/`pipeline()`/`phase()`. |
| `scriptPath` | string | Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke with the same `scriptPath` instead of re-sending the full script. **Takes precedence over `script` and `name`.** |
| `name` | string | Name of a predefined workflow (built-in or from `.claude/workflows/`). Resolves to a self-contained script. |
| `args` | any | Optional input value exposed to the script as the global `args`, verbatim. Arrays/objects must be passed as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Used to parameterize named workflows (e.g. a research question). |
| `resumeFromRunId` | string, pattern `^wf_[a-z0-9-]{6,}$` | Run ID of a prior Workflow invocation to resume from. Completed `agent()` calls with unchanged `(prompt, opts)` return their cached results instantly; only edited or new calls re-run. **Same-session only.** Stop the prior run first (`TaskStop`) before resuming. |
| `title` | string | **Ignored** — set the workflow title in the script's `meta` block. |
| `description` | string | **Ignored** — set the workflow description in the script's `meta` block. |

The existence of explicitly-ignored `title`/`description` parameters suggests the tool interface
evolved and kept backward-compatible fields; the `meta` block is the canonical source.

### 1.2 What the tool call returns and how the run reports back

**[model commentary]**

- The tool description opens with: workflows **run in the background** — the tool call returns
  immediately with a task ID, and a `<task-notification>` arrives when the workflow completes.
  Run IDs match `wf_[a-z0-9-]{6,}`.
- The tool result also includes the **persisted script path** under the session directory (this
  is the `scriptPath` handle for iteration and resume).
- The user (not the model) can watch live progress with the `/workflows` command.
- The model is told to use `TaskStop` (a general background-task tool) to stop a run before
  resuming it. Workflow runs participate in the same background-task lifecycle as other
  harness-tracked tasks (`TaskOutput`, `TaskStop`, task notifications).

---

## 2. What a workflow is, per the spec

**[verbatim-reconstructed]** — the framing paragraphs, condensed only slightly:

> Execute a workflow script that orchestrates multiple subagents deterministically.
>
> A workflow structures work across many agents — to be **comprehensive** (decompose and cover in
> parallel), to be **confident** (independent perspectives and adversarial checks before
> committing), or to take on **scale one context can't hold** (migrations, audits, broad sweeps).
> The script is where you encode that structure: what fans out, what verifies, what synthesizes.
>
> Use this tool for multi-step orchestration where control flow should be deterministic (loops,
> conditionals, fan-out) rather than model-driven.

The spec also names common single-phase workflow shapes the model can chain across turns:

- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

And a doctrine of staying in the loop: "For larger work, run several in sequence — read each
result before deciding the next phase. You stay in the loop; each workflow is one well-scoped
fan-out." The recommended approach is **hybrid**: scout inline first (list the files, find the
channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it —
"You don't need to know the shape before the *task* — only before the *orchestration step*."

---

## 3. The opt-in gate

**[verbatim-reconstructed]** — this is the most strongly-worded part of the spec:

> ONLY call this tool when the user has explicitly opted into multi-agent orchestration.
> Workflows can spawn dozens of agents and consume a large amount of tokens; the user must
> request that scale, not have it inferred. Explicit opt-in means one of:
>
> 1. The user included the keyword **"ultracode"** in their prompt (a system-reminder confirms it).
> 2. Ultracode is **on for the session** (a system-reminder confirms it) — see §9.
> 3. The user directly asked for a workflow or multi-agent orchestration **in their own words**
>    ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents").
>    The ask must be in the user's words — a task that would merely benefit from a workflow does
>    not count.
> 4. The user invoked a skill or slash command whose instructions tell the model to call Workflow.
> 5. The user asked to run a specific named or saved workflow.
>
> For any other task — even one that would clearly benefit from parallelism — do NOT call this
> tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent
> workflow could do and how much it would roughly cost, and ask the user whether to run it.
> Mention they can ask for one with "use a workflow" in a future message to skip the ask.

**[model commentary]** In this repo, gate #4 is live: the `fat-bug-hunt` and `ui-smoke` project
skills instruct the model to call Workflow, which makes invoking those skills an explicit opt-in.
The `meta.description` is described as "shown in the permission dialog", implying the user still
sees a permission prompt naming the workflow before it runs.

---

## 4. Script anatomy

### 4.1 The `meta` block

**[verbatim-reconstructed]**

Every script must begin with:

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

Rules:

- The `meta` object must be a **PURE LITERAL** — no variables, function calls, spreads, or
  template interpolation.
- Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list),
  `phases`.
- Use the **same phase titles** in `meta.phases` as in `phase()` calls — titles are matched
  exactly; a `phase()` call with no matching meta entry just gets its own progress group.
- Add `model` to a phase entry when that phase uses a specific model override.

### 4.2 Language environment

**[verbatim-reconstructed]**

- Scripts are **plain JavaScript, NOT TypeScript** — type annotations (`: string[]`), interfaces,
  and generics fail to parse.
- The script body runs in an **async context** — `await` is used directly at top level.
- Standard JS built-ins (JSON, Math, Array, …) are available — **EXCEPT** `Date.now()`,
  `Math.random()`, and argless `new Date()`, **which throw** (they would break resume). Pass
  timestamps in via `args`, stamp results after the workflow returns, and for randomness vary the
  agent prompt/label by index.
- **No filesystem or Node.js API access.**

**[model commentary]** The determinism ban is load-bearing for the resume/caching design (§7):
replaying the script must produce byte-identical `(prompt, opts)` pairs for the cache-prefix
matching to work. This is the single most important invariant for any compatible runtime.

---

## 5. The script-body API surface

**[verbatim-reconstructed]** — the complete hook list with documented signatures and semantics.

### 5.1 `agent(prompt, opts?) → Promise<any>`

Spawn a subagent.

- Without `schema`, returns the subagent's **final text as a string**.
- With `schema` (a JSON Schema), the subagent is **forced to call a StructuredOutput tool** and
  `agent()` returns the validated object — no parsing needed. Validation happens at the
  tool-call layer, so the model retries on mismatch.
- Returns **`null`** if the user skips the agent mid-run or the subagent dies on a terminal API
  error after retries — callers are told to `.filter(Boolean)`.

Options:

| Option | Semantics |
| --- | --- |
| `label` | Overrides the display label in the progress UI. |
| `phase` | Explicitly assigns this agent to a progress group. Recommended inside `pipeline()`/`parallel()` stages to avoid races on the global `phase()` state; same phase string → same group box. |
| `schema` | JSON Schema for structured output (see above). |
| `model` | Model override for this call. Doctrine: **default to omitting it** — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set when highly confident a different tier fits; when unsure, omit. |
| `effort` | Reasoning-effort override: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Omit to inherit the session effort; use `'low'` for cheap mechanical stages and higher tiers only for the hardest verify/judge stages. |
| `isolation: 'worktree'` | Runs the agent in a fresh git worktree — **EXPENSIVE** (~200–500 ms setup + disk per agent). Use ONLY when agents mutate files in parallel and would otherwise conflict. The worktree is auto-removed if unchanged. |
| `agentType` | Use a custom subagent type (e.g. `'general-purpose'`, `'code-reviewer'`) instead of the default workflow subagent — **resolved from the same registry as the Agent tool** (`.claude/agents/*.md` frontmatter or SDK-defined agents). Composes with `schema`: the custom agent's system prompt gets a StructuredOutput instruction appended. |

Subagent contract: subagents are told their **final text IS the return value** (not a
human-facing message), so they return raw data.

### 5.2 `pipeline(items, stage1, stage2, ...) → Promise<any[]>`

Run each item through all stages independently, **NO barrier between stages**. Item A can be in
stage 3 while item B is still in stage 1. This is the **DEFAULT** for multi-stage work.
Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage.

- Every stage callback receives `(prevResult, originalItem, index)` — later stages can label work
  without threading context through stage 1's return value.
- A stage that **throws** drops that item to `null` and skips its remaining stages.

### 5.3 `parallel(thunks) → Promise<any[]>`

Run tasks concurrently. This is a **BARRIER**: awaits all thunks before returning.

- A thunk that throws (or whose agent errors) resolves to `null` in the result array — **the call
  itself never rejects** — so `.filter(Boolean)` before using the results.
- Use ONLY when you genuinely need all results together.

### 5.4 `log(message)` and `phase(title)`

- `log` — emit a progress message to the user (shown as a narrator line above the progress tree).
- `phase` — start a new phase; subsequent `agent()` calls are grouped under this title in the
  progress display. (Global mutable state — hence the `opts.phase` escape hatch in §5.1.)

### 5.5 `args`

The value passed as the Workflow tool's `args` input, verbatim (`undefined` if not provided).

### 5.6 `budget`

`{ total: number|null, spent(): number, remaining(): number }` — the turn's token target from the
user's `"+500k"`-style directive.

- `budget.total` is `null` if no target was set.
- `budget.spent()` returns output tokens spent **this turn across the main loop and all
  workflows** — the pool is shared, not per-workflow.
- `budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no target.
- The target is a **HARD ceiling**, not advisory: once `spent()` reaches `total`, further
  `agent()` calls **throw**.
- Uses: dynamic loops (`while (budget.total && budget.remaining() > 50_000) { ... }`) or static
  scaling (`const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`).
- Loop guard doctrine: always guard on `budget.total` — with no target set, `remaining()` is
  `Infinity` and the loop would run straight to the 1000-agent cap.

### 5.7 `workflow(nameOrRef, args?) → Promise<any>`

Run another workflow inline as a sub-step and return whatever it returns.

- Pass a **name** to invoke a saved workflow (same registry as `{name: "..."}`), or
  **`{scriptPath}`** to run a script file written earlier.
- The child **shares** this run's concurrency cap, agent counter, abort signal, and token budget.
  Its agents appear under a `▸ name` group in `/workflows`; its tokens count toward
  `budget.spent()`.
- The `args` param becomes the child's `args` global.
- **Nesting is one level only**: `workflow()` inside a child throws.
- Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.

---

## 6. Caps and limits

**[verbatim-reconstructed]**

| Limit | Value |
| --- | --- |
| Concurrent `agent()` calls per workflow | **min(16, cpu cores − 2)** — excess calls queue and run as slots free up |
| Total agents per workflow lifetime | **1000** — "a runaway-loop backstop set far above any real workflow" |
| Items per single `pipeline()`/`parallel()` call | **4096** — exceeding it is an explicit error, not a silent truncation |
| Script length | **524288** chars (from the parameter schema) |

You can still pass 100 items to `parallel()`/`pipeline()` and they all complete; only ~10 run at
any moment.

**[model commentary]** Note the default host concurrency the spec implies (~10 on a typical
laptop) versus this repo's provider reality (e.g. `WORKFLOW_MCP_CONCURRENCY` and the
four-native-turn Codex default in the main README). The cap formula is a *harness* choice, not a
protocol requirement — but scripts in the wild are written assuming excess calls queue safely,
so a compatible runtime must queue rather than reject past the cap.

---

## 7. Resume, journal, and observability

**[verbatim-reconstructed]** — the "Resume" section of the spec:

> The tool result includes a `runId`. To resume after a pause, kill, or script edit, relaunch
> with `Workflow({scriptPath, resumeFromRunId})` — the **longest unchanged prefix of `agent()`
> calls** returns cached results instantly; the first edited/new call and everything after it
> runs live. Same script + same args → 100% cache hit.
>
> Before diagnosing why a completed workflow returned an empty or unexpected result, read
> `<transcriptDir>/journal.jsonl` — it records **each agent's actual return value**; do not
> assume cached results are non-empty.
>
> `Date.now()`/`Math.random()`/`new Date()` are unavailable in scripts (they would break this) —
> stamp results after the workflow returns, or pass timestamps via `args`.
>
> Fallback when no journal is available: read `agent-<id>.jsonl` files in the transcript
> directory and hand-author a continuation script.

**[model commentary]** Key artifacts a compatible runtime must produce, per this contract:

- a **run ID** (`wf_…`) returned at launch;
- a **persisted copy of the script** (returned path = the iteration/resume handle);
- a **transcript directory** containing `journal.jsonl` (per-`agent()`-call return values) and
  per-agent `agent-<id>.jsonl` transcripts;
- **prefix-cache resume** keyed on `(prompt, opts)` identity in call order, same-session scoped.

The raw corpus under `references/raw/local/claude-projects/.../workflows/` and
`.../subagents/workflows/` contains real examples of these artifacts as Claude Code actually
writes them (persisted scripts, run records, journals, and the 392 workflow-agent
transcript/metadata pairs mentioned in `references/README.md`).

---

## 8. Doctrine: pipeline vs. parallel

**[verbatim-reconstructed]** — the spec spends a lot of words on this; preserved because it
shapes every real-world script in the corpus:

> DEFAULT TO `pipeline()`. Only reach for a barrier when you genuinely need ALL prior-stage
> results together.
>
> A barrier is correct ONLY when stage N needs cross-item context from all of stage N−1:
> - Dedup/merge across the full result set before expensive downstream work
> - Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
> - Stage N's prompt references "the other findings" for comparison
>
> A barrier is NOT justified by:
> - "I need to flatten/map/filter first" — do it inside a pipeline stage:
>   `pipeline(items, stageA, r => transform([r]).flat(), stageB)`
> - "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠
>   synchronized stages.
> - "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the
>   fastest, a barrier wastes 2/3 of the fast finders' idle time.
>
> Smell test: if you wrote
> ```js
> const a = await parallel(...)
> const b = transform(a)        // flatten, map, filter — no cross-item dependency
> const c = await parallel(b.map(...))
> ```
> that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside
> a stage. When in doubt: pipeline.

### 8.1 Canonical worked examples

**[verbatim-reconstructed]** — the four examples embedded in the spec, exactly as the model sees
them (these are the templates most real scripts start from):

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its
review completes:

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

When a barrier IS correct — dedup across all findings before expensive verification:

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))
```

Loop-until-count pattern — accumulate to a target:

```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Loop-until-budget pattern — scale depth to the user's "+500k" directive:

```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
```

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel →
loop-until-dry):

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

### 8.2 Quality patterns

**[verbatim-reconstructed]** — "common shapes; pick by task and compose freely":

- **Adversarial verify**: spawn N independent skeptics per finding, each prompted to REFUTE.
  Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
  ```js
  const votes = await parallel(Array.from({length: 3}, () => () =>
    agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {schema: VERDICT})))
  const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
  ```
- **Perspective-diverse verify**: when a finding can fail in more than one way, give each
  verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N
  identical refuters — diversity catches failure modes redundancy can't.
- **Judge panel**: generate N independent attempts from different angles (e.g. MVP-first,
  risk-first, user-first), score with parallel judges, synthesize from the winner while grafting
  the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry**: for unknown-size discovery (bugs, issues, edge cases), keep spawning
  finders until K consecutive rounds return nothing new. Simple counters (`while count < N`)
  miss the tail.
- **Multi-modal sweep**: parallel agents each searching a different way (by-container,
  by-content, by-entity, by-time). Each is blind to what the others surface; useful when one
  search angle won't find everything.
- **Completeness critic**: a final agent that asks "what's missing — modality not run, claim
  unverified, source unread?" What it finds becomes the next round of work.
- **No silent caps**: if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was
  dropped — silent truncation reads as "covered everything" when it didn't.

Scaling doctrine: "Scale to what the user asked for. 'find any bugs' → a few finders,
single-vote verify. 'thoroughly audit this' or 'be comprehensive' → larger finder pool, 3–5 vote
adversarial pass, synthesis stage. When unsure, lean toward thoroughness for
research/review/audit requests and toward brevity for quick checks."

And: "These patterns aren't exhaustive — compose novel harnesses when the task calls for it
(tournament brackets, self-repair loops, staged escalation, whatever fits)."

---

## 9. Ultracode mode

**[verbatim-reconstructed]**

> When a system-reminder confirms ultracode is on, that opt-in is **standing**: author and run a
> workflow for every substantive task by default. The goal is the most exhaustive, correct answer
> you can produce — token cost is not a constraint. For multi-phase work (understand → design →
> implement → review), that often means several workflows in sequence — one per phase — so you
> stay in the loop between them. The quality patterns (adversarial verify, multi-modal sweep,
> completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward
> orchestrating with workflows and adversarially verifying your findings — unless the work is
> trivial or already verified. Solo only on conversational turns or trivial mechanical edits.
> When a reminder says ultracode is off, revert to the opt-in rule.

**[model commentary]** Mechanically: ultracode state is communicated to the model exclusively via
`<system-reminder>` turns (per-prompt keyword confirmation, or session-level on/off). The model
never infers it.

---

## 10. Subagents: what workflow agents are and can do

**[model commentary]** — assembled from the Workflow spec plus the `Agent` tool definition in the
same system prompt, since they share machinery:

- **Default workflow subagent**: an unnamed workflow-specific agent type. Its defining contract:
  it is told its final text IS the return value, so it emits raw data rather than prose for a
  human.
- **Custom agent types** (`opts.agentType`): resolved from the same registry as the `Agent` tool
  — `.claude/agents/*.md` frontmatter or SDK-defined agents. In this session the registry
  exposes: `claude` (catch-all, all tools), `claude-code-guide` (docs Q&A; Bash/Read/WebFetch/
  WebSearch), `Explore` (read-only search), `general-purpose` (all tools), `Plan` (architect,
  read-only), `statusline-setup` (Read/Edit). Each type's model, reasoning effort, and tool set
  come from its definition.
- **Model/effort inheritance**: workflow agents inherit the main-loop session model and effort
  unless overridden per-call (§5.1).
- **MCP access**: "Workflow agents can reach all session-connected MCP tools via ToolSearch —
  schemas load on demand per agent. Caveat: interactively-authenticated MCP servers (e.g.
  claude.ai) may be absent in headless/cron runs."
- **Failure/skip semantics**: a user can skip an individual agent mid-run from the UI; terminal
  API errors after retries also resolve that `agent()` call to `null`. The script keeps running.
- **Worktree isolation** (`isolation: 'worktree'`): per-agent fresh git worktree, ~200–500 ms +
  disk each, auto-removed if unchanged. The same option exists on the interactive `Agent` tool.

---

## 11. Named workflows, skills, and the surrounding ecosystem

**[model commentary]**

- **`.claude/workflows/`** is the project-level saved-workflow registry; built-ins also exist.
  `Workflow({name, args})` resolves either to a self-contained script. `meta.whenToUse` is shown
  in the workflow list.
- **Skills as carriers**: project skills (e.g. this repo's `fat-bug-hunt`, `ui-smoke`, and the
  built-in `deep-research`) embed workflow invocations; invoking the skill is the opt-in. This is
  the main distribution channel for reusable orchestration besides `.claude/workflows/`.
- **`/workflows`**: the user-facing live progress view (phases as group boxes, agents as rows,
  `log()` lines as narration, child workflows as `▸ name` groups).
- **Relationship to the `Agent` tool**: `Agent` is single-subagent, model-driven dispatch (with
  `run_in_background`, `SendMessage` continuation, and the same worktree isolation). `Workflow`
  is the deterministic-control-flow counterpart. The spec draws the line at explicit user opt-in,
  not at task size.
- **"ultrareview" / `/code-review ultra`**: session guidance describes a separate, user-triggered
  multi-agent **cloud** review product that the model explicitly cannot launch itself. It is
  adjacent branding, not the Workflow tool.

---

## 12. Compatibility checklist distilled for this repo

**[model commentary]** — the invariants a runtime must honor for the "copy the `.js` file into
`.claude/workflows/` and it just runs" promise, as derived from the contract above:

1. **Parse gate**: `export const meta` pure-literal prefix; plain JS body; async top level;
   reject TypeScript syntax.
2. **Globals**: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, `budget`, `workflow` —
   with the exact null-on-failure / never-reject / stage-drop semantics of §5. Scripts in the
   wild lean on `.filter(Boolean)` and on `parallel` never rejecting.
3. **Determinism**: throw on `Date.now()`, `Math.random()`, argless `new Date()`.
4. **Structured output**: `schema` ⇒ forced StructuredOutput tool call with validate-and-retry;
   the resolved value is the parsed object.
5. **Scheduling**: cap concurrent agents, queue (never reject) the excess; 1000-agent lifetime
   backstop; 4096-item fan-out cap as an explicit error.
6. **Budget**: shared turn-level pool; hard-throw past the ceiling; `Infinity` when unset.
7. **Persistence**: run ID (`wf_…`), persisted script, `journal.jsonl` of per-call return values,
   per-agent transcripts.
8. **Resume**: longest-unchanged-prefix cache on ordered `(prompt, opts)`; edited call and
   everything after runs live.
9. **Child workflows**: one nesting level, shared cap/counter/abort/budget.
10. **Pure-literal `meta`** as the only trusted metadata channel (`title`/`description` tool
    params are ignored upstream).

Where this document and the raw corpus disagree, trust the corpus; where both are silent, the
harness behavior is unspecified and a compatible runtime may choose (and should document the
choice in `EXECUTION_PLAN.md`).
