process.on('message', (message) => {
  if (!message || message.type !== 'start') return
  process.send?.({
    type: 'result',
    result: {
      output: { type: 'text', text: 'done' },
      diagnostics: { fixture: true },
    },
  }, () => process.disconnect?.())
})
