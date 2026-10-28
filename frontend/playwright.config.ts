import { defineConfig, devices } from '@playwright/test';
import { networkInterfaces } from 'node:os';

const BACKEND_PORT = 3100;
const FRONTEND_PORT = 5174;
// Test-only routable host interface: browsers suppress loopback relay candidates.
const turnTestHost = process.env.VOICE_TURN_E2E_HOST ?? Object.values(networkInterfaces()).flat().find((address) => address?.family === 'IPv4' && !address.internal)?.address;
if (process.env.VOICE_TURN_E2E === '1' && !turnTestHost) throw new Error('Set VOICE_TURN_E2E_HOST to a reachable host IPv4 address for the TURN fixture');

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
    ...(process.env.VOICE_TURN_E2E === '1' ? [{
      command: 'node e2e/start-turn.mjs',
      env: { VOICE_TURN_E2E_HOST: turnTestHost! },
      url: 'http://127.0.0.1:34790',
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
    }] : []),
    {
      // Recreates the e2e database, then runs the real backend against it.
      command: 'node e2e/start-backend.mjs',
      url: `http://127.0.0.1:${BACKEND_PORT}/api/v1/auth/me`,
      env: {
        PORT: String(BACKEND_PORT),
        ...(process.env.VOICE_TURN_E2E === '1' ? {
          VOICE_TURN_HOST: turnTestHost!,
          VOICE_TURN_PORT: '3479',
          VOICE_TURN_SECRET: 'voice-turn-browser-test-secret-000000000000000000',
          VOICE_TURN_TTL_SECONDS: '300',
          VOICE_TURN_TLS_PORT: '',
        } : {}),
      },
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
