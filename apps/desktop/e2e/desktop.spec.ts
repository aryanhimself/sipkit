import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { calls, hook, launchApp, MOCK_ACCOUNT, type LaunchedApp } from './helpers';

const SEEDED = { settings: { version: 1, account: MOCK_ACCOUNT }, password: 'secret' };

let launched: LaunchedApp | null = null;
test.afterEach(async () => {
  await launched?.close();
  launched = null;
});

async function waitRegistered(l: LaunchedApp) {
  await expect.poll(() => hook(l.app, 'trayStatus')).toBe('registered');
}

test('first run: setup screen stores the account and the widget renders', async () => {
  launched = await launchApp();
  const { page, userData } = launched;
  await expect(page.getByTestId('desktop-setup')).toBeVisible();

  // Validation: empty form.
  await page.getByTestId('desktop-setup-save').click();
  await expect(page.getByText('Required').first()).toBeVisible();

  await page.getByLabel('Server (WebSocket URL)').fill('http://not-websocket');
  await page.getByLabel('Extension').fill('1001');
  await page.getByLabel('Password').fill('s3cret');
  await page.getByTestId('desktop-setup-save').click();
  await expect(page.getByText('Enter a wss:// URL')).toBeVisible();

  await page.getByLabel('Server (WebSocket URL)').fill('wss://pbx.example.test:8089/ws');
  await page.getByTestId('desktop-setup-save').click();

  // The sipkit-ui widget, registered with the mock engine.
  await expect(page.locator('.sipkit-phone [data-theme]').first()).toBeVisible();
  await expect(page.getByTestId('desktop-settings-open')).toBeVisible();
  await waitRegistered(launched);

  const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
  expect(settings.account).toMatchObject({ server: 'wss://pbx.example.test:8089/ws', extension: '1001' });
  // The password is not in the settings file; it went to the key store.
  expect(JSON.stringify(settings)).not.toContain('s3cret');
  expect(readFileSync(join(userData, 'credentials.bin'), 'utf8')).toBe('test:s3cret');
});

test('renderer is sandboxed: no Node, context isolation, CSP', async () => {
  launched = await launchApp(SEEDED);
  const { app, page } = launched;
  await waitRegistered(launched);
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // Runtime API (not in electron.d.ts): the preferences the renderer actually got.
    type Prefs = { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean; webSecurity: boolean };
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Prefs };
    const p = wc.getLastWebPreferences();
    return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity };
  });
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
  const renderer = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: Object.keys((window as unknown as { sipkitDesktop: object }).sipkitDesktop).sort(),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
  }));
  expect(renderer.require).toBe('undefined');
  expect(renderer.process).toBe('undefined');
  expect(renderer.bridge).toContain('engine');
  expect(renderer.csp).toContain("script-src 'self'");
  expect(renderer.csp).not.toContain('unsafe-eval');
  // Inline script is blocked by the CSP.
  const inlineRan = await page.evaluate(async () => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = true';
    document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 50));
    return Boolean((window as unknown as { __inline?: boolean }).__inline);
  });
  expect(inlineRan).toBe(false);
});

test('tel: URL on the command line dials; second-instance and open-url links dial too', async () => {
  launched = await launchApp({ ...SEEDED, args: ['tel:+1 (555) 010-0200'] });
  const { app, page } = launched;
  await expect.poll(async () => (await calls(page)).map((c) => c.remoteNumber)).toContain('+15550100200');
  // The widget's call screen shows the (formatted) number.
  await expect(page.getByRole('region', { name: /^Call with \+155/ })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __softphone: { hangupAll(): Promise<void> } }).__softphone.hangupAll());
  await expect.poll(async () => (await calls(page)).length).toBe(0);

  // Windows / Linux: the OS starts a second instance with the URL in argv.
  await app.evaluate(({ app: a }) => {
    a.emit('second-instance', {}, ['/path/to/app', '--some-flag', 'sip:1003@pbx.example.test'], '/');
  });
  await expect.poll(async () => (await calls(page)).map((c) => c.remoteNumber)).toContain('1003');
  await page.evaluate(() => (window as unknown as { __softphone: { hangupAll(): Promise<void> } }).__softphone.hangupAll());
  await expect.poll(async () => (await calls(page)).length).toBe(0);

  // macOS: open-url.
  await app.evaluate(({ app: a }) => {
    a.emit('open-url', { preventDefault() {} }, 'callto://1004');
  });
  await expect.poll(async () => (await calls(page)).map((c) => c.remoteNumber)).toContain('1004');
});

