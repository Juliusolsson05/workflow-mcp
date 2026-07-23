import { describe, expect, it } from 'vitest'

import { renderTuiSnapshot } from '../src/tui/application.js'

describe('terminal UI', () => {
  it('renders a deterministic non-ANSI snapshot for logs and accessibility fallbacks', () => {
    const output = renderTuiSnapshot({
      schemaVersion: 1,
      version: '1.2.3',
      revision: '0123456789abcdef',
      lifecycle: 'READY',
      sourceMode: 'read-only',
      capabilities: { browserMutations: false, authoring: false },
    }, [{
      schemaVersion: 1,
      runId: 'run_example',
      workflow: { name: 'review', description: 'Review the project' },
      status: 'running',
      cursor: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      lineageId: 'run_example',
    }])
    expect(output).toContain('Workflow MCP 1.2.3 (01234567)')
    expect(output).toContain('running')
    expect(output).toContain('run_example')
    expect(output).not.toContain('\u001b[')
  })
})
