import { expect, test } from '@playwright/test';
import { hook, launchApp, type LaunchedApp } from './helpers';

/**
 * Real PBX (opt-in): E2E_DESKTOP_SIP_WSS_URL=wss://localhost:18089/ws (a dev
 * Asterisk from infra/asterisk reachable from the host; the self-signed dev
 * certificate is accepted through `allowInsecureCerts` for that host only).
 * The SIP.js engine registers 1001 from the Electron renderer, a tel: link
 * dials the echo test (600) and the hang-up hotkey path ends the call.
 */
const WSS = process.env.E2E_DESKTOP_SIP_WSS_URL;
const EXT = process.env.E2E_DESKTOP_SIP_EXTENSION ?? '1001';
const PASSWORD = process.env.E2E_SIP_PASSWORD ?? 'sipkitdev123';

test.skip(!WSS, 'set E2E_DESKTOP_SIP_WSS_URL to run against a real Asterisk');

let launched: LaunchedApp | null = null;
test.afterEach(async () => {
  await launched?.close();
  launched = null;
});

test('registers over WSS with the keychain password and dials a tel: link', async () => {
  launched = await launchApp({
    engine: 'sipjs',
    settings: {
      version: 1,
      account: { server: WSS, domain: '', extension: EXT, authUsername: '', displayName: '' },
      allowInsecureCerts: true,
    },
    password: PASSWORD,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const { app, page } = launched;
  await expect.poll(() => hook(app, 'trayStatus'), { timeout: 20_000 }).toBe('registered');
  await expect(page.getByRole('status', { name: /Registration: Online/ })).toBeVisible();

  await hook(app, 'handleUrl', 'tel:600');
  await expect.poll(() => hook(app, 'trayStatus'), { timeout: 20_000 }).toBe('in-call');
  await expect(page.getByRole('region', { name: /^Call with 600/ })).toBeVisible({ timeout: 20_000 });

  await hook(app, 'triggerHotkey', 'hangup');
  await expect.poll(() => hook(app, 'trayStatus'), { timeout: 20_000 }).toBe('registered');
});
