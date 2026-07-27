// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { StandaloneApiClient } from '../src/client/apiClient.js'

const runBase = {
  schemaVersion: 1 as const,
  runId: 'run_1',
  workflow: { name: 'review', title: 'Review', description: 'Review fixture' },
  status: 'running',
  cursor: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  lineageId: 'run_1',
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// The browser client rejects incompatible DTO/envelope schemas before the dashboard ever renders
// them. (The old DOM-lifecycle cases were removed with the dashboard rewrite in this PR; web
// rendering is now verified by tsc + the demo, and richer web coverage returns in the test cleanup.)
describe('browser client schema guards', () => {
  it.each([
    ['instance', (client: StandaloneApiClient) => client.instance()],
    ['inventory', (client: StandaloneApiClient) => client.runs()],
    ['snapshot', (client: StandaloneApiClient) => client.run('run_1')],
    ['events', (client: StandaloneApiClient) => client.events('run_1', 0)],
    ['result', (client: StandaloneApiClient) => client.result('run_1', 'artifact_1')],
    ['agents', (client: StandaloneApiClient) => client.agents('run_1')],
    ['agent result', (client: StandaloneApiClient) => client.agentResult('run_1', 'agent_1')],
    ['agent transcript', (client: StandaloneApiClient) => client.agentTranscript('run_1', 'agent_1')],
  ] as const)('rejects an incompatible %s DTO before rendering it', async (_name, request) => {
    const client = new StandaloneApiClient({
      token: 'web-token',
      fetch: async () => json({ schemaVersion: 2 }),
    })
    await expect(request(client)).rejects.toMatchObject({ code: 'incompatible-schema' })
  })

  it('validates nested run and transcript event envelopes without inspecting arbitrary payload data', async () => {
    const inventory = new StandaloneApiClient({
      token: 'web-token',
      fetch: async () => json({ schemaVersion: 1, items: [{ ...runBase, schemaVersion: 2 }], hasMore: false }),
    })
    await expect(inventory.runs()).rejects.toMatchObject({ code: 'incompatible-schema' })

    const transcript = new StandaloneApiClient({
      token: 'web-token',
      fetch: async () => json({
        schemaVersion: 1,
        runId: 'run_1',
        agentId: 'agent_1',
        fromCursor: 0,
        toCursor: 1,
        hasMore: false,
        events: [{
          runId: 'run_1',
          cursor: 1,
          recordedAt: '2026-01-01T00:00:01.000Z',
          event: { schemaVersion: 2, payload: { schemaVersion: 99 } },
        }],
      }),
    })
    await expect(transcript.agentTranscript('run_1', 'agent_1'))
      .rejects.toMatchObject({ code: 'incompatible-schema' })

    const payload = new StandaloneApiClient({
      token: 'web-token',
      fetch: async () => json({
        schemaVersion: 1,
        runId: 'run_1',
        agentId: 'agent_1',
        fromCursor: 0,
        toCursor: 1,
        hasMore: false,
        events: [{
          runId: 'run_1',
          cursor: 1,
          recordedAt: '2026-01-01T00:00:01.000Z',
          event: { schemaVersion: 1, payload: { schemaVersion: 99 } },
        }],
      }),
    })
    await expect(payload.agentTranscript('run_1', 'agent_1')).resolves.toMatchObject({ schemaVersion: 1 })
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
