import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const MAIN = fileURLToPath(new URL('../dist/main/index.cjs', import.meta.url));

export interface LaunchOptions {
  /** Seed settings.json (skips first-run setup). */
  settings?: Record<string, unknown>;
  /** Seed a stored password (test key store format, SIPKIT_DESKTOP_TEST only). */
  password?: string;
  engine?: 'mock' | 'sipjs';
  /** Extra command-line arguments (e.g. a tel: URL, as the OS passes it). */
  args?: string[];
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

export const MOCK_ACCOUNT = {
  server: 'wss://pbx.example.test:8089/ws',
  domain: 'pbx.example.test',
  extension: '1001',
  authUsername: '',
  displayName: 'Agent 1001',
};

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'sipkit-desktop-e2e-'));
  mkdirSync(userData, { recursive: true });
  if (options.settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(options.settings));
  if (options.password) writeFileSync(join(userData, 'credentials.bin'), `test:${options.password}`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    SIPKIT_DESKTOP_TEST: '1',
    SIPKIT_DESKTOP_USER_DATA: userData,
    SIPKIT_DESKTOP_ENGINE: options.engine ?? 'mock',
  });
  // E2E_DESKTOP_EXECUTABLE runs the suite against a packaged build
  // (e.g. dist/release/mac-arm64/SipKit.app/Contents/MacOS/SipKit).
  const executablePath = process.env.E2E_DESKTOP_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [MAIN]), ...(options.args ?? [])],
    env,
  });
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (process.env.E2E_DEBUG) console.log(`[renderer] ${msg.text()}`);
  });
  return {
    app,
    page,
    userData,
    close: async () => {
      await app.evaluate(({ app: a }) => {
        // Bypass close-to-tray.
        a.quit();
      }).catch(() => {});
      await app.close().catch(() => {});
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Call a test hook in the main process (src/main/index.ts, SIPKIT_DESKTOP_TEST=1). */
export function hook<T>(app: ElectronApplication, name: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    (_electron, [n, a]) => {
      const hooks = (globalThis as unknown as { __sipkitDesktopTest: Record<string, (...x: unknown[]) => unknown> }).__sipkitDesktopTest;
      return hooks[n as string]!(...(a as unknown[]));
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** Snapshot of the renderer's softphone (mock engine exposes window.__softphone). */
export function calls(page: Page) {
  return page.evaluate(() => {
    type Snap = { calls: { id: string; direction: string; state: string; remoteNumber: string }[] };
    const phone = (window as unknown as { __softphone?: { getSnapshot(): Snap } }).__softphone;
    // Not created yet (app still booting).
    if (!phone) return [];
    return phone
      .getSnapshot()
      .calls.map((c) => ({ id: c.id, direction: c.direction, state: c.state, remoteNumber: c.remoteNumber }));
  });
}
