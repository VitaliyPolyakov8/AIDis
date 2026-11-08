import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __AIDIS_GITHUB__: JSON.stringify({ owner: 'example', repo: 'AIDis' }),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
