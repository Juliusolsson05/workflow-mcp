import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'

import type {
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from './workflowService.js'

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
      description: 'List Claude-compatible workflow definitions visible from this project.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(await listResult(service, scope)),
  )

  server.registerTool(
    'workflow_describe',
    {
      title: 'Describe workflow',
      description: 'Describe one visible workflow without executing it.',
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
      description: 'Validate a visible workflow and return its normalized metadata.',
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
      description: 'Start a durable workflow run and return its run ID immediately.',
      inputSchema: {
        name: z.string().min(1),
        args: z.unknown().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, args, idempotencyKey }) => {
      const run = await service.start(scope, {
        name,
        ...(args === undefined ? {} : { args }),
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
      description: 'Read durable status and latest cursor for a workflow run.',
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => result({ ok: true, run: await service.status(scope, runId) }),
  )

  server.registerTool(
    'workflow_run_events',
    {
      title: 'Workflow run events',
      description: 'Read durable workflow events after a cursor, optionally waiting for new work.',
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
      description: 'Request cooperative cancellation of an active workflow run.',
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
      description: 'Start a new run linked to a failed, cancelled, or interrupted durable run.',
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
