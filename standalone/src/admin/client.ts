import { request } from 'node:http'

export class StandaloneAdminClient {
  readonly #socketPath: string
  readonly #token: string

  constructor(options: { socketPath: string; token: string }) {
    this.#socketPath = options.socketPath
    this.#token = options.token
  }

  status(): Promise<{ schemaVersion: 1; lifecycle: string; activeRuns: boolean }> {
    return this.#call('GET', '/v1/status')
  }

  sourceApprovals(): Promise<{ schemaVersion: 1; items: SourceApprovalResponse[] }> {
    return this.#call('GET', '/v1/source-approvals')
  }

  approveSource(input: { name: string; expectedSourceHash?: string }): Promise<{
    schemaVersion: 1
    approval: SourceApprovalResponse
  }> {
    return this.#call('POST', '/v1/source-approvals', input)
  }

  authStatus(): Promise<AuthenticationStatusResponse> {
    return this.#call('GET', '/v1/auth/status')
  }

  logout(): Promise<{ schemaVersion: 1; status: 'logged-out' }> {
    return this.#call('POST', '/v1/auth/logout')
  }

  login(onOutput: (stream: 'stdout' | 'stderr', text: string) => void): Promise<void> {
    return new Promise((resolveLogin, rejectLogin) => {
      const outgoing = request({
        socketPath: this.#socketPath,
        path: '/v1/auth/login',
        method: 'POST',
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/x-ndjson' },
      }, response => {
        let buffered = ''
        let settled = false
        const rejectOnce = (error: unknown): void => {
          if (settled) return
          settled = true
          rejectLogin(error)
        }
        response.setEncoding('utf8')
        response.on('data', chunk => {
          buffered += String(chunk)
          if (Buffer.byteLength(buffered) > 1024 * 1024) {
            response.destroy(new Error('Authentication stream exceeds 1 MiB'))
            return
          }
          let newline
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline)
            buffered = buffered.slice(newline + 1)
            if (line.length === 0) continue
            let frame: unknown
            try {
              frame = JSON.parse(line) as unknown
            } catch (cause) {
              rejectOnce(new Error('Authentication stream contains invalid JSON', { cause }))
              response.destroy()
              return
            }
            if (!isObject(frame) || typeof frame.type !== 'string') continue
            if (frame.type === 'output' && (frame.stream === 'stdout' || frame.stream === 'stderr') && typeof frame.text === 'string') {
              onOutput(frame.stream, frame.text)
            } else if (frame.type === 'error') {
              rejectOnce(new Error(typeof frame.message === 'string' ? frame.message : 'Authentication failed'))
            } else if (frame.type === 'complete' && !settled) {
              settled = true
              resolveLogin()
            }
          }
        })
        response.once('error', rejectOnce)
        response.once('end', () => {
          if (!settled) rejectOnce(new Error('Authentication stream ended without a terminal frame'))
        })
      })
      outgoing.once('error', rejectLogin)
      outgoing.end()
    })
  }

  #call<T>(method: string, path: string, body?: object): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolveCall, rejectCall) => {
      const outgoing = request({
        socketPath: this.#socketPath,
        path,
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : {
            'content-type': 'application/json',
            'content-length': String(payload.length),
          }),
        },
      }, response => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > 1024 * 1024) response.destroy(new Error('Admin response exceeds 1 MiB'))
          else chunks.push(buffer)
        })
        response.once('error', rejectCall)
        response.once('end', () => {
          let value: unknown
          try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          } catch (cause) {
            rejectCall(new Error('Admin response is not valid JSON', { cause }))
            return
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const detail = isObject(value) && isObject(value.error) && typeof value.error.message === 'string'
              ? value.error.message
              : `HTTP ${response.statusCode ?? 500}`
            rejectCall(new Error(detail))
            return
          }
          resolveCall(value as T)
        })
      })
      outgoing.once('error', rejectCall)
      if (payload !== undefined) outgoing.write(payload)
      outgoing.end()
    })
  }
}

export type SourceApprovalResponse = Readonly<{
  workflowName: string
  sourceHash: string
  canonicalIdentityHash: string
  projectHash: string
  approvedAt: string
}>

export type AuthenticationStatusResponse = Readonly<{
  schemaVersion: 1
  mode: 'api-key-secret' | 'interactive'
  authenticated: boolean
  detail: string
}>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
