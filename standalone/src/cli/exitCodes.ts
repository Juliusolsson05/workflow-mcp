import { StandaloneConfigurationError } from '../config/schema.js'

export const EXIT_USAGE = 2
export const EXIT_UNAVAILABLE = 3
export const EXIT_AUTHENTICATION = 4
export const EXIT_POLICY = 5
export const EXIT_INTERNAL = 10

export function exitCodeFor(error: unknown): number {
  if (error instanceof StandaloneConfigurationError) return EXIT_USAGE
  const code = boundedErrorCode(error)
  if (['unauthorized', 'authentication-failed', 'auth-mode-conflict'].includes(code ?? '')) {
    return EXIT_AUTHENTICATION
  }
  if (['source-changed', 'source-approval-required', 'authoring-disabled', 'auth-busy'].includes(code ?? '')) {
    return EXIT_POLICY
  }
  if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'service-stopping', 'service-stopped'].includes(code ?? '')) {
    return EXIT_UNAVAILABLE
  }
  return EXIT_INTERNAL
}

function boundedErrorCode(error: unknown): string | undefined {
  // WHY: Node's fetch wraps connection failures in TypeError.cause, whereas filesystem and domain
  // failures normally put code on the outer error. Read exactly those two levels: recursively
  // walking an arbitrary cause graph could loop, trigger deep getters, or let provider-controlled
  // error structures consume unbounded work merely while choosing a process exit status.
  return ownCode(error) ?? ownCode(ownCause(error))
}

function ownCode(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'code')) return undefined
    const code = (value as { code?: unknown }).code
    return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined
  } catch {
    return undefined
  }
}

function ownCause(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'cause')) return undefined
    return (value as { cause?: unknown }).cause
  } catch {
    return undefined
  }
}
