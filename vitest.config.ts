import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'search_v2/src/**/*.test.ts'],
    environment: 'node',
  },
});
