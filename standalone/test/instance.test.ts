import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  adoptInstanceRecord,
  createHostDoctorEnvelope,
  createInstanceRecord,
  hashDockerDaemonIdentity,
  hashProjectIdentity,
  parseInstanceRecord,
  replaceInstanceImage,
  renderCodexMcpConfiguration,
  renderPosixInstanceEnvironment,
} from '../src/instance/record.js'

const DOCKER_DAEMON_FINGERPRINT = 'a'.repeat(64)

describe('installation instance identity', () => {
  it('binds Compose and Codex configuration to one canonical project identity', () => {
    const record = createInstanceRecord({
      projectDirectory: '/projects/example',
      dockerContext: 'desktop-linux',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'docker.io/example/workflow-mcp@sha256:abc',
      webPort: 7331,
    })
    expect(parseInstanceRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const config = renderCodexMcpConfiguration(record, '/projects/example/.workflow-mcp/compose.yaml')
    expect(config).toContain('command = "/projects/example/.workflow-mcp/workflow-mcp-docker"')
    expect(config).toContain('args = ["mcp-proxy"]')
    expect(config).toContain('cwd = "/projects/example"')
    expect(config).not.toContain('required = true')
    expect(replaceInstanceImage(record, 'docker.io/example/workflow-mcp:0.2.0')).toEqual({
      ...record,
      image: 'docker.io/example/workflow-mcp:0.2.0',
    })
  })

  it('rejects copied or hand-edited identity fields', () => {
    const record = createInstanceRecord({
      projectDirectory: '/projects/one',
      dockerContext: 'default',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'workflow-mcp:test',
    })
    expect(() => parseInstanceRecord({ ...record, projectDirectory: '/projects/two' })).toThrow(/hash/)
    expect(() => parseInstanceRecord({ ...record, composeProjectName: 'workflow-mcp-wrong' })).toThrow()
    expect(() => parseInstanceRecord({ ...record, dockerDaemonFingerprint: 'wrong-engine' })).toThrow(/invalid/)
    expect(() => parseInstanceRecord({
      ...record,
      instanceId: '11111111-2222-1333-8444-555555555555',
      composeProjectName: 'workflow-mcp-1111111122221333',
    })).toThrow(/invalid/)
  })

  it('reconstructs only the exact preserved UUID identity during adoption', () => {
    const record = adoptInstanceRecord({
      instanceId: '11111111-2222-4333-8444-555555555555',
      projectDirectory: '/projects/one',
      dockerContext: 'default',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'workflow-mcp:test',
    })
    expect(record.composeProjectName).toBe('workflow-mcp-1111111122224333')
    expect(record.instanceId).toBe('11111111-2222-4333-8444-555555555555')
    expect(hashDockerDaemonIdentity('engine-one')).not.toBe(hashDockerDaemonIdentity('engine-two'))
    expect(() => adoptInstanceRecord({
      ...record,
      instanceId: '11111111-2222-1333-8444-555555555555',
    })).toThrow(/UUIDv4/)
  })

  it('treats canonical Windows drive paths as host absolutes inside the Linux image', () => {
    const record = createInstanceRecord({
      projectDirectory: 'c:/Users/Example/Project/',
      dockerContext: 'desktop-linux',
      dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'example/workflow-mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      apiKeyFile: 'C:\\Users\\Example\\Secrets\\openai-key',
    })
    expect(record.projectDirectory).toBe('C:\\Users\\Example\\Project')
    expect(record.apiKeyFile).toBe('C:\\Users\\Example\\Secrets\\openai-key')
    expect(hashProjectIdentity('C:\\USERS\\EXAMPLE\\PROJECT')).toBe(record.projectHash)
    expect(parseInstanceRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const config = renderCodexMcpConfiguration(record, 'C:\\Users\\Example\\Project\\.workflow-mcp\\compose.yaml')
    expect(config).toContain('command = "pwsh"')
    expect(config).toContain('"-NonInteractive", "-File", "C:\\\\Users\\\\Example\\\\Project\\\\.workflow-mcp\\\\workflow-mcp-docker.ps1", "mcp-proxy"')
    expect(() => createInstanceRecord({
      projectDirectory: '\\\\server\\share\\project',
      dockerContext: 'desktop-linux',
      dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'example/workflow-mcp:1.0.0',
    })).toThrow(/must be absolute/)
  })

  it('refuses to render a Codex stanza for a different Compose policy file', () => {
    const record = createInstanceRecord({
      projectDirectory: '/projects/example',
      dockerContext: 'default',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'example/workflow-mcp:1.0.0',
    })
    expect(() => renderCodexMcpConfiguration(record, '/tmp/compose.yaml')).toThrow(/project-scoped/)
  })

  it('renders validated instance fields as inert POSIX assignments', () => {
    const record = createInstanceRecord({
      projectDirectory: "/projects/operator's project",
      dockerContext: 'default',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'workflow-mcp:test',
      apiKeyFile: "/secrets/operator's key",
    })
    const output = renderPosixInstanceEnvironment(record)
    expect(output).toContain("api_key_file='/secrets/operator'\\''s key'")
    expect(output).not.toContain('$((')
    expect(output).toContain(`recorded_daemon_fingerprint='${DOCKER_DAEMON_FINGERPRINT}'`)
    expect(output.split('\n')).toHaveLength(13)
    expect(output).toContain("hardened='false'")
    expect(output).toContain("host_codex_auth='false'")
  })

  it('combines attested host and container diagnostics into one versioned report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-mcp-doctor-'))
    const record = createInstanceRecord({
      projectDirectory: '/projects/example',
      dockerContext: 'desktop-linux',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerDaemonFingerprint: DOCKER_DAEMON_FINGERPRINT,
      image: 'workflow-mcp:test',
    })
    const instanceFile = join(directory, 'instance.json')
    const containerReportFile = join(directory, 'container.json')
    await writeFile(instanceFile, JSON.stringify(record))
    await writeFile(containerReportFile, JSON.stringify({
      schemaVersion: 1,
      ok: true,
      version: '0.1.0',
      revision: 'abc',
      dependencies: { codexSdk: '1', mcpSdk: '1' },
      checks: [{ id: 'platform', status: 'pass', message: 'Linux arm64' }],
    }))
    const envelope = await createHostDoctorEnvelope({
      instanceFile,
      containerReportFile,
      platform: 'posix',
      hostDescription: 'Darwin-arm64',
      dockerClientVersion: '27.5.1',
      dockerServerVersion: '28.3.3',
      composeVersion: '2.32.0',
      dockerContext: record.dockerContext,
      dockerEndpoint: record.dockerEndpoint,
      dockerDaemonFingerprint: record.dockerDaemonFingerprint,
      volumeDriver: 'local',
      volumeOptions: 'null',
      volumeInstanceLabel: record.instanceId,
      volumeProjectLabel: record.projectHash,
      volumeDaemonLabel: record.dockerDaemonFingerprint,
    })
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      host: {
        status: 'runtime-compatible',
        platform: 'posix',
        docker: { endpoint: { kind: 'local-unix', fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/) } },
      },
      container: { schemaVersion: 1, ok: true },
      identityVerdict: { ok: true, instanceId: record.instanceId },
    })
    expect(JSON.stringify(envelope)).not.toContain(record.dockerEndpoint)
    await expect(createHostDoctorEnvelope({
      instanceFile,
      containerReportFile,
      platform: 'posix',
      hostDescription: 'Linux-x86_64',
      dockerClientVersion: '27.5.1',
      dockerServerVersion: '28.3.3',
      composeVersion: '2.32.0',
      dockerContext: record.dockerContext,
      dockerEndpoint: record.dockerEndpoint,
      dockerDaemonFingerprint: record.dockerDaemonFingerprint,
      volumeDriver: 'local',
      volumeOptions: 'null',
      volumeInstanceLabel: 'wrong-instance',
      volumeProjectLabel: record.projectHash,
      volumeDaemonLabel: record.dockerDaemonFingerprint,
    })).rejects.toThrow(/labels/)
  })
})
