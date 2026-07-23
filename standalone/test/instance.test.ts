import { describe, expect, it } from 'vitest'

import {
  createInstanceRecord,
  parseInstanceRecord,
  renderCodexMcpConfiguration,
} from '../src/instance/record.js'

describe('installation instance identity', () => {
  it('binds Compose and Codex configuration to one canonical project identity', () => {
    const record = createInstanceRecord({
      projectDirectory: '/projects/example',
      dockerContext: 'desktop-linux',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      image: 'docker.io/example/workflow-mcp@sha256:abc',
      webPort: 7331,
    })
    expect(parseInstanceRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const config = renderCodexMcpConfiguration(record, '/projects/example/.workflow-mcp/compose.yaml')
    expect(config).toContain(`-p", "${record.composeProjectName}`)
    expect(config).toContain('"exec", "-T", "workflow-mcp", "workflow-mcp", "mcp-proxy"')
    expect(config).toContain('cwd = "/projects/example"')
    expect(config).not.toContain('required = true')
  })

  it('rejects copied or hand-edited identity fields', () => {
    const record = createInstanceRecord({
      projectDirectory: '/projects/one',
      dockerContext: 'default',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      image: 'workflow-mcp:test',
    })
    expect(() => parseInstanceRecord({ ...record, projectDirectory: '/projects/two' })).toThrow(/hash/)
    expect(() => parseInstanceRecord({ ...record, composeProjectName: 'workflow-mcp-wrong' })).toThrow()
  })
})