test('global hotkeys answer and hang up through IPC; tray and notifications follow', async () => {
  launched = await launchApp(SEEDED);
  const { app, page } = launched;
  await waitRegistered(launched);

  // The default answer / hangup shortcuts are registered system-wide.
  const registered = await hook<string[]>(app, 'registeredHotkeys');
  expect(registered).toEqual(['CommandOrControl+Shift+A', 'CommandOrControl+Shift+H']);
  expect(await hook<boolean>(app, 'isShortcutRegistered', 'CommandOrControl+Shift+A')).toBe(true);

  await page.evaluate(() =>
    (window as unknown as { __softphone: { simulateIncomingCall(n: string, d?: string): unknown } }).__softphone.simulateIncomingCall('5550100', 'Jane Customer'),
  );
  await expect.poll(() => hook(app, 'trayStatus')).toBe('ringing');
  await expect
    .poll(() => hook<{ kind: string; body: string }[]>(app, 'notifications'))
    .toContainEqual(expect.objectContaining({ kind: 'incoming', body: 'Jane Customer (5550100)' }));

  // A real global key press cannot be synthesised headless: invoke the same
  // handler the globalShortcut callback calls (main → IPC command → renderer).
  await hook(app, 'triggerHotkey', 'answer');
  await expect.poll(async () => (await calls(page))[0]?.state).toBe('connected');
  await expect.poll(() => hook(app, 'trayStatus')).toBe('in-call');

  await hook(app, 'triggerHotkey', 'hangup');
  await expect.poll(async () => (await calls(page)).length).toBe(0);
  await expect.poll(() => hook(app, 'trayStatus')).toBe('registered');

  // DND shows in the tray.
  await page.evaluate(() => (window as unknown as { __softphone: { setDnd(on: boolean): Promise<void> } }).__softphone.setDnd(true));
  await expect.poll(() => hook(app, 'trayStatus')).toBe('dnd');
});

test('notification Decline rejects; a call the caller abandons is reported as missed', async () => {
  launched = await launchApp(SEEDED);
  const { app, page } = launched;
  await waitRegistered(launched);
  const incoming = (n: string) =>
    page.evaluate(
      (num) => (window as unknown as { __softphone: { simulateIncomingCall(n: string): { id: string } } }).__softphone.simulateIncomingCall(num).id,
      n,
    );

  const first = await incoming('5550111');
  await hook(app, 'notificationAction', first, 'decline');
  await expect.poll(async () => (await calls(page)).length).toBe(0);

  const second = await incoming('5550122');
  await page.evaluate(
    (id) => (window as unknown as { __softphone: { simulateRemoteHangup(id: string): void } }).__softphone.simulateRemoteHangup(id),
    second,
  );
  await expect
    .poll(() => hook<{ kind: string; body: string }[]>(app, 'notifications'))
    .toContainEqual(expect.objectContaining({ kind: 'missed', body: '5550122' }));
  // The declined call is not "missed".
  const missed = (await hook<{ kind: string; body: string }[]>(app, 'notifications')).filter((n) => n.kind === 'missed');
  expect(missed.map((n) => n.body)).toEqual(['5550122']);
});

test('desktop settings change the global hotkeys without dropping a call', async () => {
  launched = await launchApp(SEEDED);
  const { app, page } = launched;
  await waitRegistered(launched);
  await page.evaluate(() => (window as unknown as { __softphone: { simulateIncomingCall(n: string): unknown } }).__softphone.simulateIncomingCall('5550133'));
  await hook(app, 'triggerHotkey', 'answer');
  await expect.poll(async () => (await calls(page))[0]?.state).toBe('connected');
  await page.getByTestId('desktop-settings-open').click();
  await expect(page.getByTestId('desktop-settings')).toBeVisible();
  await page.getByTestId('hotkey-answer').fill('Alt+Shift+F9');
  await page.getByTestId('hotkey-toggleDnd').fill('nonsense+key');
  await expect(page.getByText('Unknown key')).toBeVisible();
  await page.getByTestId('hotkey-toggleDnd').fill('CommandOrControl+Alt+D');
  await page.getByTestId('desktop-settings-save').click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect
    .poll(() => hook<string[]>(app, 'registeredHotkeys'))
    .toEqual(['Alt+Shift+F9', 'CommandOrControl+Shift+H', 'CommandOrControl+Alt+D']);
  expect(await hook<boolean>(app, 'isShortcutRegistered', 'CommandOrControl+Shift+A')).toBe(false);
  const settings = await hook<{ hotkeys: Record<string, string> }>(app, 'settings');
  expect(settings.hotkeys.answer).toBe('Alt+Shift+F9');
  // Same softphone instance: the call survived the settings change.
  expect((await calls(page))[0]).toMatchObject({ remoteNumber: '5550133', state: 'connected' });
});
