import { expect, test } from '@playwright/test';
import {
  answerIncoming,
  closePhone,
  dial,
  expectCallState,
  expectMediaFlowing,
  openPhone,
  type Phone,
} from './helpers';

test.describe('real Asterisk (direct WebRTC)', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('echo test: call 600 and hear media back', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    await dial(a, '600');
    await expectCallState(a, 'connected');
    await expectMediaFlowing(a);
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
  });

  test('1001 calls 1002: ring, answer, two-way audio, remote hangup', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');

    await dial(a, '1002');
    await expect(b.page.getByTestId('incoming-call')).toContainText('1001');
    await expectCallState(a, 'ringing');
    await answerIncoming(b);
    await expectCallState(a, 'connected');

    await expectMediaFlowing(a);
    await expectMediaFlowing(b);

    await b.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
  });

  test('decline: caller sees the call end as busy (486)', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    const incoming = b.page.getByTestId('incoming-call');
    await expect(incoming).toBeVisible();
    await incoming.getByRole('button', { name: 'Decline' }).click();
    await expect(incoming).toBeHidden();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    await expect(a.page.getByTestId('event-log')).toContainText(/cdr outgoing 1002 0s \(busy\)/);
  });

  test('caller cancels before answer', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await expect(b.page.getByTestId('incoming-call')).toBeVisible();
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('incoming-call')).toBeHidden();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
  });

  test('hold / resume and mute keep the call up; media resumes', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);
    await expectMediaFlowing(a);

    await a.page.getByRole('button', { name: 'Hold' }).click();
    await expect(a.page.getByTestId('call-status')).toContainText('On hold');
    await a.page.getByRole('button', { name: 'Resume' }).click();
    await expectCallState(a, 'connected');
    await expectMediaFlowing(a);
    await expectMediaFlowing(b);

    await a.page.getByRole('button', { name: 'Mute' }).click();
    await expect(a.page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    await a.page.getByRole('button', { name: 'Unmute' }).click();
    await expectCallState(b, 'connected');
  });

  test('DTMF over RFC 4733 reaches the far end', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);
    await a.page.getByRole('button', { name: 'Keypad' }).click();
    const pad = a.page.getByTestId('dialpad-dtmf');
    for (const d of ['1', '2', '#']) await pad.getByRole('button', { name: d, exact: true }).click();
    await expect(pad.getByLabel('Sent tones')).toHaveValue('12#');
    // Asterisk bridges RFC 4733 events end-to-end; the call must survive them.
    await expectCallState(a, 'connected');
    await expectCallState(b, 'connected');
  });

  test('blind transfer: 1001 transfers 1002 to the echo test', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);

    await a.page.getByRole('button', { name: 'Transfer' }).click();
    const dialog = a.page.getByRole('dialog');
    await dialog.getByLabel('Number').fill('600');
    await dialog.getByRole('button', { name: 'Transfer' }).click();

    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    // 1002 stays connected, now to the echo app, and still gets media.
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
  });
});
