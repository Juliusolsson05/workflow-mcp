import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { createStandaloneApplication } from '../src/daemon/application.js'

describe('standalone application', () => {
  it('runs through the public core API and quiesces without a second owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-standalone-'))
    const workspace = join(root, 'workspace')
    const workflows = join(workspace, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'inspect.js'), `export const meta = {
      name: 'inspect', description: 'Standalone public API fixture'
    }
    return 'complete'`)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 7331,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
    })
    const application = await createStandaloneApplication(config, {
      provider: new FakeAgentProvider([]),
    })
    const started = await application.service.start({ cwd: workspace }, { name: 'inspect' })
    let status = await application.service.status({ cwd: workspace }, started.runId)
    while (status.status === 'queued' || status.status === 'running') {
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
      status = await application.service.status({ cwd: workspace }, started.runId)
    }
    expect(status.status).toBe('completed')
    expect((await application.service.listRuns({ limit: 10 })).items).toEqual([
      expect.objectContaining({ runId: started.runId, status: 'completed' }),
    ])
    await application.quiesce('test complete')
    expect(application.service.lifecycleState()).toBe('STOPPED')
  })
})
