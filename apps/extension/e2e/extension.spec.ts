/**
 * The unpacked Chrome extension hosts the one (mock-engine) softphone in its
 * offscreen document; the playground page and the popup are remote clients.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'chrome');
const SHARED = '/?instance=shared';

interface Fixtures {
  ext: { context: BrowserContext; sw: Worker; id: string };
}

const test = base.extend<Fixtures>({
  ext: async ({ baseURL }, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'sipkit-ext-'));
    // channel 'chromium' = new headless mode, which supports extensions.
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(sw.url()).host;
    const origin = new URL(baseURL!).origin;
    // Mock engine, signed in as 1001, playground origin allowed + approved, click-to-call on.
    await sw.evaluate(async (pageOrigin) => {
      await chrome.storage.local.set({
        settings: {
          engine: 'mock',
          account: { websocketUrls: [], username: '1001', domain: 'demo.sipkit.local', displayName: '', authUsername: '' },
          allowedOrigins: ['http://localhost/*'],
          approvedOrigins: [pageOrigin],
          softphoneUrl: `${pageOrigin}/?instance=shared`,
          clickToCall: true,
          notifications: true,
          brandName: 'SipKit',
        },
      });
      await chrome.storage.session.set({ secrets: { password: 'secret', registerHeaders: [] } });
      await (globalThis as unknown as { __sipkitEnsureHost: () => Promise<void> }).__sipkitEnsureHost();
    }, origin);
    await use({ context, sw, id });
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
});

const badge = (sw: Worker) => sw.evaluate(() => chrome.action.getBadgeText({}));
const callOf = (p: Page) =>
  p.evaluate(() => {
    const c = window.__softphone?.getSnapshot().calls[0];
    return c ? { id: c.id, state: c.state, connectedAt: c.connectedAt } : null;
  });

async function openAttached(context: BrowserContext, path = SHARED): Promise<Page> {
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.getByTestId('instance-role')).toHaveAttribute('data-role', 'extension');
  return page;
}

test.describe('browser extension hosts the softphone (mock engine)', () => {
  test('page attaches, call survives reload and navigation, tabs and popup mirror it', async ({ ext }) => {
    const { context, sw, id } = ext;
    const page = await openAttached(context);
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    // The page did not create its own instance.
    expect(await page.evaluate(() => window.__sipkitInstancesCreated ?? 0)).toBe(0);

    // The popup is another client and mirrors registration.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.getByTestId('ext-status')).toHaveAttribute('data-status', 'connected');
    await expect(popup.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');

    // Incoming call (mock helper on the extension's instance): page, popup and badge show it.
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toContainText('Jane Customer');
    await expect(popup.getByTestId('incoming-call')).toContainText('Jane Customer');
    await expect.poll(() => badge(sw)).toBe('RING');

    // Answered from the page.
    await page.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(popup.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect.poll(() => badge(sw)).toBe('CALL');
    const before = await callOf(page);
    expect(before?.state).toBe('connected');

    // Reload during the call: same call id, still connected, timer keeps counting.
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByTestId('instance-role')).toHaveAttribute('data-role', 'extension');
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    expect(await callOf(page)).toEqual(before);
    await expect(page.getByTestId('call-status')).toHaveText(/^0:0[1-9]|^\d+:\d[0-9]$/);
    const t1 = await page.getByTestId('call-status').textContent();
    await expect.poll(() => page.getByTestId('call-status').textContent()).not.toBe(t1);

    // Navigate away and back: unchanged.
    await page.goto('/click-to-call-demo.html');
    await page.goto(SHARED);
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    expect(await callOf(page)).toEqual(before);

    // A second tab mirrors the same state; mute there shows everywhere.
    const second = await openAttached(context);
    await expect(second.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    expect(await callOf(second)).toEqual(before);
    await second.getByRole('button', { name: 'Mute' }).click();
    await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

    // Hang up in the popup ends it everywhere; the badge clears.
    await popup.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();
    await expect(second.getByTestId('call-screen')).toBeHidden();
    await expect.poll(() => badge(sw)).toBe('');

    // And the other way round: a call answered in the popup, hung up on the page.
    await page.getByTestId('simulate-incoming').click();
    await popup.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(popup.getByTestId('call-screen')).toBeHidden();
  });

  test('a tel: link on another page dials on the extension instance', async ({ ext }) => {
    const { context } = ext;
    const page = await openAttached(context);
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    const other = await context.newPage();
    await other.goto('/click-to-call-demo.html');
    await other.getByTestId('tel-link').click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__softphone?.getSnapshot().calls[0]?.remoteNumber)).toBe('+15550100');
    // The demo page did not navigate to tel:.
    expect(other.url()).toContain('/click-to-call-demo.html');
    await page.getByRole('button', { name: 'Hang up' }).click();
  });
});

base('without the extension the page falls back to its own instance', async ({ page }) => {
  await page.goto(SHARED);
  // No extension answered: this tab leads the web host and runs a local instance.
  await expect(page.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
  expect(await page.evaluate(() => window.__sipkitInstancesCreated ?? 0)).toBe(1);
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
});
