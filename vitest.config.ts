import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // WHY files are serialized in this repository: many deterministic suites
    // intentionally exercise real worker threads, process hosts, HTTP servers,
    // and filesystem leases. Running the core and system projects together
    // oversubscribes small CI runners until five-second behavioral deadlines
    // measure runner starvation instead of product behavior. The suite still
    // tests concurrency inside each scenario; only independent files are
    // serialized at the runner boundary.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          fileParallelism: false,
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/**/*.system.test.ts',
            'test/**/*.corpus.test.ts',
            'test/**/*.live.test.ts',
            'test/**/*.soak.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['test/**/*.system.test.ts'],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'corpus',
          environment: 'node',
          include: ['test/**/*.corpus.test.ts'],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // WHY this is the measured full-source floor: process-host and worker
      // entrypoints deliberately remain visible at zero instead of disappearing
      // from imported-only reports. The threshold prevents regression today;
      // focused tests can ratchet it upward without a one-shot coverage rewrite.
      thresholds: { statements: 74, branches: 68, functions: 78, lines: 78 },
    },
  },
})
