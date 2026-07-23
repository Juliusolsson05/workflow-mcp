import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { StandaloneAdminClient } from '../src/admin/client.js'
import { createStandaloneApplication, providerCredentialEnvironment } from '../src/daemon/application.js'
import { CodexCredentialBroker } from '../src/daemon/auth.js'
import { startStandaloneDaemon } from '../src/daemon/lifecycle.js'
import { hashProjectIdentity } from '../src/instance/record.js'

describe('Codex credential broker', () => {
  it('validates file and environment credential modes before provider readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-provider-credential-'))
    const keyFile = join(root, 'openai-key')
    await writeFile(keyFile, 'not-a-live-key\n', { mode: 0o600 })
    await expect(providerCredentialEnvironment({
      WORKFLOW_MCP_OPENAI_API_KEY_FILE: keyFile,
    })).resolves.toEqual({ WORKFLOW_MCP_OPENAI_API_KEY_FILE: keyFile })
    await expect(providerCredentialEnvironment({ OPENAI_API_KEY: 'not-a-live-key' }))
      .resolves.toEqual({ OPENAI_API_KEY: 'not-a-live-key' })
    await expect(providerCredentialEnvironment({
      WORKFLOW_MCP_OPENAI_API_KEY_FILE: keyFile,
      OPENAI_API_KEY: 'ambiguous',
    })).rejects.toMatchObject({ code: 'auth-mode-conflict' })
    await writeFile(keyFile, '\n', { mode: 0o600 })
    await expect(providerCredentialEnvironment({
      WORKFLOW_MCP_OPENAI_API_KEY_FILE: keyFile,
    })).rejects.toMatchObject({ code: 'authentication-failed' })
  })

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
      concurrency: 1,
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
      concurrency: 1,
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

  it('never blocks container login behind an inherited host credential', async () => {
    // REGRESSION: inheritance used to refuse `auth login` with auth-mode-conflict. Combined with a
    // status that called a merely-readable seed "configured", an operator whose host ChatGPT login
    // could not drive the containerized Codex was left with a READY daemon, agents dying on EPIPE,
    // and the one command that fixes it rejected. Login must always be reachable, and an inherited
    // credential must never be reported authenticated without Codex actually accepting it.
    const root = await mkdtemp(join(tmpdir(), 'workflow-host-auth-override-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const seed = join(root, 'host-auth.json')
    await writeFile(seed, '{"tokens":{"access_token":"seed"}}\n')
    // A Codex that rejects everything models the real defect: the inherited seed is present and
    // readable, yet the containerized Codex cannot authenticate with it.
    const executable = join(root, 'fake-codex')
    await writeFile(executable, `#!/bin/sh
printf 'not logged in\\n' >&2
exit 1
`)
    await chmod(executable, 0o700)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      profile: 'default',
      sourceMode: 'authoring',
      approvalMode: 'none',
      webAuthMode: 'none',
      hostCodexAuthFile: seed,
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: executable,
      webEnabled: false,
      concurrency: 1,
    })
    const application = await createStandaloneApplication(config, { provider: new FakeAgentProvider([]) })
    const broker = new CodexCredentialBroker({
      service: application.service,
      codexExecutable: config.codexExecutable,
      dataDirectory: config.dataDirectory,
      apiKeySecret: false,
      hostCodexAuthFile: seed,
    })
    // The seed exists and is readable, but Codex cannot authenticate with it: status must report
    // host-codex mode as UNauthenticated rather than trusting file presence.
    expect(await broker.status()).toMatchObject({ mode: 'host-codex', authenticated: false })
    // And login must be ATTEMPTED rather than refused as a mode conflict. It fails here only
    // because the fake Codex rejects it; the point is that it is never blocked.
    await expect(broker.login(() => {})).rejects.toMatchObject({ code: 'authentication-failed' })
    await application.quiesce('host auth override test complete')
  })

  it('excludes concurrent auth commands and workflow starts for the whole credential process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-auth-exclusive-'))
    const workspace = join(root, 'workspace')
    const workflows = join(workspace, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'instant.js'), `export const meta = {
      name: 'instant', description: 'Must stay behind credential admission'
    }
    return 'done'`)
    const entered = join(root, 'entered')
    const release = join(root, 'release')
    const executable = join(root, 'fake-codex')
    await writeFile(executable, `#!/bin/sh
if [ "$1:$2" = login:--device-auth ]; then
  : > ${JSON.stringify(entered)}
  while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done
  exit 0
fi
exit 0
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
      concurrency: 1,
    })
    const application = await createStandaloneApplication(config, { provider: new FakeAgentProvider([]) })
    const broker = new CodexCredentialBroker({
      service: application.service,
      codexExecutable: executable,
      dataDirectory: config.dataDirectory,
      apiKeySecret: false,
    })
    const login = broker.login(() => undefined)
    await waitForFile(entered)
    await expect(broker.login(() => undefined)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(broker.logout()).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(application.service.start({ cwd: workspace }, { name: 'instant' }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await writeFile(release, '')
    await login
    await application.quiesce('exclusive auth test complete')
  })

  it.each([
    ['status', (client: StandaloneAdminClient) => client.authStatus()],
    ['logout', (client: StandaloneAdminClient) => client.logout()],
  ] as const)('cancels a hung auth %s process before daemon shutdown completes', async (_name, invoke) => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-auth-shutdown-'))
    const workspace = join(root, 'workspace')
    const entered = join(root, 'entered')
    const terminated = join(root, 'terminated')
    const executable = join(root, 'fake-codex')
    await mkdir(workspace)
    await writeFile(executable, `#!/bin/sh
# WHY: The direct command acknowledges TERM but its grandchild deliberately ignores it while
# retaining inherited stdout/stderr. Direct-PID cancellation appears successful in exit-based
# tests yet leaves Node waiting forever for close; this fixture exercises the actual process-group
# and bounded-pipe-reap contract for both non-streaming authentication routes.
(trap '' TERM INT; while :; do sleep 1; done) &
trap ': > ${JSON.stringify(terminated)}; exit 143' TERM INT
: > ${JSON.stringify(entered)}
while :; do sleep 0.05; done
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
      concurrency: 1,
    })
    const daemon = await startStandaloneDaemon(config, { provider: new FakeAgentProvider([]) })
    const client = new StandaloneAdminClient({
      socketPath: config.adminSocketPath,
      token: daemon.tokens.admin,
    })
    const outcome = invoke(client).then(
      value => ({ value }),
      error => ({ error }),
    )
    await waitForFile(entered)
    const before = Date.now()
    await daemon.close('auth cancellation test')
    // The application lease monitor has its own bounded poll teardown, so the daemon as a whole may
    // take a few seconds after Codex has exited. The release contract is that it completes inside
    // Docker's ten-second stop grace period instead of waiting forever on the admin socket.
    expect(Date.now() - before).toBeLessThan(7_000)
    expect(await outcome).toHaveProperty('error')
    await waitForFile(terminated)
  })

  it('redacts unexpected authenticated admin errors without trusting arbitrary error codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-admin-redaction-'))
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
      concurrency: 1,
    })
    const daemon = await startStandaloneDaemon(config, {
      provider: new FakeAgentProvider([]),
      environment: { OPENAI_API_KEY: 'test-secret-mode' },
    })
    const client = new StandaloneAdminClient({
      socketPath: config.adminSocketPath,
      token: daemon.tokens.admin,
    })
    const originalList = daemon.application.sourceApprovals.list.bind(daemon.application.sourceApprovals)
    const privateDetail = 'OPENAI_API_KEY=admin-leak /data/private/credential'
    Object.defineProperty(daemon.application.sourceApprovals, 'list', {
      configurable: true,
      value: () => { throw Object.assign(new Error(privateDetail), { code: 'hostile-/data-code' }) },
    })
    try {
      await expect(client.sourceApprovals()).rejects.toMatchObject({
        code: 'internal-error',
        message: 'Workflow MCP could not complete the request.',
      })
    } finally {
      Object.defineProperty(daemon.application.sourceApprovals, 'list', {
        configurable: true,
        value: originalList,
      })
      await daemon.close('admin redaction test complete')
    }
  })
})

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${path}`)
}
