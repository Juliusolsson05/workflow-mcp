import { describe, expect, it } from 'vitest'

import { StandaloneConfigurationError } from '../src/config/schema.js'
import {
  EXIT_AUTHENTICATION,
  EXIT_INTERNAL,
  EXIT_POLICY,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  exitCodeFor,
} from '../src/cli/exitCodes.js'

describe('CLI exit-code contract', () => {
  it('classifies direct domain and configuration failures', () => {
    expect(exitCodeFor(new StandaloneConfigurationError('bad configuration'))).toBe(EXIT_USAGE)
    expect(exitCodeFor(Object.assign(new Error('denied'), { code: 'unauthorized' }))).toBe(EXIT_AUTHENTICATION)
    expect(exitCodeFor(Object.assign(new Error('changed'), { code: 'source-changed' }))).toBe(EXIT_POLICY)
    expect(exitCodeFor(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(EXIT_UNAVAILABLE)
    expect(exitCodeFor(new Error('unexpected'))).toBe(EXIT_INTERNAL)
  })

  it('classifies the one-level connection cause emitted by Node fetch', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    expect(exitCodeFor(error)).toBe(EXIT_UNAVAILABLE)
  })

  it('does not recursively traverse malformed or cyclic provider error causes', () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(exitCodeFor(cyclic)).toBe(EXIT_INTERNAL)
    expect(exitCodeFor({ cause: { cause: { code: 'ECONNREFUSED' } } })).toBe(EXIT_INTERNAL)
  })
})
