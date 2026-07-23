import { describe, expect, it } from 'vitest'

import { loadStandaloneConfig } from '../src/config/loadConfig.js'

describe('standalone configuration', () => {
  it('creates one immutable absolute-path configuration', () => {
    const config = loadStandaloneConfig({
      workspace: '/workspace/project',
      'data-dir': '/data/instance',
      host: '0.0.0.0',
      port: '7444',
      web: 'true',
      lease: 'embedded',
    }, { WORKFLOW_MCP_CODEX_PATH: '/opt/codex' })
    expect(config).toMatchObject({
      workspace: '/workspace/project',
      projectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      dataDirectory: '/data/instance',
      host: '0.0.0.0',
      port: 7444,
      webEnabled: true,
      concurrency: 1,
      leaseMode: 'embedded',
      adminSocketPath: '/data/instance/.coordination/admin.sock',
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('rejects relative mounts and unsupported listeners', () => {
    expect(() => loadStandaloneConfig({ workspace: 'relative' }, {
      WORKFLOW_MCP_LEASE_MODE: 'embedded',
    })).toThrow(/absolute path/)
    expect(() => loadStandaloneConfig({
      workspace: '/workspace',
      host: '192.0.2.1',
    }, { WORKFLOW_MCP_LEASE_MODE: 'embedded' })).toThrow(/127\.0\.0\.1 or 0\.0\.0\.0/)
  })

  it('derives the posture from one profile bit while keeping per-subsystem overrides', () => {
    // The whole consumer-simplification contract in miniature: `default` must mean authoring,
    // no approvals, tokenless web; `hardened` must restore the original shipped posture from the
    // same single input; and an explicit env override must still beat either derivation.
    const consumer = loadStandaloneConfig({}, { WORKFLOW_MCP_LEASE_MODE: 'embedded' })
    expect(consumer).toMatchObject({
      profile: 'default',
      sourceMode: 'authoring',
      approvalMode: 'none',
      webAuthMode: 'none',
    })
    const hardened = loadStandaloneConfig({}, {
      WORKFLOW_MCP_LEASE_MODE: 'embedded',
      WORKFLOW_MCP_PROFILE: 'hardened',
    })
    expect(hardened).toMatchObject({
      profile: 'hardened',
      sourceMode: 'read-only',
      approvalMode: 'required',
      webAuthMode: 'token',
    })
    const overridden = loadStandaloneConfig({}, {
      WORKFLOW_MCP_LEASE_MODE: 'embedded',
      WORKFLOW_MCP_PROFILE: 'hardened',
      WORKFLOW_MCP_SOURCE_MODE: 'authoring',
    })
    expect(overridden.sourceMode).toBe('authoring')
    expect(overridden.approvalMode).toBe('required')
    expect(() => loadStandaloneConfig({}, {
      WORKFLOW_MCP_LEASE_MODE: 'embedded',
      WORKFLOW_MCP_CODEX_AUTH_FILE: 'relative/auth.json',
    })).toThrow(/absolute/)
  })
})
