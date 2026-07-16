export const meta = {
  name: 'corpus-parallel',
  description: 'Committed parallel and phase conformance fixture',
  phases: [{ title: 'Inspect', detail: 'Run independent reviews', model: 'sonnet' }],
}
phase('Inspect')
return await parallel(args.items.map((item) => () => agent(`Inspect ${item}`, { label: item })))
