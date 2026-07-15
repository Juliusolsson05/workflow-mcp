import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'

import { MAX_WORKFLOW_BYTES } from './loadWorkflow.js'
import type {
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from './workflowService.js'

export const WORKFLOW_MCP_INSTRUCTIONS = `Use workflows for durable multi-agent orchestration.

To run an existing workflow, call workflow_list, optionally workflow_describe, then workflow_run with its name. To author one, call workflow_run with inline JavaScript in script. The first statement must be a pure literal export const meta = { name: '...', description: '...' }; optional metadata includes title, whenToUse, and phases. The remaining top-level script can await agent(), pipeline(), parallel(), workflow(), call phase()/log(), read args, and return a result. Pass args as real JSON, never a JSON-encoded string.

Inline source is saved under the current Git project's .claude/workflows and the run result returns scriptPath. That path is the editable Claude-visible definition. Iterate by editing it and calling workflow_run with scriptPath; existing definitions are never overwritten implicitly. Each execution also keeps a private immutable source snapshot for recovery and returns transcriptDirectory, containing journal.jsonl plus agent-<id>.jsonl mirrors for investigation.

workflow_run uses Claude precedence: scriptPath overrides script, which overrides name. resumeFromRunId creates a new run linked to a failed, cancelled, or interrupted run; workflow_resume remains a compatibility alias. workflow_run returns immediately. Poll workflow_run_events with the last toCursor as after (waitMs may long-poll), and use workflow_run_status for terminal status. Continue until completed, failed, cancelled, or interrupted. Do not invent run IDs or source paths.`

export type WorkflowMcpRegistrationHooks = {
  /** Called after a durable run exists, before its MCP result is returned. */
  onRunStarted?: (run: WorkflowRunStartResult) => void
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
      description: 'Author, start, or resume a durable Claude-compatible workflow. Source precedence is scriptPath > script > name. Inline script must begin with pure-literal `export const meta = { name, description }`; it is persisted under project .claude/workflows and the editable scriptPath is returned. The call returns immediately: poll workflow_run_events from its cursor until status is terminal.',
      inputSchema: {
        name: z.string().min(1).optional().describe('Visible meta.name; lowest-precedence source selector.'),
        script: z.string().max(MAX_WORKFLOW_BYTES).optional().describe('Inline workflow JavaScript. Persisted as an editable project .claude/workflows/*.js definition before execution.'),
        scriptPath: z.string().min(1).optional().describe('Editable .js definition under a visible user/project .claude/workflows directory. Highest precedence.'),
        args: z.unknown().optional(),
        resumeFromRunId: z.string().min(1).optional().describe('Failed, cancelled, or interrupted Agent Code run to continue as a new linked run.'),
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
      description: 'Read durable status, timestamps, workflow source identity, and latest event cursor. Terminal statuses are completed, failed, cancelled, and interrupted.',
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => result({ ok: true, run: await service.status(scope, runId) }),
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
      description: 'Compatibility alias that starts a new run linked to a failed, cancelled, or interrupted Agent Code run, or imports validated Claude run metadata. New clients may use workflow_run.resumeFromRunId.',
      inputSchema: z.union([
        z.object({
          runId: z.string().min(1),
          idempotencyKey: z.string().min(1).max(200).optional(),
        }),
        z.object({
          claudeRunPath: z.string().min(1),
          workflowPath: z.string().min(1).optional(),
          idempotencyKey: z.string().min(1).max(200).optional(),
        }),
      ]),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const run = await service.resume(
        scope,
        'runId' in input
          ? {
              runId: input.runId,
              ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            }
          : {
              claudeRunPath: input.claudeRunPath,
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
