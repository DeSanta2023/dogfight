import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'json-summary'],
      // Lab 07: the simulation is the part of the game that MUST be right in two places at once.
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
