import { expect, test } from '@playwright/test';
import { closePhone, dial, expectCallState, openPhone, type Phone } from './helpers';

/**
 * Voicemail (MWI, V2-VM-01) and Do Not Disturb (V2-FWD-01) against the dev PBX.
 * Dial plan (infra/asterisk/config/pbx/extensions.conf):
 *   *99XXXX  purge mailbox XXXX     8XXXX  leave a message for XXXX     *97  voicemail menu
 */
test.describe('real Asterisk: voicemail and DND', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('MWI: 1002 sees a voicemail that 1001 leaves, then dials voicemail from the badge', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    a = await openPhone(browser, '1001');

    // Idempotent: empty mailbox 1002 first (pollmailboxes publishes the change).
    await dial(a, '*991002');
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 15_000 });

    b = await openPhone(browser, '1002');
    const badge = b.page.getByTestId('voicemail-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-count', '0');

    // Leave a message: greeting + beep, then a few seconds of fake microphone audio.
    await dial(a, '81002');
    await expectCallState(a, 'connected');
    await a.page.waitForTimeout(10_000);
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();

    await expect
      .poll(async () => Number(await badge.getAttribute('data-count')), {
        message: '1002 voicemail badge should count the new message',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect(badge).toHaveAttribute('data-waiting', 'true');

    // One click dials the voicemail access number (*97 -> VoiceMailMain).
    await badge.click();
    await expectCallState(b, 'connected');
    await expect(b.page.getByTestId('call-title')).toContainText('*97');
    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
  });

  test('DND: 1001 calling 1002 gets busy at once and 1002 never rings', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');

    const toggle = b.page.getByTestId('dnd-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await a.page.getByLabel('Number to dial').fill('1002');
    await a.page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(a.page.getByTestId('event-log')).toContainText(/cdr outgoing 1002 0s \(busy\)/, {
      timeout: 5_000,
    });
    await expect(a.page.getByTestId('call-screen')).toBeHidden();

    // 1002 recorded the rejection but never created (or showed) an incoming call.
    await expect(b.page.getByTestId('event-log')).toContainText('(dnd)');
    await expect(b.page.getByTestId('event-log')).not.toContainText('call:created');
    await expect(b.page.getByTestId('incoming-call')).toBeHidden();

    // DND off: calls ring again.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await dial(a, '1002');
    await expect(b.page.getByTestId('incoming-call')).toBeVisible();
  });
});
