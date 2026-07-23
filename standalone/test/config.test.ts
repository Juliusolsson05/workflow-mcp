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
})
