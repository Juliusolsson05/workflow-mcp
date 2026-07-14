#!/usr/bin/env node

import { findWorkflows } from './findWorkflows.js'
import { loadWorkflowFile, WorkflowError } from './loadWorkflow.js'
import { CodexAgentProvider } from './codexProvider.js'
import { runWorkflow } from './runWorkflow.js'

function usage(): never {
  console.error(
    'Usage: workflow-mcp validate <workflow.js> | workflow-mcp list [directory] | workflow-mcp run <workflow.js> [args-json]',
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

    const workflow = await loadWorkflowFile(argument)
    const run = runWorkflow({
      workflow,
      ...(args === undefined ? {} : { args }),
      cwd: process.cwd(),
      provider: new CodexAgentProvider(),
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
    return
  }

  usage()
}

main().catch((error: unknown) => {
  if (error instanceof WorkflowError) {
    console.error(JSON.stringify({ valid: false, code: error.code, message: error.message }, null, 2))
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  process.exitCode = 1
})
