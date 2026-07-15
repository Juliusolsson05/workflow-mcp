import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ProcessOwnedCodexHost } from '../src/processOwnedProviderHost.js'
import type { AgentProviderAttemptIdentity, AgentRequest } from '../src/agentProvider.js'

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'stubbornProviderHost.cjs',
)

describe('ProcessOwnedCodexHost', () => {
  it('reaps a host and SIGTERM-ignoring grandchild before the provider attempt settles', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'workflow-provider-tree-'))
    const pidPath = join(directory, 'grandchild.pid')
    const identity: AgentProviderAttemptIdentity = {
      runId: 'run_process_tree',
      agentId: 'agent_1',
      attemptId: 'agent_1_attempt_1',
      attemptNumber: 1,
    }
    const request: AgentRequest = {
      // The fixture uses the prompt as a data-only return channel for the grandchild PID. Real
      // provider hosts receive the same JSON-safe request shape over this protocol.
      prompt: pidPath,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }
    const host = new ProcessOwnedCodexHost({
      hostFilePath: fixture,
      codexOptions: {},
      modelAliases: {},
    })
    const execution = host.execute(request, {
      signal: new AbortController().signal,
      attempt: identity,
      emit: async () => undefined,
    })

    let grandchildPid: number | undefined
    for (let index = 0; index < 100; index += 1) {
      const value = await readFile(pidPath, 'utf8').catch(() => undefined)
      if (value !== undefined) {
        grandchildPid = Number(value)
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    expect(grandchildPid).toBeTypeOf('number')

    await host.terminateAttempt(identity, { code: 'timeout', message: 'fixture timeout' })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => process.kill(grandchildPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }, 15_000)

  it('pins a private Codex home and copies authentication before spawning the attempt', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'workflow-provider-config-'))
    const pidPath = join(directory, 'grandchild.pid')
    const codexHome = join(directory, 'codex-home')
    const authenticationFile = join(directory, 'source-auth.json')
    await writeFile(authenticationFile, '{"tokens":{"access_token":"fixture"}}', 'utf8')
    const identity: AgentProviderAttemptIdentity = {
      runId: 'run_configuration_isolation',
      agentId: 'agent_1',
      attemptId: 'agent_1_attempt_1',
      attemptNumber: 1,
    }
    const host = new ProcessOwnedCodexHost({
      hostFilePath: fixture,
      codexOptions: { env: { PATH: process.env.PATH ?? '' } },
      modelAliases: {},
      configurationIsolation: { codexHome, authenticationFile },
    })
    const execution = host.execute({
      prompt: pidPath,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }, {
      signal: new AbortController().signal,
      attempt: identity,
      emit: async () => undefined,
    })

    let options: { env?: Record<string, string> } | undefined
    for (let index = 0; index < 100; index += 1) {
      const serialized = await readFile(`${pidPath}.options.json`, 'utf8').catch(() => undefined)
      if (serialized !== undefined) {
        options = JSON.parse(serialized) as { env?: Record<string, string> }
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }

    expect(options?.env).toMatchObject({ CODEX_HOME: codexHome })
    expect(await readFile(join(codexHome, 'auth.json'), 'utf8')).toContain('fixture')
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain('apps = false')
    expect(config).toContain('multi_agent = false')

    await host.terminateAttempt(identity, { code: 'shutdown', message: 'test complete' })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
  }, 15_000)
})
