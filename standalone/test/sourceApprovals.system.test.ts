import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { createStandaloneApplication } from '../src/daemon/application.js'
import { approveVisibleWorkflow, SourceApprovalStore } from '../src/daemon/sourceApprovals.js'
import { hashProjectIdentity } from '../src/instance/record.js'

describe('durable source approvals', () => {
  it('authorizes exact post-startup bytes only for the bound project identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-source-approvals-'))
    const workspace = join(root, 'workspace')
    const workflowDirectory = join(workspace, '.claude', 'workflows')
    await mkdir(join(workspace, '.git'), { recursive: true })
    await mkdir(workflowDirectory, { recursive: true })
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'authoring',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
      concurrency: 1,
    })
    let application = await createStandaloneApplication(config, {
      provider: new FakeAgentProvider([]),
    })
    const sourcePath = join(workflowDirectory, 'later.js')
    await writeFile(sourcePath, `export const meta = {
      name: 'later', description: 'Created after the review boundary'
    }
    return 'approved result'`)

    await expect(application.service.start({ cwd: workspace }, { name: 'later' }))
      .rejects.toMatchObject({ code: 'source-approval-required' })
    await application.quiesce('prove unapproved source survives no restart shortcut')
    application = await createStandaloneApplication(config, {
      provider: new FakeAgentProvider([]),
    })
    // Authoring can persist this file itself. Restart must never reinterpret mere visibility as
    // operator review, or an untrusted workflow could authorize itself without the hash ceremony.
    await expect(application.service.start({ cwd: workspace }, { name: 'later' }))
      .rejects.toMatchObject({ code: 'source-approval-required' })
    const described = await application.service.describe({ cwd: workspace }, { name: 'later' })
    await expect(approveVisibleWorkflow({
      service: application.service,
      approvals: application.sourceApprovals,
      workspace,
      workflowName: 'later',
      expectedSourceHash: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'source-changed' })

    const approval = await approveVisibleWorkflow({
      service: application.service,
      approvals: application.sourceApprovals,
      workspace,
      workflowName: 'later',
      expectedSourceHash: described.sourceHash,
    })
    expect(JSON.stringify(approval)).not.toContain(workspace)
    expect(application.sourceApprovals.list()).toEqual([approval])
    const started = await application.service.start({ cwd: workspace }, { name: 'later' })
    let status = await application.service.status({ cwd: workspace }, started.runId)
    while (status.status === 'queued' || status.status === 'running') {
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
      status = await application.service.status({ cwd: workspace }, started.runId)
    }
    expect(status.status).toBe('completed')

    await writeFile(sourcePath, `export const meta = {
      name: 'later', description: 'Same identity with edited bytes'
    }
    return 'edited result'`)
    await expect(application.service.start({ cwd: workspace }, { name: 'later' }))
      .rejects.toMatchObject({ code: 'source-approval-required' })
    await application.quiesce('prove edited approval remains revoked after restart')
    application = await createStandaloneApplication(config, {
      provider: new FakeAgentProvider([]),
    })
    // Durable approval binds exact bytes. A process restart cannot turn an edited hash back into
    // authority just because the changed file was present during startup discovery.
    await expect(application.service.start({ cwd: workspace }, { name: 'later' }))
      .rejects.toMatchObject({ code: 'source-approval-required' })

    const otherProject = new SourceApprovalStore(config.dataDirectory, 'f'.repeat(64))
    otherProject.initialize()
    const edited = await application.service.describe({ cwd: workspace }, { name: 'later' })
    expect(otherProject.isApproved(edited.filePath, described.sourceHash)).toBe(false)
    expect(otherProject.list()).toEqual([])
    await application.quiesce('approval test complete')
  })
})
