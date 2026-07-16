export const meta = {
  name: 'corpus-nested',
  description: 'Committed nested workflow call-shape fixture',
}
const inventory = await workflow('inventory', { root: args.root })
return await agent(`Verify the inventory: ${JSON.stringify(inventory)}`)
