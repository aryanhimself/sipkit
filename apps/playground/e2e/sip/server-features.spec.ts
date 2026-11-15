import { expect, test, type Browser } from '@playwright/test';
import { PASSWORD, WSS_URL, closePhone, dial, answerIncoming, expectCallState, expectMediaFlowing, type Phone } from './helpers';

/**
 * Server-side DND (*78 / *79 / *76 + astdb) and ConfBridge conference mode
 * against the dev PBX dialplan (infra/asterisk/config/pbx, docs/server-features.md).
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

/** openPhone() with the playground's server-feature selects set. */
async function openServerPhone(
  browser: Browser,
  user: string,
  modes: { dnd?: 'local' | 'server' | 'both'; conference?: 'local' | 'server' },
): Promise<Phone> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  page.on('console', (m) => {
    if (process.env.E2E_DEBUG || m.type() === 'error') console.log(`[${user} console.error] ${m.text()}`);
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Real Asterisk' }).click();
  await page.getByLabel('WebSocket URL').fill(WSS_URL);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  if (modes.dnd) await page.getByLabel('DND mode').selectOption(modes.dnd);
  if (modes.conference) await page.getByLabel('Conference mode').selectOption(modes.conference);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
  return { context, page, user };
}

/** Wait until no feature-code call is running. */
async function dndSettled(phone: Phone): Promise<string | null> {
  const toggle = phone.page.getByTestId('dnd-toggle');
  await expect.poll(() => toggle.getAttribute('data-pending')).toBeNull();
  return toggle.getAttribute('data-state');
}

/** 1001 calls 1002 and expects an immediate busy (486) without 1002 seeing anything. */
async function expectBusy(a: Phone): Promise<void> {
  const cdrs = a.page.getByTestId('event-log').locator('li', { hasText: 'cdr outgoing 1002' });
  const before = await cdrs.count();
  await a.page.evaluate(() => window.__softphone!.call('1002'));
  await expect(cdrs).toHaveCount(before + 1);
  await expect(cdrs.first()).toContainText('(busy)');
}

let a: Phone | undefined;
let b: Phone | undefined;

test.afterEach(async () => {
  await closePhone(a);
  await closePhone(b);
  a = undefined;
  b = undefined;
});

test.describe('real Asterisk: server-side features', () => {
  test('server DND: 1002 busy without an INVITE, even with the tab closed; off rings again', async ({ browser }) => {
    try {
      b = await openServerPhone(browser, '1002', { dnd: 'server' });
      expect(await dndSettled(b)).toBe('off'); // *76 query on register
      await b.page.getByTestId('dnd-toggle').click();
      expect(await dndSettled(b)).toBe('on'); // *78 answered
      await expect(b.page.getByTestId('event-log')).toContainText('dnd → on');

      a = await openServerPhone(browser, '1001', {});
      await expectBusy(a);
      // 1002's browser never got an INVITE: no incoming call, no missed-call CDR.
      await expect(b.page.getByTestId('incoming-call')).toBeHidden();
      await expect(b.page.getByTestId('event-log')).not.toContainText('call:created');
      await expect(b.page.getByTestId('event-log')).not.toContainText('cdr');

      // Close 1002's tab: the PBX still answers busy.
      await closePhone(b);
      b = undefined;
      await expectBusy(a);

      // A fresh 1002 tab adopts the server state (*76) and turns it off (*79).
      b = await openServerPhone(browser, '1002', { dnd: 'server' });
      expect(await dndSettled(b)).toBe('on');
      await b.page.getByTestId('dnd-toggle').click();
      expect(await dndSettled(b)).toBe('off');
      await a.page.evaluate(() => window.__softphone!.call('1002'));
      await expect(b.page.getByTestId('incoming-call')).toBeVisible();
      await b.page.getByTestId('incoming-call').getByRole('button', { name: 'Decline' }).click();
    } finally {
      // Never leave 1002 on server DND for the other specs.
      if (!b) b = await openServerPhone(browser, '1002', { dnd: 'server' });
      await dndSettled(b);
      await b.page.evaluate(() => window.__softphone!.setDnd(false).catch(() => undefined));
      await dndSettled(b);
    }
  });

  test('ConfBridge: merge moves 1002 and the echo party into room 71001, which survives 1001 leaving', async ({ browser }) => {
    a = await openServerPhone(browser, '1001', { conference: 'server' });
    b = await openServerPhone(browser, '1002', {});
    await dial(a, '1002');
    await answerIncoming(b);
    // Second party: the echo test behind a Local channel (a bridged, transferable party).
    await a.page.evaluate(() => window.__softphone!.call('6000'));
    await expect
      .poll(() => a!.page.evaluate(() => window.__softphone!.getSnapshot().calls.find((c) => c.remoteNumber === '6000')?.state))
      .toBe('connected');

    await a.page.getByRole('button', { name: 'Merge' }).click();
    const panel = a.page.getByRole('region', { name: 'Conference', exact: true });
    await expect(panel.getByTestId('conference-room')).toHaveText('Room 71001');
    await expect(panel.getByTestId('conference-party')).toHaveCount(2);
    await expect
      .poll(() =>
        a!.page.evaluate(() =>
          window.__softphone!.getSnapshot().calls.map((c) => `${c.remoteNumber}:${c.state}:${c.conference?.participants.length ?? '-'}`),
        ),
      )
      .toEqual(['71001:connected:2']);
    // No per-party controls for a server room.
    await expect(panel.getByRole('button', { name: /^Mute / })).toHaveCount(0);

    // 1002 is now talking to the ConfBridge (re-INVITEd by Asterisk), media flows both ways.
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);

    // 1001 leaves; the room (1002 + echo) keeps going.
    await panel.getByTestId('conference-end').click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    await b.page.waitForTimeout(2000);
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
    await b.page.evaluate(() => window.__softphone!.hangupAll());
  });
});
