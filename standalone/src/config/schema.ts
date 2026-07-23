export type StandaloneSourceMode = 'read-only' | 'authoring'
export type StandaloneLeaseMode = 'inherited-flock' | 'embedded'

export type StandaloneConfig = Readonly<{
  workspace: string
  projectHash: string
  dataDirectory: string
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  sourceMode: StandaloneSourceMode
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
