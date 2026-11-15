import { expect, test, type Browser, type Page } from '@playwright/test';
import { GATEWAY_WSS_URL, PASSWORD, WSS_URL, answerIncoming, closePhone, dial, expectCallState, expectMediaFlowing, openPhone, type Phone } from './helpers';

/**
 * Reload-safe softphone against the dev PBX (docs/resume.md, V2-RESUME-01):
 * answered calls of a `resume.enabled` softphone live in a ConfBridge anchor room
 * (extensions.conf [sipkit-anchor]); a reloaded page rejoins it with *85<anchor>.
 */

const PC_SPY = () => {
  const Native = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  class Spy extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
  }
  window.RTCPeerConnection = Spy as typeof RTCPeerConnection;
};

/** openPhone() with "Survive reload" on (and optionally a short PBX rejoin timeout). */
async function openResumePhone(browser: Browser, user: string, rejoinTimeoutMs?: number, wssUrl = WSS_URL): Promise<Phone> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  page.on('console', (m) => {
    if (process.env.E2E_DEBUG || m.type() === 'error') console.log(`[${user} console.error] ${m.text()}`);
  });
  await page.goto('/');
  if (rejoinTimeoutMs) await page.evaluate((ms) => localStorage.setItem('pg:resumeTimeoutMs', String(ms)), rejoinTimeoutMs);
  await page.getByRole('radio', { name: 'Real Asterisk' }).click();
  await page.getByLabel('WebSocket URL').fill(wssUrl);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Survive reload (resume)').check();
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
  return { context, page, user };
}

const firstCall = (page: Page) =>
  page.evaluate(() => {
    const c = window.__softphone!.getSnapshot().calls[0];
    return c ? { id: c.id, state: c.state, connectedAt: c.connectedAt, anchorId: c.anchorId, resuming: c.resuming } : null;
  });

const cdrCount = (phone: Phone) => phone.page.getByTestId('event-log').locator('li', { hasText: /\bcdr\b/ }).count();

let a: Phone | undefined;
let b: Phone | undefined;

test.afterEach(async () => {
  await closePhone(a);
  await closePhone(b);
  a = undefined;
  b = undefined;
});

test.describe('real Asterisk: reload-safe calls', () => {
  test('1002 reloads mid-call: same call back, audio both ways, 1001 never got a BYE; hangup ends both', async ({ browser }) => {
    test.setTimeout(120_000);
    a = await openPhone(browser, '1001');
    b = await openResumePhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);
    await expectCallState(a, 'connected');
    const before = (await firstCall(b.page))!;
    expect(before.anchorId).toMatch(/^\d{6,}$/);
    const callerCall = (await firstCall(a.page))!;
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);
    await b.page.waitForTimeout(2000);

    await b.page.reload();
    // Back on the call screen at once, reconnecting, never the connect form.
    await expect(b.page.getByTestId('call-screen')).toBeVisible();
    await expect(b.page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(b.page.getByTestId('call-resuming')).toBeHidden({ timeout: 20_000 });
    await expect(b.page.getByTestId('event-log')).toContainText(`call:resumed ${before.id}`);
    const after = (await firstCall(b.page))!;
    expect(after).toMatchObject({ id: before.id, connectedAt: before.connectedAt, anchorId: before.anchorId, state: 'connected' });
    await expectCallState(b, 'connected');

    // Two-way audio again on the new peer connection; the caller's call never changed.
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);
    expect(await firstCall(a.page)).toMatchObject({ id: callerCall.id, state: 'connected' });
    expect(await cdrCount(a)).toBe(0);

    // A real hangup from the reloaded page ends the anchor room: 1001 gets its BYE.
    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 });
    await expect(a.page.getByTestId('event-log').locator('li', { hasText: 'cdr outgoing 1002' })).toContainText('(remote-hangup)');
  });

  test('the caller hanging up ends the anchored call on the agent side', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openResumePhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);
    await expectMediaFlowing(b);
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 });
    await expect(b.page.getByTestId('event-log').locator('li', { hasText: 'cdr incoming' })).toContainText('(remote-hangup)');
  });

  test('outgoing calls are anchored too: 1002 dials 1001, reloads, comes back', async ({ browser }) => {
    test.setTimeout(120_000);
    a = await openPhone(browser, '1001');
    b = await openResumePhone(browser, '1002');
    await dial(b, '1001');
    await answerIncoming(a);
    await expectCallState(b, 'connected');
    const before = (await firstCall(b.page))!;
    expect(before.anchorId).toMatch(/^\d{16}$/);
    await b.page.reload();
    await expect(b.page.getByTestId('event-log')).toContainText(`call:resumed ${before.id}`, { timeout: 20_000 });
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);
    expect(await cdrCount(a)).toBe(0);
    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 });
  });

  test('agent never comes back: the caller hears hold music, then the fallback ends the call', async ({ browser }) => {
    test.setTimeout(120_000);
    a = await openPhone(browser, '1001');
    // 1003 has no mailbox, so the fallback (voicemail, else hang up) hangs up.
    b = await openResumePhone(browser, '1003', 10_000);
    await dial(a, '1003');
    await answerIncoming(b);
    await expectMediaFlowing(a);
    // The agent's tab disappears without a BYE.
    await b.context.close();
    b = undefined;
    const gone = Date.now();
    // The PBX notices the dead leg within ~1-2 s (its contact is gone) and waits 10 s for a rejoin:
    // no hangup for the caller meanwhile, and hold music keeps flowing to it.
    await a.page.waitForTimeout(3000);
    await expectCallState(a, 'connected');
    await expectMediaFlowing(a);
    expect(await cdrCount(a)).toBe(0);
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 30_000 });
    expect(Date.now() - gone).toBeGreaterThan(9000);
    expect(Date.now() - gone).toBeLessThan(20_000);
    await expect(a.page.getByTestId('event-log').locator('li', { hasText: 'cdr outgoing 1003' })).toContainText('(remote-hangup)');
  });

  test('sip-gateway mode: the gateway anchors the browser leg; a reload comes back', async ({ browser }) => {
    test.setTimeout(120_000);
    // The gateway profile (infra/asterisk gateway) registers 1001 upstream as 2099.
    b = await openResumePhone(browser, '1001', undefined, GATEWAY_WSS_URL);
    a = await openPhone(browser, '1002');
    await dial(b, '1002');
    await answerIncoming(a);
    await expectCallState(b, 'connected');
    const before = (await firstCall(b.page))!;
    expect(before.anchorId).toMatch(/^\d{16}$/);
    await b.page.reload();
    await expect(b.page.getByTestId('event-log')).toContainText(`call:resumed ${before.id}`, { timeout: 20_000 });
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);
    expect(await cdrCount(a)).toBe(0);
    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 });
  });
});
