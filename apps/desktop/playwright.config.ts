import { defineConfig } from '@playwright/test';

/**
 * Electron e2e (Playwright `_electron`). Runs against the built app
 * (`pnpm --filter sipkit-desktop build` first). Each test launches its own app
 * instance with a fresh userData directory, SIPKIT_DESKTOP_TEST=1 (in-memory
 * key store, no real OS notifications, test hooks) and, by default, the mock
 * engine. Set E2E_DESKTOP_SIP_WSS_URL to also run the real-PBX spec.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One Electron instance at a time: global shortcuts are system-wide.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
