import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.live.test.ts'],
    fileParallelism: false,
  },
})
