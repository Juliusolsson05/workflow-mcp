#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

import { CodexAgentProvider } from './codexProvider.js'
import { parseWorkflowSource } from './loadWorkflow.js'
import { runWorkflow } from './runWorkflow.js'

type ProcessSample = {
  descendants?: number
  residentBytes?: number
}

type FanoutResult = {
  fanout: number
  startupMs: number | null
  wallClockMs: number
  failures: number
  peakDescendants: number | null
  peakResidentBytes: number | null
}

if (process.env.WORKFLOW_CODEX_BENCHMARK !== '1') {
  console.error(
    'Refusing to consume Codex capacity. Set WORKFLOW_CODEX_BENCHMARK=1 to run fan-outs 1, 4, 8, 16, and 20.',
  )
  process.exit(2)
}

const fanouts = [1, 4, 8, 16, 20] as const
const results: FanoutResult[] = []

for (const fanout of fanouts) results.push(await measureFanout(fanout))
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2))

async function measureFanout(fanout: number): Promise<FanoutResult> {
  const workflow = parseWorkflowSource(`
    export const meta = {
      name: 'codex-fanout-${fanout}',
      description: 'Opt-in native process fan-out measurement',
    }
    return await parallel(Array.from({ length: ${fanout} }, (_, index) => () =>
      agent('Reply with exactly BENCHMARK_OK_' + index + ' and do not use tools.'),
    ))
  `)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(`Fan-out ${fanout} exceeded five minutes`), 300_000)
  const startedAt = performance.now()
  let firstAgentAt: number | undefined
  let peakDescendants = 0
  let peakResidentBytes = 0
  let processSamplingAvailable = false

  // The SDK launches a native CLI per live turn. Parent-only process.memoryUsage() would hide the
  // actual cost, so sample the complete descendant tree when the host provides POSIX `ps`. A null
  // measurement is more honest than silently reporting only this tiny coordinator process.
  const sampler = setInterval(() => {
    const sample = sampleDescendants(process.pid)
    if (sample.descendants === undefined || sample.residentBytes === undefined) return
    processSamplingAvailable = true
    peakDescendants = Math.max(peakDescendants, sample.descendants)
    peakResidentBytes = Math.max(peakResidentBytes, sample.residentBytes)
  }, 25)

  try {
    const run = runWorkflow({
      workflow,
      cwd: process.cwd(),
      provider: new CodexAgentProvider(),
      limits: { concurrency: fanout },
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
      signal: controller.signal,
    })
    const consume = (async () => {
      for await (const event of run.events) {
        if (event.type === 'agent.started' && firstAgentAt === undefined) {
          firstAgentAt = performance.now()
        }
      }
    })()
    const value = await run.result
    await consume
    const values = Array.isArray(value) ? value : []
    return {
      fanout,
      startupMs: firstAgentAt === undefined ? null : Math.round(firstAgentAt - startedAt),
      wallClockMs: Math.round(performance.now() - startedAt),
      failures: fanout - values.filter((entry) => entry !== null).length,
      peakDescendants: processSamplingAvailable ? peakDescendants : null,
      peakResidentBytes: processSamplingAvailable ? peakResidentBytes : null,
    }
  } finally {
    clearTimeout(timeout)
    clearInterval(sampler)
  }
}

function sampleDescendants(rootPid: number): ProcessSample {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
      timeout: 2_000,
    })
    const rows = output
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row): row is [number, number, number] => (
        row.length === 3 && row.every((value) => Number.isFinite(value))
      ))
    const wanted = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parentPid] of rows) {
        if (wanted.has(parentPid) && !wanted.has(pid)) {
          wanted.add(pid)
          changed = true
        }
      }
    }
    const descendants = rows.filter(([pid]) => wanted.has(pid) && pid !== rootPid)
    return {
      descendants: descendants.length,
      residentBytes: descendants.reduce((sum, [, , rssKiB]) => sum + rssKiB * 1_024, 0),
    }
  } catch {
    return {}
  }
}
