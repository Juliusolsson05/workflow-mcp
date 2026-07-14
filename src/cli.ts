#!/usr/bin/env node

import { findWorkflows } from './findWorkflows.js'
import { loadWorkflowFile, WorkflowError } from './loadWorkflow.js'

function usage(): never {
  console.error('Usage: workflow-mcp validate <workflow.js> | workflow-mcp list [directory]')
  process.exit(2)
}

async function main(): Promise<void> {
  const [, , command, argument, ...rest] = process.argv
  if (!command || rest.length > 0) usage()

  if (command === 'validate') {
    if (!argument) usage()
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
