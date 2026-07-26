import type { DoctorReport } from '../daemon/health.js'
import { terminalSafe } from './terminal.js'

export function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  process.stdout.write(`Workflow MCP ${terminalSafe(report.version)} (${terminalSafe(report.revision)})\n`)
  for (const check of report.checks) {
    process.stdout.write(`${terminalSafe(check.status).toUpperCase().padEnd(4)} ${terminalSafe(check.id)}: ${terminalSafe(check.message)}\n`)
  }
  // Print the overall verdict explicitly. Without it, a report that is not-ok for a soft reason (a
  // `warn` check such as an unauthenticated provider that still sets report.ok=false, N1) would show
  // only PASS/WARN lines and a bare non-zero exit — leaving a terminal reader with no visible reason
  // the daemon is not ready. The line makes the top-line status match the exit code.
  process.stdout.write(`${report.ok ? 'READY' : 'NOT READY'}\n`)
}
