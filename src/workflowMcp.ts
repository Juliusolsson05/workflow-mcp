import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'

import { MAX_WORKFLOW_BYTES } from './loadWorkflow.js'
import {
  MAX_WORKFLOW_RESULT_PAGE_BYTES,
  MIN_WORKFLOW_RESULT_PAGE_BYTES,
} from './workflowStore.js'
import type {
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from './workflowService.js'

export const WORKFLOW_MCP_INSTRUCTIONS = `Use workflows for durable multi-agent orchestration.

To run an existing workflow, call workflow_list, optionally workflow_describe, then workflow_run with its name. To author one, call workflow_run with inline JavaScript in script. The first statement must be a pure literal export const meta = { name: '...', description: '...' }; optional metadata includes title, whenToUse, and phases. The remaining top-level script can await agent(), pipeline(), parallel(), workflow(), call phase()/log(), read args, and return a result. Pass args as real JSON, never a JSON-encoded string.

Inline source is saved under the current Git project's .claude/workflows and the run result returns scriptPath. That path is the editable Claude-visible definition. Iterate by editing it and calling workflow_run with scriptPath; existing definitions are never overwritten implicitly. Each execution also keeps a private immutable source snapshot for recovery and returns transcriptDirectory, containing journal.jsonl plus agent-<id>.jsonl mirrors for investigation.

workflow_run uses Claude precedence: scriptPath overrides script, which overrides name. resumeFromRunId accepts a native Agent Code run_* ID or discovers a real Claude wf_* run inside the scoped project, then creates a new linked run; workflow_resume remains a compatibility alias and keeps claudeRunPath as an explicit-path escape hatch. A manual resume reuses successful work but retries coverage gaps, while automatic host-crash recovery preserves terminal gaps without unsafe replay. workflow_run returns immediately. Poll workflow_run_events with the last toCursor as after (waitMs may long-poll), and use workflow_run_status for terminal status and health. Continue until completed, completed_with_errors, failed, cancelled, or interrupted. A completed run's run.result and run.completed payload carry an artifactId, byte/line counts, media type, and SHA-256 checksum. When result.truncated is true, call workflow_result_read with that runId and artifactId, then follow nextCursor until hasMore is false; never reconstruct a filesystem path. Retryable replay-safe work starts a fresh provider thread beneath the same logical assignment; the abandoned physical attempt remains in the audit stream. Exhausted or replay-unsafe assignments return a versioned __workflowAgentFailure coverage-gap value, while independent siblings and final synthesis continue. Only persistence or supervisor faults fail the complete run. An untouched queued run, or a replay-safe run interrupted by a host crash, is automatically continued as a new run in the same lineage.

After a run finishes, inspect its constituent agents rather than only its final result. workflow_agent_list returns the logical agents with labels, phases, statuses and attempt history; workflow_agent_result_read returns one agent's complete untruncated value, and workflow_agent_results_read sweeps them all in callIndex order, optionally filtered to one phase. Prefer these over reading agent.completed previews, which are bounded, and never read journal.jsonl or the agent-<id>.jsonl mirrors directly — they are private storage and unavailable to a remote client. Use workflow_agent_transcript_read when a result alone does not explain what an agent did.

The service has a shared provider capacity of nine by default. To keep it full, admit the complete independent collection with parallel(tasks) or pipeline(items, ...stages). Do not manually await fixed batches of nine: when only two slow agents remain in such a batch, JavaScript has not admitted the next batch and the scheduler cannot fill the other seven slots. The runtime emits workflow-capacity-unfilled-no-runnable-work when it detects that shape. Do not invent run IDs or source paths.`

export function workflowMcpInstructions(inlineAuthoring = true, providerCapacity = 9): string {
  if (!Number.isSafeInteger(providerCapacity) || providerCapacity < 1) {
    throw new TypeError('providerCapacity must be a positive integer')
  }
  const sourceInstructions = inlineAuthoring ? WORKFLOW_MCP_INSTRUCTIONS : WORKFLOW_MCP_INSTRUCTIONS.replace(
    /To author one, call workflow_run with inline JavaScript in script\.[\s\S]*?Pass args as real JSON, never a JSON-encoded string\./,
    'This instance is read-only: run only already-visible workflows by name or scriptPath. Inline script authoring is disabled and returns authoring-disabled. Pass args as real JSON, never a JSON-encoded string.',
  ).replace(
    /Inline source is saved under the current Git project's \.claude\/workflows and the run result returns scriptPath\.[\s\S]*?existing definitions are never overwritten implicitly\./,
    'Workflow definitions are mounted read-only. Edit them on the host, then restart the daemon so the new source hash crosses the startup approval boundary.',
  )
  return sourceInstructions.replace(
    /The service has a shared provider capacity of nine by default\.[\s\S]*?Do not invent run IDs or source paths\./,
    `The service has a shared provider capacity of ${providerCapacity}. To keep it full, admit the complete independent collection with parallel(tasks) or pipeline(items, ...stages). Do not manually await fixed-size batches: stragglers in one batch prevent JavaScript from admitting later work to the scheduler. The runtime emits workflow-capacity-unfilled-no-runnable-work when it detects that shape. Do not invent run IDs or source paths.`,
  )
}

export type WorkflowMcpRegistrationHooks = {
  /** Called after a durable run exists, before its MCP result is returned. */
  onRunStarted?: (run: WorkflowRunStartResult) => void
  /** Defaults true for the historical embedded Agent Code surface. */
  inlineAuthoring?: boolean
}

/** Register the portable workflow surface on an MCP server owned by the embedding host. */
export function registerWorkflowMcpTools(
  server: McpServer,
  service: WorkflowService,
  scope: WorkflowServiceScope,
  hooks: WorkflowMcpRegistrationHooks = {},
): void {
  server.registerTool(
    'workflow_list',
    {
      title: 'List workflows',
      description: 'List valid Claude-compatible .js definitions visible from ~/.claude/workflows and project .claude/workflows, plus parse issues and near-miss extensions.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(await listResult(service, scope)),
  )

  server.registerTool(
    'workflow_describe',
    {
      title: 'Describe workflow',
      description: 'Read one named workflow\'s normalized metadata, source hash, location, and editable filePath without executing it.',
      inputSchema: { name: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const workflow = await service.describe(scope, { name })
      return result({ ok: true, workflow: publicWorkflow(workflow) })
    },
  )

  server.registerTool(
    'workflow_validate',
    {
      title: 'Validate workflow',
      description: 'Parse and validate one already-visible named workflow and return its normalized Claude metadata.',
      inputSchema: { name: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const validated = await service.validate(scope, { name })
      return result({ ok: true, valid: validated.valid, workflow: publicWorkflow(validated.workflow) })
    },
  )

  server.registerTool(
    'workflow_run',
    {
      title: 'Run workflow',
      description: hooks.inlineAuthoring === false
        ? 'Start or resume a durable already-visible workflow. This instance is read-only and rejects inline script authoring with authoring-disabled. The call returns immediately: poll workflow_run_events from its cursor until status is terminal.'
        : 'Author, start, or resume a durable Claude-compatible workflow. Source precedence is scriptPath > script > name. Inline script must begin with pure-literal `export const meta = { name, description }`; it is persisted under project .claude/workflows and the editable scriptPath is returned. The call returns immediately: poll workflow_run_events from its cursor until status is terminal.',
      inputSchema: {
        name: z.string().min(1).optional().describe('Visible meta.name; lowest-precedence source selector.'),
        script: z.string().max(MAX_WORKFLOW_BYTES).optional().describe(hooks.inlineAuthoring === false
          ? 'Unavailable in this read-only instance; use a host-created visible workflow.'
          : 'Inline workflow JavaScript. Persisted as an editable project .claude/workflows/*.js definition before execution.'),
        scriptPath: z.string().min(1).optional().describe('Editable .js definition under a visible user/project .claude/workflows directory. Highest precedence.'),
        args: z.unknown().optional(),
        resumeFromRunId: z.string().min(1).optional().describe('Native Agent Code run_* or real Claude wf_* run to continue as a new linked run.'),
        title: z.string().optional().describe('Accepted for Claude call-shape compatibility; execution metadata comes from script meta.'),
        description: z.string().optional().describe('Accepted for Claude call-shape compatibility; execution metadata comes from script meta.'),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, script, scriptPath, args, resumeFromRunId, idempotencyKey }) => {
      const run = await service.start(scope, {
        ...(name === undefined ? {} : { name }),
        ...(script === undefined ? {} : { script }),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        ...(args === undefined ? {} : { args }),
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      // WHY the host learns about the run here instead of scraping its own transcript later:
      // modern MCP clients are allowed to defer tools behind code-mode orchestrators, which means
      // the model-visible call may be `functions.exec` even though the wire operation was exactly
      // `workflow_run`. This hook is still inside the authoritative tools/call handler and therefore
      // preserves the real client scope without coupling the portable service to Electron.
      hooks.onRunStarted?.(run)
      return result({ ok: true, run })
    },
  )

  server.registerTool(
    'workflow_run_status',
    {
      title: 'Workflow run status',
      description: 'Read durable status plus scheduler/agent health, retry/stall counts, timestamps, recovery lineage, and latest event cursor. Completed runs include run.result with the workflow_result_read artifact locator and integrity metadata. Terminal statuses are completed, completed_with_errors, failed, cancelled, and interrupted.',
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => result({ ok: true, ...await service.inspect(scope, runId) }),
  )

  server.registerTool(
    'workflow_run_events',
    {
      title: 'Workflow run events',
      description: 'Read a bounded durable event page strictly after a cursor. Continue with after=page.toCursor while page.hasMore; waitMs can long-poll when caught up.',
      inputSchema: {
        runId: z.string().min(1),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, after, limit, waitMs }) => result({
      ok: true,
      page: await service.readEvents(scope, {
        runId,
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
        ...(waitMs === undefined ? {} : { waitMs }),
      }),
    }),
  )

  server.registerTool(
    'workflow_result_read',
    {
      title: 'Read workflow result',
      description: 'Read one bounded UTF-8 page of a completed run result. Copy artifactId from workflow_run_status.run.result or run.completed; follow nextCursor while hasMore. The locator is run-scoped and never accepts filesystem paths.',
      inputSchema: {
        runId: z.string().min(1),
        artifactId: z.string().min(1).max(200),
        cursor: z.string().min(1).max(200).optional(),
        maxBytes: z.number().int()
          .min(MIN_WORKFLOW_RESULT_PAGE_BYTES)
          .max(MAX_WORKFLOW_RESULT_PAGE_BYTES)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, artifactId, cursor, maxBytes }) => result({
      ok: true,
      page: await service.readResult(scope, {
        runId,
        artifactId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    }),
  )

  server.registerTool(
    'workflow_run_cancel',
    {
      title: 'Cancel workflow run',
      description: 'Request cooperative cancellation of an active run. The durable terminal event remains available through workflow_run_events.',
      inputSchema: { runId: z.string().min(1), reason: z.string().max(1_000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ runId, reason }) => result({
      ok: true,
      run: await service.cancel(scope, runId, reason),
    }),
  )

  server.registerTool(
    'workflow_resume',
    {
      title: 'Resume workflow run',
      description: 'Compatibility alias that continues a native Agent Code run_* or discovers and imports a real Claude wf_* run from the scoped project. claudeRunPath remains available for explicit metadata selection. Successful calls are reused while coverage gaps are retried. New clients may use workflow_run.resumeFromRunId.',
      // McpServer's raw-shape API renders unions as an empty schema in SDK 1.29. Keep every public
      // field discoverable and enforce the mutually-exclusive source pair in the handler instead;
      // otherwise catalog metadata would promise resume arguments that tools/list silently omits.
      inputSchema: {
        runId: z.string().min(1).optional(),
        claudeRunPath: z.string().min(1).optional(),
        workflowPath: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        abandonUnconfirmedProvider: z.boolean().optional().describe(
          'Explicit operator acknowledgement for continuing a read-only offline run while an old provider descendant may still be alive',
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      if ((input.runId === undefined) === (input.claudeRunPath === undefined)) {
        throw new TypeError('workflow_resume requires exactly one of runId or claudeRunPath')
      }
      const run = await service.resume(
        scope,
        input.runId !== undefined
          ? {
            runId: input.runId,
              ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
              ...(input.abandonUnconfirmedProvider === undefined
                ? {}
                : { abandonUnconfirmedProvider: input.abandonUnconfirmedProvider }),
            }
          : {
              claudeRunPath: input.claudeRunPath!,
              ...(input.workflowPath === undefined ? {} : { workflowPath: input.workflowPath }),
              ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            },
      )
      // Resume creates a new durable run ID. Publishing the returned reference through the same
      // hook lets an embedding host keep one stable workflow view while following that lineage.
      hooks.onRunStarted?.(run)
      return result({ ok: true, run })
    },
  )

  server.registerTool(
    'workflow_agent_list',
    {
      title: 'List workflow agents',
      description: 'List a run\'s logical agents with label, phase, status, attempt history, and a result locator each. Abandoned retry attempts appear as history inside their agent, never as separate agents. Works while the run is still executing. Returns every agent in one response (not paginated); the returned cursor is the run\'s event position, not a paging token — compare it across calls to tell whether a live run has advanced. result.source is artifact (durable per-agent bytes), journal (recorded value, no artifact), or none (no terminal value yet).',
      inputSchema: {
        runId: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => result({ ok: true, agents: await service.listAgents(scope, { runId }) }),
  )

  server.registerTool(
    'workflow_agent_result_read',
    {
      title: 'Read one agent result',
      description: 'Read one bounded UTF-8 page of a single agent\'s complete terminal value — the untruncated result behind agent.completed\'s bounded preview. Take agentId from workflow_agent_list; follow nextCursor while hasMore. artifactId is optional and acts as an integrity fence when supplied. Journal-served agents get a content-addressed id synthesized at read time, which is valid here but is not listed by workflow_agent_list and is never valid in workflow_result_read. Coverage-gap placeholders are returned as the honest terminal value rather than hidden. The locator is run-scoped and never accepts filesystem paths.',
      inputSchema: {
        runId: z.string().min(1),
        agentId: z.string().min(1).max(200),
        artifactId: z.string().min(1).max(200).optional(),
        cursor: z.string().min(1).max(200).optional(),
        maxBytes: z.number().int()
          .min(MIN_WORKFLOW_RESULT_PAGE_BYTES)
          .max(MAX_WORKFLOW_RESULT_PAGE_BYTES)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, agentId, artifactId, cursor, maxBytes }) => result({
      ok: true,
      page: await service.readAgentResult(scope, {
        runId,
        agentId,
        ...(artifactId === undefined ? {} : { artifactId }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    }),
  )

  server.registerTool(
    'workflow_agent_results_read',
    {
      title: 'Read all agent results',
      description: 'Walk every readable agent result in one paginated sweep, ordered by callIndex. Optionally filter to one phase by id or title. Each item is the same page shape workflow_agent_result_read returns; follow nextCursor while hasMore. A page stops at the first agent with more bytes, so each agent\'s content arrives contiguously rather than interleaved. An agent whose bytes cannot be read is reported in skipped[] and the sweep continues. Keep phase constant across a paged sweep: the cursor names an agent, so changing the filter mid-walk invalidates it.',
      inputSchema: {
        runId: z.string().min(1),
        phase: z.string().min(1).max(200).optional(),
        cursor: z.string().min(1).max(400).optional(),
        maxBytes: z.number().int()
          .min(MIN_WORKFLOW_RESULT_PAGE_BYTES)
          .max(MAX_WORKFLOW_RESULT_PAGE_BYTES)
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, phase, cursor, maxBytes }) => result({
      ok: true,
      page: await service.readAgentResults(scope, {
        runId,
        ...(phase === undefined ? {} : { phase }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      }),
    }),
  )

  server.registerTool(
    'workflow_agent_transcript_read',
    {
      title: 'Read one agent transcript',
      description: 'Read one agent\'s slice of the canonical event stream — admission, attempts, activity, retries, and terminal outcome — for deeper investigation than a result alone allows. Page with after set to the previous toCursor while hasMore. This reads the durable event log, not the best-effort agent-<id>.jsonl mirror.',
      inputSchema: {
        runId: z.string().min(1),
        agentId: z.string().min(1).max(200),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, agentId, after, limit }) => result({
      ok: true,
      page: await service.readAgentTranscript(scope, {
        runId,
        agentId,
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      }),
    }),
  )
}

async function listResult(service: WorkflowService, scope: WorkflowServiceScope) {
  const found = await service.list(scope)
  return {
    ok: true,
    workflows: found.workflows.map(publicWorkflow),
    issues: found.issues,
    nearMisses: found.nearMisses,
  }
}

function publicWorkflow(workflow: Awaited<ReturnType<WorkflowService['describe']>>) {
  return {
    filePath: workflow.filePath,
    location: workflow.location,
    sourceHash: workflow.sourceHash,
    meta: workflow.meta,
  }
}

function result(value: object) {
  // WHY the same object exists twice: MCP structuredContent is the best machine contract, but
  // Claude and Codex surface tool results through different transcript envelopes. JSON text is the
  // portable fallback that lets both feed renderers recover the run ID without parsing prose.
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}
