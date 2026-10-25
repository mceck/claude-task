import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = 3100;
const FRONTEND_PORT = 5174;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1600, height: 1000 },
  },
  webServer: [
    {
      // Recreates the e2e database, then runs the real backend against it.
      command: 'node e2e/start-backend.mjs',
      url: `http://127.0.0.1:${BACKEND_PORT}/api/v1/auth/me`,
      env: { PORT: String(BACKEND_PORT) },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${FRONTEND_PORT}`,
      url: `http://localhost:${FRONTEND_PORT}`,
      env: { VITE_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}`, VITE_PORT: String(FRONTEND_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
