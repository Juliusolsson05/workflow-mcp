import { constants, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { InheritedFlockLeaseBackend } from '../src/inheritedFlockLeaseBackend.js'
import { WorkflowService } from '../src/workflowService.js'

describe('inherited flock pathname monitor', () => {
  it.skipIf(process.platform !== 'linux')(
    'fails an idle old owner after the lock pathname is replaced and a new generation starts',
    async () => {
      const data = await mkdtemp(join(tmpdir(), 'workflow-inherited-flock-drift-'))
      const storeRoot = join(data, 'store')
      const lockPath = join(data, '.coordination', 'owner.lock')
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
      mkdirSync(storeRoot, { recursive: true, mode: 0o700 })
      writeFileSync(lockPath, '', { mode: 0o600 })

      // Production obtains these descriptors from workflow-mcp-lock after flock(2). This focused
      // backend regression deliberately starts at the exec handoff and does *not* claim to test
      // kernel acquisition: two distinct open descriptions and a real unlink/recreate isolate the
      // pathname/inode ABA owned by the TypeScript monitor. The final-image container smoke runs
      // the complementary two-generation scenario through the native flock launcher itself.
      const firstDescriptor = openSync(
        lockPath,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CLOEXEC,
      )
      const first = new WorkflowService({
        store: new FileWorkflowStore(storeRoot, {
          leaseBackend: new InheritedFlockLeaseBackend({
            fd: firstDescriptor,
            lockPath,
            monitorIntervalMs: 10,
          }),
        }),
        provider: new FakeAgentProvider([]),
      })
      await first.initialize()
      expect(first.lifecycleState()).toBe('READY')

      unlinkSync(lockPath)
      writeFileSync(lockPath, '', { mode: 0o600 })
      const secondDescriptor = openSync(
        lockPath,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CLOEXEC,
      )
      const second = new WorkflowService({
        store: new FileWorkflowStore(storeRoot, {
          leaseBackend: new InheritedFlockLeaseBackend({
            fd: secondDescriptor,
            lockPath,
            monitorIntervalMs: 10,
          }),
        }),
        provider: new FakeAgentProvider([]),
      })
      await second.initialize()
      expect(second.lifecycleState()).toBe('READY')

      for (let attempt = 0; attempt < 100 && first.lifecycleState() !== 'FAILED'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(first.lifecycleState()).toBe('FAILED')
      await expect(first.listRuns()).rejects.toMatchObject({ code: 'invalid-request' })

      await second.quiesce('replacement owner test complete')
      expect(second.lifecycleState()).toBe('STOPPED')
    },
    10_000,
  )
})
