import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  inspectResourceProfile,
  requireSupportedResourceProfile,
} from '../src/daemon/resourceProfile.js'

describe('container resource profile', () => {
  it('derives exact concurrency guidance from cgroup v2 limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-resource-profile-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'memory.max'), String(4 * 1024 * 1024 * 1024))
    await writeFile(join(root, 'cpu.max'), '200000 100000\n')
    await expect(inspectResourceProfile({ concurrency: 2 }, root)).resolves.toMatchObject({
      concurrency: 2,
      requiredMemoryBytes: 3 * 1024 * 1024 * 1024,
      requiredCpuCores: 2,
      memoryLimitBytes: 4 * 1024 * 1024 * 1024,
      cpuLimitCores: 2,
    })
    await expect(requireSupportedResourceProfile({ concurrency: 2 }, root)).resolves.toBeDefined()
    await expect(requireSupportedResourceProfile({ concurrency: 3 }, root))
      .rejects.toMatchObject({ code: 'resource-profile-unsupported' })
  })
})
