import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks', // real sockets, child processes and timers: one process per file
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
