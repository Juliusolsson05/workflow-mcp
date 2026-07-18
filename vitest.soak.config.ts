import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.soak.test.ts'],
    fileParallelism: false,
  },
})
