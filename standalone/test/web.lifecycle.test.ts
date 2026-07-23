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

const counts = {
  total: 2,
  admitted: 2,
  queued: 0,
  running: 1,
  completed: 0,
  failed: 0,
  recovery_required: 0,
  skipped: 0,
  cancelled: 0,
  reused: 0,
  attempts: 1,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser detail lifecycle', () => {
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

  it('reconnects and adds later evidence without replacing an open loaded reader', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<main id="app"></main>'
    let snapshots = 0
    let agentListings = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      // The page now probes the API once with an empty bearer to detect the tokenless default
      // profile. These suites exercise the hardened token flow, so answer that probe like a
      // hardened daemon would: 401, which routes the page to the login form the tests drive.
      const bearer = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ""
      if (bearer.trim() === "Bearer") return json({ schemaVersion: 1, error: { code: "unauthorized" } }, 401)
      if (url === '/api/v1/instance') return json({
        schemaVersion: 1,
        version: '1.0.0',
        revision: 'a'.repeat(40),
        lifecycle: 'READY',
        sourceMode: 'read-only',
        capabilities: { browserMutations: false, authoring: false },
        runtime: {
          workspace: '/workspace', mountMode: 'project-read-only',
          authentication: { mode: 'interactive', status: 'operator-check-required' },
          startedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 10, providerCapacity: 1,
        },
      })
      if (url.startsWith('/api/v1/runs?')) return json({ schemaVersion: 1, items: [runBase], hasMore: false })
      if (url === '/api/v1/runs/run_1') {
        snapshots += 1
        const terminal = snapshots > 1
        const run = terminal
          ? { ...runBase, status: 'completed', cursor: 3, result: { artifactId: 'artifact_1', mediaType: 'text/plain', sizeBytes: 4, lineCount: 1 } }
          : runBase
        return json({
          schemaVersion: 1,
          run,
          cursor: run.cursor,
          state: {
            schemaVersion: 1,
            runId: run.runId,
            status: terminal ? 'completed' : 'running',
            sequence: run.cursor,
            workflow: run.workflow,
            counts: terminal ? { ...counts, running: 0, completed: 2, attempts: 2 } : counts,
            phases: [], agents: [], warnings: [],
          },
        })
      }
      if (url.startsWith('/api/v1/runs/run_1/events?')) throw new TypeError('simulated disconnect')
      if (url === '/api/v1/runs/run_1/agents') {
        agentListings += 1
        if (agentListings === 2) throw new TypeError('simulated terminal evidence disconnect')
        const agents = [{
          agentId: 'agent_1', callIndex: 0, label: 'First', status: agentListings > 2 ? 'completed' : 'running',
          reused: false, coverageGap: false, attempts: [{ attemptId: 'attempt_1', number: 1, status: 'completed' }],
          result: { available: false, source: 'journal' },
        }]
        if (agentListings > 2) agents.push({
          agentId: 'agent_2', callIndex: 1, label: 'Later', status: 'completed', reused: false,
          coverageGap: false, attempts: [{ attemptId: 'attempt_2', number: 1, status: 'completed' }],
          result: { available: false, source: 'journal' },
        })
        return json({ schemaVersion: 1, runId: 'run_1', cursor: agentListings > 2 ? 3 : 1, agents })
      }
      if (url.startsWith('/api/v1/runs/run_1/agents/agent_1/transcript?')) return json({
        schemaVersion: 1, runId: 'run_1', agentId: 'agent_1', fromCursor: 0, toCursor: 1,
        hasMore: false,
        events: [{
          runId: 'run_1', cursor: 1, recordedAt: '2026-01-01T00:00:01.000Z',
          event: { schemaVersion: 1, type: 'warning', runId: 'run_1', sequence: 1, eventId: 'event_1', timestamp: '2026-01-01T00:00:01.000Z', payload: { message: 'retained evidence' } },
        }],
      })
      throw new Error(`Unexpected browser request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    vi.resetModules()
    await import('../web/src/main.js')

    const input = document.querySelector<HTMLInputElement>('#token')!
    input.value = 'web-token'
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => document.querySelector('.run-row') !== null)
    document.querySelector<HTMLButtonElement>('.run-row')!.click()
    await waitFor(() => document.querySelector('[data-evidence-key="agent:agent_1"]') !== null)

    const firstGroup = document.querySelector<HTMLDetailsElement>('[data-evidence-key="agent:agent_1"]')!
    firstGroup.open = true
    const reader = firstGroup.querySelector<HTMLElement>('.evidence-reader')!
    ;[...reader.querySelectorAll('button')].find(button => button.textContent === 'Load transcript')!.click()
    await waitFor(() => reader.querySelector('pre')?.textContent?.includes('retained evidence') === true)
    const retainedText = reader.querySelector('pre')!.textContent

    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => document.querySelector('[data-role="evidence-index-status"]')?.textContent?.includes('retrying') === true)
    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => document.querySelector('[data-evidence-key="agent:agent_2"]') !== null)
    expect(snapshots).toBe(2)
    expect(agentListings).toBe(3)
    expect(firstGroup.isConnected).toBe(true)
    expect(firstGroup.open).toBe(true)
    expect(firstGroup.querySelector('.evidence-reader')).toBe(reader)
    expect(reader.querySelector('pre')!.textContent).toBe(retainedText)
    expect(document.querySelector('[data-evidence-key="workflow:artifact_1"]')).not.toBeNull()
    expect(document.querySelector('[data-evidence-key="agent:agent_2"]')).not.toBeNull()
  })

  it('surfaces a stale dashboard and reconciles instance authority after restart', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<main id="app"></main>'
    let instanceCalls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      // The page now probes the API once with an empty bearer to detect the tokenless default
      // profile. These suites exercise the hardened token flow, so answer that probe like a
      // hardened daemon would: 401, which routes the page to the login form the tests drive.
      const bearer = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ""
      if (bearer.trim() === "Bearer") return json({ schemaVersion: 1, error: { code: "unauthorized" } }, 401)
      if (url === '/api/v1/instance') {
        instanceCalls += 1
        if (instanceCalls === 2) throw new TypeError('daemon restarting')
        return json({
          schemaVersion: 1,
          version: instanceCalls === 1 ? '1.0.0' : '1.1.0',
          revision: (instanceCalls === 1 ? 'a' : 'b').repeat(40),
          lifecycle: 'READY',
          sourceMode: 'read-only',
          capabilities: { browserMutations: false, authoring: false },
          runtime: {
            workspace: '/workspace', mountMode: 'project-read-only',
            authentication: { mode: 'interactive', status: 'operator-check-required' },
            startedAt: instanceCalls === 1 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
            uptimeSeconds: instanceCalls === 1 ? 40 : 2,
            providerCapacity: 1,
          },
        })
      }
      if (url.startsWith('/api/v1/runs?')) return json({ schemaVersion: 1, items: [], hasMore: false })
      throw new Error(`Unexpected browser request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    vi.resetModules()
    await import('../web/src/main.js')

    const input = document.querySelector<HTMLInputElement>('#token')!
    input.value = 'web-token'
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => document.querySelector('.version')?.textContent?.includes('1.0.0') === true)

    await vi.advanceTimersByTimeAsync(4_000)
    await waitFor(() => document.querySelector('[data-role="connection-status"]')?.textContent?.includes('DISCONNECTED') === true)
    expect(document.querySelector('.version')?.textContent).toContain('1.0.0')
    expect(document.querySelector('.run-list')?.textContent).toContain('No durable runs yet')

    await vi.advanceTimersByTimeAsync(4_000)
    await waitFor(() => document.querySelector('.version')?.textContent?.includes('1.1.0') === true)
    expect(document.querySelector('[data-role="connection-status"]')?.textContent).toBe('LIVE')
    expect(document.querySelector('.version')?.textContent).toContain('up 2s')
  })

  it('marks the header disconnected when the initial inventory request fails after authentication', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<main id="app"></main>'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      // The page now probes the API once with an empty bearer to detect the tokenless default
      // profile. These suites exercise the hardened token flow, so answer that probe like a
      // hardened daemon would: 401, which routes the page to the login form the tests drive.
      const bearer = ((init?.headers ?? {}) as Record<string, string>).authorization ?? ""
      if (bearer.trim() === "Bearer") return json({ schemaVersion: 1, error: { code: "unauthorized" } }, 401)
      if (url === '/api/v1/instance') return json({
        schemaVersion: 1,
        version: '1.0.0',
        revision: 'a'.repeat(40),
        lifecycle: 'READY',
        sourceMode: 'read-only',
        capabilities: { browserMutations: false, authoring: false },
        runtime: {
          workspace: '/workspace', mountMode: 'project-read-only',
          authentication: { mode: 'interactive', status: 'operator-check-required' },
          startedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 10, providerCapacity: 1,
        },
      })
      if (url.startsWith('/api/v1/runs?')) throw new TypeError('inventory connection lost')
      throw new Error(`Unexpected browser request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    vi.resetModules()
    await import('../web/src/main.js')

    const input = document.querySelector<HTMLInputElement>('#token')!
    input.value = 'web-token'
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitFor(() => document.querySelector('[data-role="connection-status"]')?.textContent?.includes('DISCONNECTED') === true)

    expect(document.querySelector('[data-role="connection-status"]')?.textContent).toContain('RETRYING')
    expect(document.querySelector('.run-list')?.textContent).toContain('temporarily unavailable')
    // Two instance requests are correct now: the page-load tokenless probe (answered 401 by this
    // hardened mock) plus the authenticated login. The invariant under test is unchanged — the
    // failing INVENTORY path must not retrigger instance re-authentication loops.
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/instance')).toHaveLength(2)
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('DOM condition was not reached')
}
