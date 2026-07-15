const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

// This fixture intentionally violates cooperative cancellation at both generations. It is not a
// provider mock: its purpose is to prove that the OS ownership boundary, rather than an AbortSignal
// convention, is what returns a workflow permit after a hostile descendant exists.
process.on('SIGTERM', () => undefined)

process.on('message', (message) => {
  if (!message || message.type !== 'start') return
  const grandchild = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
  ], {
    // Inheriting stderr reproduces the real deadlock shape: ChildProcess `close` cannot fire until
    // the grandchild releases the host pipe, even after the direct host has exited.
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  writeFileSync(message.request.prompt, String(grandchild.pid))
  writeFileSync(`${message.request.prompt}.options.json`, JSON.stringify(message.options))
  process.send?.({ type: 'ready', pid: process.pid })
  setInterval(() => undefined, 1_000)
})
