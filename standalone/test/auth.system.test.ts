import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { createStandaloneApplication } from '../src/daemon/application.js'
import { CodexCredentialBroker } from '../src/daemon/auth.js'
import { hashProjectIdentity } from '../src/instance/record.js'

describe('Codex credential broker', () => {
  it('streams device login and refuses credential mutation behind an active run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-auth-broker-'))
    const workspace = join(root, 'workspace')
    const workflows = join(workspace, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'wait.js'), `export const meta = {
      name: 'wait', description: 'Keep provider ownership active'
    }
    return await agent('wait')`)
    const executable = join(root, 'fake-codex')
    await writeFile(executable, `#!/bin/sh
case "$1:$2" in
  login:status) printf 'Logged in using test credentials\\n' ;;
  login:--device-auth) printf 'Open https://example.invalid/device and enter TEST-CODE\\n' ;;
  logout:) : ;;
  *) exit 9 ;;
esac
`)
    await chmod(executable, 0o700)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: executable,
      webEnabled: false,
    })
    const application = await createStandaloneApplication(config, {
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    const broker = new CodexCredentialBroker({
      service: application.service,
      codexExecutable: executable,
      dataDirectory: config.dataDirectory,
      apiKeySecret: false,
    })
    expect(await broker.status()).toMatchObject({ authenticated: true, mode: 'interactive' })
    const output: string[] = []
    await broker.login((_stream, text) => output.push(text))
    expect(output.join('')).toContain('TEST-CODE')

    const started = await application.service.start({ cwd: workspace }, { name: 'wait' })
    await expect(broker.logout()).rejects.toMatchObject({ code: 'auth-busy' })
    await application.service.cancel({ cwd: workspace }, started.runId, 'auth broker test')
    await broker.logout()
    await application.quiesce('auth test complete')
  })

  it('reports but never mutates a host-managed API-key secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-api-key-auth-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
    })
    const application = await createStandaloneApplication(config, { provider: new FakeAgentProvider([]) })
    const broker = new CodexCredentialBroker({
      service: application.service,
      codexExecutable: config.codexExecutable,
      dataDirectory: config.dataDirectory,
      apiKeySecret: true,
    })
    expect(await broker.status()).toMatchObject({ authenticated: true, mode: 'api-key-secret' })
    await expect(broker.logout()).rejects.toMatchObject({ code: 'auth-mode-conflict' })
    await application.quiesce('api key auth test complete')
  })
})
