import { defineConfig } from '@playwright/test';

/** Same E2E_PORT convention as apps/playground: several worktrees can run side by side. */
const PORT = Number(process.env.E2E_PORT ?? 5180);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One persistent browser profile per test, but the extension host is per profile: keep it simple.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    // The playground (mock engine) is the "CRM" page that attaches to the extension.
    command: `pnpm --dir ../playground exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
