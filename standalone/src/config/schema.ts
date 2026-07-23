export type StandaloneSourceMode = 'read-only' | 'authoring'
export type StandaloneLeaseMode = 'inherited-flock' | 'embedded'

/**
 * One recorded bit selects the whole posture. `default` is the single-user consumer profile:
 * authoring enabled, no source-approval gate, tokenless localhost web, host-seeded Codex auth
 * allowed. `hardened` restores the original shipped posture (read-only sources, durable
 * approvals, token-gated web, isolated container auth). Individual environment overrides remain
 * for tests and expert setups, but product behavior must branch on the derived fields below —
 * never re-derive them from the profile — so one profile bit cannot silently disagree with the
 * mode a subsystem actually runs in.
 */
export type StandaloneProfile = 'default' | 'hardened'
export type StandaloneApprovalMode = 'none' | 'required'
export type StandaloneWebAuthMode = 'none' | 'token'

export type StandaloneConfig = Readonly<{
  workspace: string
  projectHash: string
  dataDirectory: string
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  profile: StandaloneProfile
  sourceMode: StandaloneSourceMode
  approvalMode: StandaloneApprovalMode
  webAuthMode: StandaloneWebAuthMode
  hostCodexAuthFile?: string
  leaseMode: StandaloneLeaseMode
  lockFileDescriptor?: number
  lockPath?: string
  adminSocketPath: string
  codexExecutable: string
  webEnabled: boolean
  concurrency: number
}>

export class StandaloneConfigurationError extends Error {
  readonly code = 'invalid-configuration'

  constructor(message: string) {
    super(message)
    this.name = 'StandaloneConfigurationError'
  }
}
