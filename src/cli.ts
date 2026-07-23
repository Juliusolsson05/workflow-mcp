#!/usr/bin/env node

import { findWorkflows } from './findWorkflows.js'
import { FileWorkflowStore } from './fileWorkflowStore.js'
import { loadWorkflowFile, WorkflowError } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { claudeResumeSidecarPath, loadClaudeWorkflowResume } from './claudeResume.js'
import { CodexAgentProvider } from './codexProvider.js'
import { runWorkflow } from './runWorkflow.js'
import type { JournalReuseMode, WorkflowJournal } from './workflowJournal.js'
import { PersistentWorkflowJournal } from './persistentWorkflowJournal.js'
import { serveWorkflowMcpHttp, serveWorkflowMcpStdio } from './standaloneServer.js'
import { WorkflowService } from './workflowService.js'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

function usage(): never {
  console.error(
    'Usage: workflow-mcp validate <workflow.js> | workflow-mcp list [directory] | workflow-mcp run <workflow.js> [args-json] | workflow-mcp resume <claude-run.json> [workflow.js] | workflow-mcp serve --stdio [directory] | workflow-mcp serve --http [directory] [port]',
  )
  process.exit(2)
}

async function main(): Promise<void> {
  const [, , command, argument, ...rest] = process.argv
  if (!command) usage()

  if (command === 'validate') {
    if (!argument || rest.length > 0) usage()
    const workflow = await loadWorkflowFile(argument)
    console.log(
      JSON.stringify(
        {
          valid: true,
          filePath: workflow.filePath,
          sourceHash: workflow.sourceHash,
          meta: workflow.meta,
        },
        null,
        2,
      ),
    )
    return
  }

  if (command === 'list') {
    if (rest.length > 0) usage()
    const result = await findWorkflows({ cwd: argument ?? process.cwd() })
    console.log(
      JSON.stringify(
        {
          workflows: result.workflows.map((workflow) => ({
            filePath: workflow.filePath,
            location: workflow.location,
            sourceHash: workflow.sourceHash,
            meta: workflow.meta,
          })),
          issues: result.issues,
          nearMisses: result.nearMisses,
        },
        null,
        2,
      ),
    )
    if (result.issues.length > 0) process.exitCode = 1
    return
  }

  if (command === 'run') {
    if (!argument || rest.length > 1) usage()
    let args: unknown
    if (rest[0] !== undefined) {
      try {
        args = JSON.parse(rest[0]) as unknown
      } catch (cause) {
        throw new TypeError(
          `Workflow args must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }

    await executeAndPrint(await loadWorkflowFile(argument), args)
    return
  }

  if (command === 'resume') {
    if (!argument || rest.length > 1) usage()
    const resume = await loadClaudeWorkflowResume(argument, {
      ...(rest[0] === undefined ? {} : { workflowPath: rest[0] }),
    })
    const workflowId = resume.workflow.filePath ?? resume.workflow.meta.name
    const imported = resume.journal.getSnapshot(workflowId)
    const sidecarPath = claudeResumeSidecarPath(resume.metadataPath)
    const journal = await PersistentWorkflowJournal.open(
      sidecarPath,
      imported === undefined ? [] : [imported],
    )
    process.stderr.write(
      `${JSON.stringify({
        type: 'claude.resume.loaded',
        runId: resume.metadata.runId,
        workflowName: resume.metadata.workflowName,
        priorStatus: resume.metadata.status,
        journalRecordCount: resume.journalRecordCount,
        importedPromptCount: resume.importedPromptCount,
        sidecarPath,
      })}\n`,
    )
    // Claude workflows can contain write-capable agents, but importing a foreign historical run
    // should never silently grant that capability. The standalone resume command is read-only;
    // an embedding host can call runWorkflow directly with an explicitly approved broader policy.
    await executeAndPrint(
      resume.workflow,
      resume.metadata.args,
      journal,
      'read-only',
      'exact-source-sparse',
    )
    return
  }

  if (command === 'serve') {
    if (argument !== '--stdio' && argument !== '--http') usage()
    if (rest.length > (argument === '--http' ? 2 : 1)) usage()
    const cwd = resolve(rest[0] ?? process.cwd())
    const approvedSources = await standaloneSourceApprovals(cwd)
    const service = new WorkflowService({
      store: new FileWorkflowStore(
        resolve(process.env.WORKFLOW_MCP_STATE_DIR ?? join(homedir(), '.workflow-mcp')),
      ),
      provider: () => new CodexAgentProvider(),
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
      // Starting the standalone server is the operator's approval of the workflow definitions
      // visible at that moment—not a blanket code-execution grant to every future MCP request.
      // Hash pinning means edits and inline sources fail closed until the operator restarts and can
      // inspect the new bytes, matching Agent Code's interactive source-approval boundary.
      authorizeWorkflowSource: request => approvedSources.has(
        `${request.canonicalIdentity}\0${request.sourceHash}`,
      ),
    })
    await service.initialize()

    if (argument === '--stdio') {
      const server = await serveWorkflowMcpStdio(
        service,
        { cwd, clientId: 'standalone-stdio' },
        { onInputClose: () => service.stop() },
      )
      await server.closed
      return
    }

    const port = rest[1] === undefined ? undefined : Number(rest[1])
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65_535)) {
      throw new TypeError('HTTP port must be an integer from 0 through 65535')
    }
    const server = await serveWorkflowMcpHttp(
      service,
      { cwd, clientId: 'standalone-http' },
      port === undefined ? {} : { port },
    )
    // The token is emitted only to stderr so stdout remains available for operator tooling. It is
    // never put in the URL, shell history, or workflow-visible process environment.
    process.stderr.write(`${JSON.stringify({ url: server.url, token: server.token })}\n`)
    await waitForShutdownSignal()
    await server.close()
    await service.stop()
    return
  }

  usage()
}

async function standaloneSourceApprovals(cwd: string): Promise<Set<string>> {
  const discovered = await findWorkflows({ cwd })
  const approved = new Set<string>()
  for (const workflow of discovered.workflows) {
    const identity = await realpath(workflow.filePath).catch(() => resolve(workflow.filePath))
    approved.add(`${identity}\0${workflow.sourceHash}`)
  }
  return approved
}

async function executeAndPrint(
  workflow: LoadedWorkflow,
  args?: unknown,
  journal?: WorkflowJournal,
  sandboxMode: 'read-only' | 'workspace-write' = 'workspace-write',
  journalReuseMode?: JournalReuseMode,
): Promise<void> {
  const concurrency = configuredConcurrency()
  const run = runWorkflow({
    workflow,
    ...(args === undefined ? {} : { args }),
    ...(journal === undefined ? {} : { journal }),
    ...(journalReuseMode === undefined ? {} : { journalReuseMode }),
    cwd: process.cwd(),
    provider: new CodexAgentProvider(),
    ...(concurrency === undefined ? {} : { limits: { concurrency } }),
    sandbox: {
      mode: sandboxMode,
      approvalPolicy: 'never',
      network: false,
    },
  })
  const cancelOnInterrupt = (): void => {
    // SIGINT is converted into the same ordered cancellation path as an MCP/UI request. Exiting
    // immediately would orphan Codex CLI processes and lose the terminal event needed to explain
    // why a large run stopped.
    void run.cancel('Interrupted by SIGINT')
  }
  process.once('SIGINT', cancelOnInterrupt)

  const consumeEvents = (async () => {
    for await (const event of run.events) process.stderr.write(`${JSON.stringify(event)}\n`)
  })()
  try {
    const result = await run.result
    await consumeEvents
    // JSON has no top-level undefined. Preserve the successful value in a small envelope so the
    // CLI never prints an empty stdout that is indistinguishable from a crashed process.
    console.log(
      JSON.stringify(
        result === undefined ? { resultType: 'undefined' } : { result },
        null,
        2,
      ),
    )
  } finally {
    process.removeListener('SIGINT', cancelOnInterrupt)
    await consumeEvents
  }
}

function configuredConcurrency(): number | undefined {
  const raw = process.env.WORKFLOW_MCP_CONCURRENCY
  if (raw === undefined || raw.length === 0) return undefined
  const value = Number(raw)
  // This is an operator escape hatch for measured machines, not a workflow-controlled capability.
  // A finite ceiling prevents a typo from launching hundreds of native Codex processes at once.
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new TypeError('WORKFLOW_MCP_CONCURRENCY must be an integer from 1 through 64')
  }
  return value
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const finish = (): void => {
      process.removeListener('SIGINT', finish)
      process.removeListener('SIGTERM', finish)
      resolveSignal()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}

main().catch((error: unknown) => {
  if (error instanceof WorkflowError) {
    console.error(JSON.stringify({ valid: false, code: error.code, message: error.message }, null, 2))
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  process.exitCode = 1
})
