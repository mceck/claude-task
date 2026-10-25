import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
