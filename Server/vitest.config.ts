import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each test file builds its own in-process PGlite database; Argon2 hashing is slow on purpose.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 0.7.0: 70+ files; with every core busy the CPU-heavy game tests (minesweeper, Durak bot) hit
    // their timeouts. Eight workers finish just as fast and keep them stable.
    maxWorkers: 8,
  },
});
