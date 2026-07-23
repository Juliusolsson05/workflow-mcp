import { spawn } from 'node:child_process'

const child = spawn('/usr/local/bin/workflow-mcp', ['serve', '--stdio', '/workspace'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})
const childExit = new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})
let buffer = ''
let stderr = ''
const pending = new Map()
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_192) })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    const message = JSON.parse(line)
    if (message.id !== undefined) pending.get(message.id)?.(message)
  }
})

let nextId = 0
async function request(method, params) {
  const id = ++nextId
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}`))
    }, 10_000)
    pending.set(id, message => {
      clearTimeout(timeout)
      pending.delete(id)
      if (message.error !== undefined) reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return response
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'workflow-mcp-registry-smoke', version: '1' },
  })
  if (initialized.serverInfo?.version !== process.env.EXPECTED_VERSION) {
    throw new Error(`Server version drifted: ${initialized.serverInfo?.version}`)
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  const listed = await request('tools/list', {})
  if (listed.tools?.length !== 13) throw new Error(`Expected 13 tools, received ${listed.tools?.length}`)
  const started = await request('tools/call', {
    name: 'workflow_run',
    arguments: { name: 'smoke', idempotencyKey: 'registry-single-session-smoke' },
  })
  const runId = started.structuredContent?.run?.runId
  if (typeof runId !== 'string' || !runId.startsWith('run_')) throw new Error('Run did not return an ID')
  let terminal
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await request('tools/call', {
      name: 'workflow_run_status',
      arguments: { runId },
    })
    terminal = status.structuredContent?.run?.status
    if (terminal === 'completed') break
    if (['completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(terminal)) {
      throw new Error(`Run ended as ${terminal}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (terminal !== 'completed') throw new Error(`Run did not finish in-session: ${terminal}`)
  child.stdin.end()
  // WHY: a protocol request timeout does not protect the close handshake. If the STDIO server
  // keeps an owner/provider handle alive after EOF, an unbounded wait here would hang the native
  // Registry gate until the entire CI job timeout and conceal which lifecycle invariant failed.
  const exit = await waitForExit(childExit, 10_000)
  if (exit.code !== 0 || exit.signal !== null) throw new Error(`STDIO owner exited unexpectedly: ${JSON.stringify(exit)}`)
  process.stdout.write('Registry single-session terminal workflow smoke passed.\n')
} catch (error) {
  child.kill('SIGTERM')
  await Promise.race([childExit.catch(() => undefined), delay(2_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  throw new Error(`${error instanceof Error ? error.message : String(error)}; child stderr: ${stderr}`)
}

async function waitForExit(exit, milliseconds) {
  let timeout
  try {
    return await Promise.race([
      exit,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('STDIO owner did not exit after input closed')), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
