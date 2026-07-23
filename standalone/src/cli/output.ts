import type { DoctorReport } from '../daemon/health.js'

export function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }
  process.stdout.write(`Workflow MCP ${report.version} (${report.revision})\n`)
  for (const check of report.checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}\n`)
  }
}
