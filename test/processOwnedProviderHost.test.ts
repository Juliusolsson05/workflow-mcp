import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
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

    // A provider turn may rotate its refresh token. Starting another attempt must preserve that
    // newer isolated state instead of restoring the stale interactive seed.
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    await writeFile(join(codexHome, 'auth.json'), '{"tokens":{"refresh_token":"rotated"}}', 'utf8')
    const secondIdentity = { ...identity, attemptId: 'agent_1_attempt_2', attemptNumber: 2 }
    const secondExecution = host.execute({
      prompt: `${pidPath}-second`,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }, {
      signal: new AbortController().signal,
      attempt: secondIdentity,
      emit: async () => undefined,
    })
    await expect.poll(() => readFile(`${pidPath}-second.options.json`, 'utf8').then(Boolean).catch(() => false)).toBe(true)
    expect(await readFile(join(codexHome, 'auth.json'), 'utf8')).toContain('rotated')
    await host.terminateAttempt(secondIdentity, { code: 'shutdown', message: 'test complete' })
    await expect(secondExecution).rejects.toMatchObject({ name: 'AbortError' })

    // Deleting the source is the integration's durable logout signal. The private workflow copy
    // must not silently retain access after that transition.
    await unlink(authenticationFile)
    const thirdIdentity = { ...identity, attemptId: 'agent_1_attempt_3', attemptNumber: 3 }
    const thirdExecution = host.execute({
      prompt: `${pidPath}-third`,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }, {
      signal: new AbortController().signal,
      attempt: thirdIdentity,
      emit: async () => undefined,
    })
    await expect.poll(() => readFile(`${pidPath}-third.options.json`, 'utf8').then(Boolean).catch(() => false)).toBe(true)
    await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await host.terminateAttempt(thirdIdentity, { code: 'shutdown', message: 'test complete' })
    await expect(thirdExecution).rejects.toMatchObject({ name: 'AbortError' })
  }, 15_000)

  it('imports only the requested historical rollout before resuming inside the isolated home', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'workflow-provider-session-import-'))
    const pidPath = join(directory, 'grandchild.pid')
    const codexHome = join(directory, 'isolated-codex-home')
    const sessionSourceHome = join(directory, 'interactive-codex-home')
    const sessionId = '019f6779-28a1-7360-bffa-f4c8d13e313a'
    const relativeRollout = join('2026', '07', '15', `rollout-incident-${sessionId}.jsonl`)
    await mkdir(join(sessionSourceHome, 'sessions', '2026', '07', '15'), { recursive: true })
    await writeFile(join(sessionSourceHome, 'sessions', relativeRollout), '{"type":"session_meta"}\n')
    const identity: AgentProviderAttemptIdentity = {
      runId: 'run_session_import',
      agentId: 'agent_47',
      attemptId: 'agent_47_attempt_2',
      attemptNumber: 2,
    }
    const host = new ProcessOwnedCodexHost({
      hostFilePath: fixture,
      codexOptions: { env: { PATH: process.env.PATH ?? '' } },
      modelAliases: {},
      configurationIsolation: { codexHome, sessionSourceHome },
    })
    const request: AgentRequest = {
      prompt: pidPath,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
      session: { provider: 'codex', id: sessionId },
      recovery: {
        reason: 'application restart',
        previousAttemptNumber: 1,
        lastProgressAt: '2026-07-15T20:39:32.000Z',
        note: 'Continue safely.',
      },
    }
    const execution = host.execute(request, {
      signal: new AbortController().signal,
      attempt: identity,
      emit: async () => undefined,
    }, { allowFreshSessionFallback: true })

    let hostedRequest: AgentRequest | undefined
    for (let index = 0; index < 100; index += 1) {
      const serialized = await readFile(`${pidPath}.request.json`, 'utf8').catch(() => undefined)
      if (serialized !== undefined) {
        hostedRequest = JSON.parse(serialized) as AgentRequest
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }

    expect(hostedRequest?.session).toEqual({ provider: 'codex', id: sessionId })
    expect(await readFile(join(codexHome, 'sessions', relativeRollout), 'utf8'))
      .toContain('session_meta')

    await host.terminateAttempt(identity, { code: 'shutdown', message: 'test complete' })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
  }, 15_000)

  it('starts a fresh thread only when an unavailable session is explicitly replay-safe', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp(join(tmpdir(), 'workflow-provider-session-fallback-'))
    const pidPath = join(directory, 'grandchild.pid')
    const identity: AgentProviderAttemptIdentity = {
      runId: 'run_session_fallback',
      agentId: 'agent_1',
      attemptId: 'agent_1_attempt_2',
      attemptNumber: 2,
    }
    const host = new ProcessOwnedCodexHost({
      hostFilePath: fixture,
      codexOptions: { env: { PATH: process.env.PATH ?? '' } },
      modelAliases: {},
      configurationIsolation: {
        codexHome: join(directory, 'isolated-codex-home'),
        sessionSourceHome: join(directory, 'empty-source-home'),
      },
    })
    const execution = host.execute({
      prompt: pidPath,
      workingDirectory: directory,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
      session: { provider: 'codex', id: 'missing-session' },
      recovery: {
        reason: 'historical resume',
        previousAttemptNumber: 1,
        lastProgressAt: '2026-07-15T20:39:32.000Z',
        note: 'Continue safely.',
      },
    }, {
      signal: new AbortController().signal,
      attempt: identity,
      emit: async () => undefined,
    }, { allowFreshSessionFallback: true })

    let hostedRequest: AgentRequest | undefined
    for (let index = 0; index < 100; index += 1) {
      const serialized = await readFile(`${pidPath}.request.json`, 'utf8').catch(() => undefined)
      if (serialized !== undefined) {
        hostedRequest = JSON.parse(serialized) as AgentRequest
        break
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }

    expect(hostedRequest?.session).toBeUndefined()
    expect(hostedRequest?.prompt).toBe(pidPath)
    expect(hostedRequest?.recovery?.reason).toContain('recorded Codex session missing-session was unavailable')

    await host.terminateAttempt(identity, { code: 'shutdown', message: 'test complete' })
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
  }, 15_000)
})
