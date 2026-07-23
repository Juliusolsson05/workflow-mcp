export interface WorkflowJournalWriteCoordinator {
  /**
   * Execute one complete synchronous journal commit while the store's lease generation is live.
   * The callback must include the final file and directory fsync; returning earlier would let
   * quiesce unlock while bytes from the old owner can still become authoritative.
   */
  runSync<T>(operation: () => T): T
}

/**
 * In-process admission gate which ties every durable write to one cross-process lease generation.
 *
 * The kernel lock remains the cross-process authority. This coordinator closes the subtler gap
 * between "we checked the lock" and a later fsync: lease release first closes this gate and drains
 * every issued permit, so an old async continuation cannot write after ownership transfers.
 */
export class LeaseScopedWriteCoordinator implements WorkflowJournalWriteCoordinator {
  #open = false
  #everActivated = false
  #active = 0
  #assertOwned: (() => void) | undefined
  readonly #drainWaiters = new Set<() => void>()

  activate(assertOwned: () => void): void {
    if (this.#open || this.#active !== 0) {
      throw new Error('Cannot replace an active workflow store writer generation')
    }
    this.#assertOwned = assertOwned
    this.#open = true
    this.#everActivated = true
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.#enter()
    try {
      const result = await operation()
      this.#verifyOwned()
      return result
    } finally {
      this.#leave()
    }
  }

  runSync<T>(operation: () => T): T {
    this.#enter()
    try {
      const result = operation()
      this.#verifyOwned()
      return result
    } finally {
      this.#leave()
    }
  }

  async closeAndDrain(): Promise<void> {
    // Closing is deliberately synchronous. A caller which starts release() without awaiting it has
    // still closed admission before another JavaScript continuation can enter a persistent write.
    this.#open = false
    if (this.#active !== 0) {
      await new Promise<void>(resolveDrain => this.#drainWaiters.add(resolveDrain))
    }
  }

  deactivate(): void {
    if (this.#active !== 0) throw new Error('Cannot deactivate with active workflow store writers')
    this.#open = false
    this.#assertOwned = undefined
  }

  assertWritable(): void {
    if (!this.#everActivated) {
      throw ownerConflict('Workflow store mutations require an acquired owner lease')
    }
    if (!this.#open || this.#assertOwned === undefined) {
      throw ownerConflict('Workflow store ownership has been released')
    }
    this.#verifyOwned()
  }

  #enter(): void {
    this.assertWritable()
    this.#active += 1
  }

  #verifyOwned(): void {
    try {
      this.#assertOwned?.()
    } catch (error) {
      // Ownership drift is terminal for this generation. Closing before rethrowing prevents another
      // mutator from entering on the orphaned inode while the service transitions to FAILED.
      this.#open = false
      throw error
    }
  }

  #leave(): void {
    this.#active -= 1
    if (this.#active !== 0) return
    for (const wake of this.#drainWaiters) wake()
    this.#drainWaiters.clear()
  }
}

function ownerConflict(message: string): Error & { code: 'owner-conflict' } {
  return Object.assign(new Error(message), { code: 'owner-conflict' as const })
}
