import { readFile } from 'node:fs/promises'

import type { StandaloneConfig } from '../config/schema.js'

const GIB = 1024 * 1024 * 1024

export type RuntimeResourceProfile = Readonly<{
  concurrency: number
  requiredMemoryBytes: number
  requiredCpuCores: number
  memoryLimitBytes?: number
  cpuLimitCores?: number
}>

export async function inspectResourceProfile(
  config: Pick<StandaloneConfig, 'concurrency'>,
  cgroupRoot = '/sys/fs/cgroup',
): Promise<RuntimeResourceProfile> {
  const requiredMemoryBytes = (config.concurrency + 1) * GIB
  const requiredCpuCores = config.concurrency
  const memoryLimitBytes = await readMemoryLimit(cgroupRoot)
  const cpuLimitCores = await readCpuLimit(cgroupRoot)
  return Object.freeze({
    concurrency: config.concurrency,
    requiredMemoryBytes,
    requiredCpuCores,
    ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
    ...(cpuLimitCores === undefined ? {} : { cpuLimitCores }),
  })
}

export async function requireSupportedResourceProfile(
  config: Pick<StandaloneConfig, 'concurrency'>,
  cgroupRoot = '/sys/fs/cgroup',
): Promise<RuntimeResourceProfile> {
  const profile = await inspectResourceProfile(config, cgroupRoot)
  // Native Codex processes dominate this budget. Refusing readiness is safer than letting nine
  // historical async slots compete inside Docker Gateway's common one-CPU/two-GiB envelope and
  // turning an OOM kill into an ambiguous provider interruption.
  if (profile.memoryLimitBytes !== undefined && profile.memoryLimitBytes < profile.requiredMemoryBytes) {
    throw resourceError(
      `concurrency ${profile.concurrency} requires at least ${profile.requiredMemoryBytes} memory bytes; cgroup grants ${profile.memoryLimitBytes}`,
    )
  }
  if (profile.cpuLimitCores !== undefined && profile.cpuLimitCores + 0.001 < profile.requiredCpuCores) {
    throw resourceError(
      `concurrency ${profile.concurrency} requires at least ${profile.requiredCpuCores} CPU cores; cgroup grants ${profile.cpuLimitCores}`,
    )
  }
  return profile
}

async function readMemoryLimit(root: string): Promise<number | undefined> {
  const v2 = await optionalText(`${root}/memory.max`)
  if (v2 !== undefined) return v2 === 'max' ? undefined : positiveInteger(v2, 'memory.max')
  const v1 = await optionalText(`${root}/memory/memory.limit_in_bytes`)
  if (v1 === undefined) return undefined
  // cgroup v1 represents "unlimited" using a host-sized sentinel close to signed 64-bit max.
  if (!/^\d+$/.test(v1)) throw resourceError('memory.limit_in_bytes is malformed')
  const wide = BigInt(v1)
  if (wide >= 9_000_000_000_000_000_000n) return undefined
  if (wide <= 0n || wide > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw resourceError('memory.limit_in_bytes is outside the supported range')
  }
  return Number(wide)
}

async function readCpuLimit(root: string): Promise<number | undefined> {
  const v2 = await optionalText(`${root}/cpu.max`)
  if (v2 !== undefined) {
    const [quota, period, extra] = v2.split(/\s+/)
    if (extra !== undefined || quota === undefined || period === undefined) throw resourceError('cpu.max is malformed')
    if (quota === 'max') return undefined
    return positiveInteger(quota, 'cpu.max quota') / positiveInteger(period, 'cpu.max period')
  }
  const quota = await optionalText(`${root}/cpu/cpu.cfs_quota_us`)
  const period = await optionalText(`${root}/cpu/cpu.cfs_period_us`)
  if (quota === undefined || period === undefined || quota === '-1') return undefined
  return positiveInteger(quota, 'cpu.cfs_quota_us') / positiveInteger(period, 'cpu.cfs_period_us')
}

async function optionalText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').then(value => value.trim(), error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
}

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw resourceError(`${name} is malformed`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw resourceError(`${name} is outside the supported range`)
  return parsed
}

function resourceError(message: string): Error & { code: 'resource-profile-unsupported' } {
  return Object.assign(new Error(message), { code: 'resource-profile-unsupported' as const })
}
