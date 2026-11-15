import { expect, test, type Page } from '@playwright/test';
import { answerIncoming, closePhone, dial, expectCallState, openPhone, type Phone } from './helpers';

/**
 * Presence / BLF (V2-PRES-01, V2-BLF-01) against the dev PBX:
 * pattern hints _1XXX / _2XXX in from-internal, directed pickup on **<ext>
 * (infra/asterisk/config/pbx/extensions.conf). 1003 is a third WebRTC user.
 */

/** Start watching extensions on an already-registered phone (runtime watch()). */
async function enableBlf(phone: Phone, targets: string[]): Promise<void> {
  await phone.page.evaluate(async (watch) => {
    const sp = window.__softphone!;
    await sp.updateConfig({ presence: { enabled: true, watch } });
  }, targets);
}

const lampState = (page: Page, target: string) =>
  page.evaluate((t) => window.__softphone?.getSnapshot().presence[t]?.state, target);

const tile = (page: Page, target: string) => page.locator(`[data-testid="blf-tile"][data-target="${target}"]`);

test.describe('real Asterisk: presence / BLF', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;
  let c: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    await closePhone(c);
    a = b = c = undefined;
  });

  test('1002 sees 1001 go idle → busy (echo call) → idle', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await enableBlf(b, ['1001']);

    await b.page.getByRole('tab', { name: 'Lamps' }).click();
    const lamp = tile(b.page, '1001');
    await expect(lamp).toHaveAttribute('data-state', 'idle');
    await expect(lamp).toContainText('Available');

    await dial(a, '600');
    await expectCallState(a, 'connected');
    await expect(lamp).toHaveAttribute('data-state', 'busy');
    await expect(lamp).toContainText('Busy');

    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    await expect(lamp).toHaveAttribute('data-state', 'idle');
    await expect(b.page.getByTestId('event-log')).toContainText('presence 1001 → busy');
  });

  test('ringing lamp shows the caller and 1002 picks up the call ringing at 1001', async ({ browser }) => {
    test.setTimeout(90_000);
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    c = await openPhone(browser, '1003');
    await enableBlf(b, ['1001']);
    await expect.poll(() => lampState(b!.page, '1001')).toBe('idle');

    // 1003 calls 1001; 1001 rings (and is never answered there).
    await dial(c, '1001');
    await expect(a.page.getByTestId('incoming-call')).toBeVisible();
    await b.page.getByRole('tab', { name: 'Lamps' }).click();
    const lamp = tile(b.page, '1001');
    await expect(lamp).toHaveAttribute('data-state', 'ringing');
    await expect(lamp).toContainText('Ringing · Agent 1003');
    expect(await b.page.evaluate(() => window.__softphone?.getSnapshot().presence['1001'])).toMatchObject({
      state: 'ringing',
      direction: 'incoming',
      remoteNumber: '1003',
    });

    // Directed pickup (**1001): 1002 gets the call, 1001 stops ringing.
    await lamp.getByRole('button', { name: /Pick up/ }).click();
    await expectCallState(b, 'connected');
    await expectCallState(c, 'connected');
    await expect(a.page.getByTestId('incoming-call')).toBeHidden();
    // The widget switched to the call screen; read the lamp from the snapshot.
    await expect.poll(() => lampState(b!.page, '1001')).not.toBe('ringing');

    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(c.page.getByTestId('call-screen')).toBeHidden();
    await expect.poll(() => lampState(b!.page, '1001')).toBe('idle');
  });

  test('watching an extension without a device reports it without breaking the others', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await enableBlf(b, ['1001', '1999']);
    await expect.poll(() => lampState(b!.page, '1001')).toBe('idle');
    // 1999 matches the _1XXX hint but has no endpoint: Asterisk still answers the SUBSCRIBE (dynamic hint)
    // and NOTIFYs a terminated dialog, so the lamp leaves 'unknown' (dialog-info has no 'offline').
    await expect.poll(() => lampState(b!.page, '1999')).not.toBe('unknown');
    await dial(a, '1002');
    await answerIncoming(b);
    await expect.poll(() => lampState(b!.page, '1001')).toBe('busy');
  });
});
