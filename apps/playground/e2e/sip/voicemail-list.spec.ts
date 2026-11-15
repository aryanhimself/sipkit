import { expect, test, type Page } from '@playwright/test';
import { mintToken } from '../../../../services/voicemail-api/src/token';
import { closePhone, dial, expectCallState, openPhone, type Phone } from './helpers';

/**
 * Voicemail list (V2-VM-02) against a real Asterisk + services/voicemail-api
 * sharing its spool. 1001 leaves a message for 1002 (8XXXX), then 1002 lists,
 * plays, marks it heard (the MWI badge drops: AMI VoicemailRefresh → NOTIFY)
 * and deletes it.
 *
 *   E2E_VOICEMAIL_API_URL       voicemail-api reachable from the browser (default: compose service)
 *   E2E_VOICEMAIL_TOKEN_SECRET  VM_TOKEN_SECRET of that service: the test mints a short-lived HMAC token
 *   E2E_VOICEMAIL_TOKEN         else a static / dev token (compose default "sipkit-dev-voicemail")
 */
const API_URL = process.env.E2E_VOICEMAIL_API_URL || 'http://172.28.0.21:8090';
const SECRET = process.env.E2E_VOICEMAIL_TOKEN_SECRET;
const token = () =>
  SECRET ? mintToken(SECRET, { mailbox: '1002', ttlSeconds: 600 }) : process.env.E2E_VOICEMAIL_TOKEN || 'sipkit-dev-voicemail';

async function apiList(): Promise<{ counts: { new: number; old: number }; messages: { id: string }[] }> {
  const res = await fetch(`${API_URL}/v1/mailboxes/1002/messages`, { headers: { Authorization: `Bearer ${token()}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

async function withVoicemailApi(page: Page): Promise<void> {
  await page.getByLabel('Voicemail API (optional)').fill(API_URL);
  await page.getByLabel('Voicemail token').fill(token());
}

test.describe('real Asterisk: voicemail list', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('1002 lists, plays, marks heard and deletes a voicemail 1001 left', async ({ browser }) => {
    test.setTimeout(120_000);
    const health = await fetch(`${API_URL}/healthz`).catch(() => null);
    test.skip(!health?.ok, `voicemail-api not reachable at ${API_URL}`);

    a = await openPhone(browser, '1001');
    // Idempotent: empty mailbox 1002 first.
    await dial(a, '*991002');
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => (await apiList()).messages.length, { timeout: 10_000 }).toBe(0);

    b = await openPhone(browser, '1002', undefined, withVoicemailApi);
    const badge = b.page.getByTestId('voicemail-badge');
    await expect(badge).toHaveAttribute('data-count', '0');
    await b.page.getByRole('tab', { name: /Voicemail/ }).click();
    await expect(b.page.getByTestId('voicemail-panel')).toHaveAttribute('data-status', 'ready');
    await expect(b.page.getByText('No voicemail')).toBeVisible();

    // 1001 leaves a message: greeting + beep, then a few seconds of fake microphone audio.
    await dial(a, '81002');
    await expectCallState(a, 'connected');
    await a.page.waitForTimeout(8_000);
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();

    // MWI NOTIFY bumps the badge and reloads the list on its own (no polling, no click).
    await expect(badge).toHaveAttribute('data-count', '1', { timeout: 20_000 });
    const item = b.page.getByTestId('voicemail-item');
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect(item).toHaveAttribute('data-folder', 'new');
    await expect(item).toContainText('1001');
    await expect(b.page.getByTestId('voicemail-tab-badge')).toHaveAttribute('data-count', '1');

    // Play: the WAV streams through the API (bearer auth) into an <audio> element that decodes it.
    await item.getByTestId('voicemail-play').click();
    const audio = item.getByTestId('voicemail-audio');
    await expect(audio).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => (Number.isFinite(el.duration) ? el.duration : 0)), {
        message: 'the recording should decode',
        timeout: 10_000,
      })
      .toBeGreaterThan(1);
    // Range requests work on the same URL (seeking in direct-URL players).
    const id = (await item.getAttribute('data-id'))!;
    const ranged = await fetch(`${API_URL}/v1/mailboxes/1002/messages/${encodeURIComponent(id)}/audio`, {
      headers: { Authorization: `Bearer ${token()}`, Range: 'bytes=0-3' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await ranged.arrayBuffer()).toString('latin1')).toBe('RIFF');

    // Mark heard: INBOX → Old on disk, AMI VoicemailRefresh, the PBX's MWI NOTIFY drops the badge.
    await item.getByTestId('voicemail-mark-read').click();
    await expect(item).toHaveAttribute('data-folder', 'old');
    await expect(badge).toHaveAttribute('data-count', '0', { timeout: 10_000 });
    await expect(b.page.getByTestId('voicemail-tab-badge')).toHaveCount(0);
    expect((await apiList()).counts).toEqual(expect.objectContaining({ new: 0, old: 1 }));
    await expect(b.page.getByTestId('event-log')).toContainText('voicemail 0 new / 1 old');

    // Delete (with confirmation): gone from the list and from the spool.
    await item.getByTestId('voicemail-delete').click();
    await b.page.getByTestId('voicemail-confirm-delete').click();
    await expect(item).toHaveCount(0);
    await expect(b.page.getByText('No voicemail')).toBeVisible();
    expect((await apiList()).messages).toHaveLength(0);
    await expect(b.page.getByTestId('event-log')).toContainText('voicemail 0 new / 0 old', { timeout: 10_000 });
  });
});
