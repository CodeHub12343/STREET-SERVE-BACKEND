import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Mongo (memory replica set) + a single shared connection: run serially in one process.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 300_000,
    testTimeout: 30_000,
  },
});
