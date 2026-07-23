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
}
