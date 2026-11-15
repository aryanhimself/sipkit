import { defineConfig, devices } from '@playwright/test';

/** E2E_PORT lets several checkouts (git worktrees) run the mock suite side by side. */
const PORT = Number(process.env.E2E_PORT ?? 5179);
/** E2E_MODE=sip also runs e2e/sip/** against a real Asterisk (infra/asterisk). */
const SIP = process.env.E2E_MODE === 'sip';
/**
 * Point at an already-running playground (e.g. from inside the Playwright Docker
 * image via scripts/e2e-sip-docker.sh). Skips the built-in dev server. Keep it a
 * localhost origin: getUserMedia only works in secure contexts.
 */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: 'sip/**', use: { ...devices['Desktop Chrome'] } },
    ...(SIP
      ? [
          {
            name: 'sip',
            testMatch: 'sip/**/*.spec.ts',
            // Real calls share two PBX extensions: run serially.
            fullyParallel: false,
            timeout: 60_000,
            expect: { timeout: 15_000 },
            use: {
              ...devices['Desktop Chrome'],
              ignoreHTTPSErrors: true,
              permissions: ['microphone'],
              launchOptions: {
                args: [
                  // Dev CA is self-signed; WSS ignores ignoreHTTPSErrors.
                  ...(process.env.E2E_SIP_IGNORE_CERT !== '0' ? ['--ignore-certificate-errors'] : []),
                  '--use-fake-device-for-media-stream',
                  '--use-fake-ui-for-media-stream',
                  '--autoplay-policy=no-user-gesture-required',
                ],
              },
            },
          },
        ]
      : []),
  ],
  workers: SIP ? 1 : undefined,
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `pnpm exec vite --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
