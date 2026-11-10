import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    // Each file starts its own replica set, and the race tests depend on timing.
    fileParallelism: false,
  },
});
