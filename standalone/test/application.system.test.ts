import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { createStandaloneApplication } from '../src/daemon/application.js'
import { inspectContainer } from '../src/daemon/health.js'
import { hashProjectIdentity } from '../src/instance/record.js'

describe('standalone application', () => {
  it('uses the documented unavailable exit code for a refused health connection', async () => {
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const address = reservation.address()
    if (address === null || typeof address === 'string') throw new Error('test port reservation failed')
    await new Promise<void>((resolve, reject) => reservation.close(error => error === undefined ? resolve() : reject(error)))
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)),
      'healthcheck', `--port=${address.port}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
    expect(code).toBe(3)
    expect(stderr).toContain('fetch failed')
  })

  it('accepts the documented option-first OCI STDIO command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-standalone-cli-'))
    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, '.claude', 'workflows'), { recursive: true })
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../dist/cli/main.js', import.meta.url)),
      'serve', '--stdio', workspace, `--data-dir=${join(root, 'data')}`,
    ], {
      // The standalone default is the image-internal isolation wrapper. This parser/lifecycle test
      // runs on the host and never starts a provider, so give configuration an existing executable
      // without weakening the production default or making the test depend on a Codex install.
      env: { ...process.env, WORKFLOW_MCP_CODEX_PATH: process.execPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    expect(exit).toEqual({ code: 0, signal: null })
    expect(stderr).toContain('session-bound STDIO mode')
  })

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
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 7331,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
      concurrency: 1,
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
    const doctor = await inspectContainer(config)
    expect(doctor.checks).toContainEqual(expect.objectContaining({
      id: 'data-fsync',
      status: 'pass',
      message: expect.stringContaining('fenced owner proved file fsync'),
    }))
    await application.quiesce('test complete')
    expect(application.service.lifecycleState()).toBe('STOPPED')
  })
})
