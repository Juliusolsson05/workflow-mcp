# Claude Run-ID Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue real Claude Workflow runs from their native `wf_*` identifiers through either Workflow MCP resume entry point.

**Architecture:** Add bounded, project-scoped Claude metadata discovery beside the existing importer. Route external `wf_*` identifiers through that discovery and the existing validation pipeline while leaving native `run_*` recovery unchanged.

**Tech Stack:** TypeScript 7, Node.js filesystem promises, MCP SDK, Zod, Vitest.

## Global Constraints

- Claude metadata and journals remain read-only.
- Run discovery must remain confined to the current MCP project's Claude project directory.
- Existing source-hash, workflow-name, journal-size, and journal-record validation must remain authoritative.
- Production behavior defaults to `~/.claude/projects`; tests use an injected projects root.

---

### Task 1: Discover Claude metadata by run ID

**Files:**
- Modify: `src/claudeResume.ts`
- Test: `test/claudeResume.test.ts`

**Interfaces:**
- Consumes: Claude's `<project>/<session>/workflows/<wf-id>.json` storage layout.
- Produces: `findClaudeWorkflowRunMetadata(projectRoot: string, runId: string): Promise<string>`.

- [ ] **Step 1: Write failing discovery tests**

Add tests that create two session directories and assert that the helper returns the one exact metadata path, rejects an invalid identifier, returns `run-not-found` for no match, returns `ambiguous-run` for duplicate matches, and returns `run-id-mismatch` when the filename and embedded metadata ID disagree.

- [ ] **Step 2: Verify the tests fail for the missing export**

Run: `npx vitest run test/claudeResume.test.ts`

Expected: FAIL because `findClaudeWorkflowRunMetadata` is not exported.

- [ ] **Step 3: Implement bounded direct-session discovery**

Implement the helper with `readdir(..., { withFileTypes: true })`, the Claude `^wf_[a-z0-9-]{6,}$` identifier grammar, the existing bounded JSON reader/parser, exact embedded-ID verification, and explicit `ClaudeResumeError` codes for missing, ambiguous, mismatched, and unreadable roots.

- [ ] **Step 4: Verify discovery tests pass**

Run: `npx vitest run test/claudeResume.test.ts`

Expected: all Claude resume tests pass, with the real-capture test skipped unless its environment variables are supplied.

### Task 2: Route both MCP resume surfaces

**Files:**
- Modify: `src/workflowService.ts`
- Modify: `src/workflowMcp.ts`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Test: `test/workflowMcp.test.ts`

**Interfaces:**
- Consumes: `findClaudeWorkflowRunMetadata(projectRoot, runId)` from Task 1.
- Produces: ID-only Claude continuation through `WorkflowService.start` and `WorkflowService.resume`.

- [ ] **Step 1: Write failing MCP integration tests**

Create a temporary Claude projects root containing a saved one-agent workflow and v2 journal. Assert `workflow_resume({ runId: "wf_resume-id" })` and `workflow_run({ resumeFromRunId: "wf_run-id" })` each return a new `run_*` handle whose manifest names the Claude ID in `resumedFromRunId` and completes without a provider call.

- [ ] **Step 2: Verify MCP tests fail through the native store**

Run: `npx vitest run test/workflowMcp.test.ts`

Expected: FAIL with `Invalid workflow run ID: "wf_..."`.

- [ ] **Step 3: Implement identifier-aware routing**

Add an optional `claudeProjectsRoot` service option for deterministic embedding/tests. Introduce one private run-ID continuation method: `wf_*` discovers metadata then calls the existing Claude importer, while every other ID calls native stored-run recovery. Use the same method from `#startOnce` and `resume`. Preserve source-selector precedence for `workflow_run` by resolving an explicit selector and passing its visible file path to the Claude importer.

- [ ] **Step 4: Update user-facing MCP descriptions and docs**

State that both `workflow_resume.runId` and `workflow_run.resumeFromRunId` accept native Agent Code `run_*` and Claude `wf_*` identifiers, while `claudeRunPath` remains the explicit-path form.

- [ ] **Step 5: Verify focused tests pass**

Run: `npx vitest run test/claudeResume.test.ts test/workflowMcp.test.ts`

Expected: both test files pass.

- [ ] **Step 6: Verify the complete package**

Run: `npm test`

Expected: build exits 0, browser-state typecheck exits 0, and Vitest reports zero failures.

- [ ] **Step 7: Commit, push, and open the pull request**

Run:

```bash
git add src/claudeResume.ts src/workflowService.ts src/workflowMcp.ts test/claudeResume.test.ts test/workflowMcp.test.ts README.md docs/ARCHITECTURE.md docs/superpowers
git commit -m "fix: resume Claude workflows by run ID"
git push -u origin fix/claude-workflow-run-id-resume
gh pr create --base main --head fix/claude-workflow-run-id-resume --title "fix: resume Claude workflows by run ID" --body-file /tmp/workflow-mcp-pr-body.md
```

Expected: GitHub returns the new pull request URL.
