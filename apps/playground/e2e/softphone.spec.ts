import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, user = '1001', password = 'secret') {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

test.describe('softphone (mock engine)', () => {
  test('login', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('registration-pill')).toHaveText('Online');
    await expect(page.getByLabel('Number to dial')).toBeVisible();
  });

  test('failed login shows the reason', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Extension / username').fill('1001');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').first()).toContainText('403');
  });

  test('dial, connect, hold, mute, DTMF, hang up', async ({ page }) => {
    await login(page);
    for (const key of ['1', '0 (hold for +)', '0 (hold for +)', '2']) {
      await page.getByRole('button', { name: key, exact: true }).click();
    }
    await expect(page.getByLabel('Number to dial')).toHaveValue('1002');
    await page.getByRole('button', { name: 'Call', exact: true }).click();

    const callScreen = page.getByTestId('call-screen');
    await expect(callScreen).toBeVisible();
    await expect(page.getByTestId('call-title')).toHaveText('Alice Johnson');
    // The mock rings for only 1.5 s, so a loaded machine can miss the live "Ringing"
    // text; the event log keeps the transition.
    await expect(page.getByTestId('event-log')).toContainText('setup → ringing');
    await expect(callScreen).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await expect(page.getByTestId('call-status')).toHaveText(/^\d+:\d{2}$/);

    await page.getByRole('button', { name: 'Hold' }).click();
    await expect(page.getByTestId('call-status')).toContainText('On hold');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(callScreen).toHaveAttribute('data-call-state', 'connected');

    await page.getByRole('button', { name: 'Mute' }).click();
    await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Keypad' }).click();
    const dtmf = page.getByTestId('dialpad-dtmf');
    await dtmf.getByRole('button', { name: '5', exact: true }).click();
    await dtmf.getByRole('button', { name: '#', exact: true }).click();
    await expect(dtmf.getByLabel('Sent tones')).toHaveValue('5#');
    const sent = await page.evaluate(() =>
      (window.__softphone as unknown as { dtmfLog: { tones: string }[] }).dtmfLog.map((d) => d.tones).join(''),
    );
    expect(sent).toBe('5#');

    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(callScreen).toBeHidden();
    await expect(page.getByLabel('Number to dial')).toBeVisible();

    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('list', { name: 'Call history' })).toContainText('Alice Johnson');
  });

  test('keyboard: type + Enter calls, Esc hangs up', async ({ page }) => {
    await login(page);
    await page.getByLabel('Number to dial').fill('1003');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('call-screen')).toBeHidden();
  });

  test('incoming call: answer', async ({ page }) => {
    await login(page);
    await page.getByTestId('simulate-incoming').click();
    const incoming = page.getByTestId('incoming-call');
    await expect(incoming).toBeVisible();
    await expect(incoming).toContainText('Jane Customer');
    await expect(incoming).toContainText('Globex');
    await incoming.getByRole('button', { name: 'Answer' }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(page.getByTestId('call-title')).toHaveText('Jane Customer');
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();
  });

  test('incoming call: Enter answers, Esc rejects', async ({ page }) => {
    await login(page);
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toBeVisible();
    await page.getByRole('button', { name: 'Answer' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('call-screen')).toBeHidden();

    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toBeVisible();
    await page.getByRole('button', { name: 'Decline' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('incoming-call')).toBeHidden();
  });

  test('voicemail badge counts messages and dials voicemail', async ({ page }) => {
    await login(page);
    const badge = page.getByTestId('voicemail-badge');
    await expect(badge).toHaveAttribute('data-count', '0');
    await page.getByTestId('simulate-voicemail').click();
    await page.getByTestId('simulate-voicemail').click();
    await expect(badge).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('voicemail-count')).toHaveText('2');
    await badge.click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await expect(page.getByTestId('call-title')).toContainText('*97');
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();
  });

  test('do not disturb rejects incoming calls without ringing', async ({ page }) => {
    await login(page);
    const toggle = page.getByTestId('dnd-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('event-log')).toContainText('(dnd)');
    await expect(page.getByTestId('incoming-call')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toBeVisible();
  });

  test('transfer dialog (blind)', async ({ page }) => {
    await login(page);
    await page.getByLabel('Number to dial').fill('1004');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await page.getByRole('button', { name: 'Transfer' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Number').fill('1009');
    await dialog.getByRole('button', { name: 'Transfer' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();
  });

  test('conference panel: merge 3 parties, mute, remove, hang up one, split', async ({ page }) => {
    await login(page);
    await page.evaluate(() => window.__softphone!.updateConfig({ maxLines: 4 }));
    await page.getByLabel('Number to dial').fill('1002');
    await page.keyboard.press('Enter');
    const callScreen = page.getByTestId('call-screen');
    await expect(callScreen).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    for (const n of ['1003', '1004']) {
      await page.getByRole('button', { name: 'Add call' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Number').fill(n);
      await dialog.getByRole('button', { name: 'Call' }).click();
      await expect(callScreen).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    }
    await page.getByRole('button', { name: 'Merge' }).click();

    const panel = page.getByRole('region', { name: 'Conference', exact: true });
    const parties = panel.getByTestId('conference-party');
    await expect(parties).toHaveCount(3);
    await expect(parties.first().getByTestId('conference-party-status')).toHaveText(/^\d+:\d{2}$/);

    const party = (line: number) => panel.locator(`[data-testid="conference-party"][data-line="${line}"]`);
    await party(1).getByRole('button', { name: /^Mute / }).click();
    await expect(party(1).getByRole('button', { name: /^Unmute / })).toHaveAttribute('aria-pressed', 'true');

    await party(3).getByRole('button', { name: /from conference$/ }).click();
    await expect(parties).toHaveCount(2);
    await expect(page.getByRole('tablist', { name: 'Lines' }).getByRole('tab').nth(2)).toContainText('Hold');

    // Bring line 3 back in, then hang up one party from the roster
    await page.getByRole('button', { name: 'Merge' }).click();
    await expect(parties).toHaveCount(3);
    await party(2).getByRole('button', { name: /^Hang up / }).click();
    await expect(parties).toHaveCount(2);

    await panel.getByTestId('conference-split').click();
    await expect(panel).toBeHidden();
    const states = await page.evaluate(() => window.__softphone!.getSnapshot().calls.map((c) => [c.state, c.inConference]));
    expect(states.filter(([s]) => s === 'connected')).toHaveLength(1);
    expect(states.filter(([s]) => s === 'held')).toHaveLength(1);
    expect(states.every(([, inConf]) => !inConf)).toBe(true);
  });

  test('mock badge; a failed call explains why; the event log wraps long lines', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('mock-badge')).toContainText('Not connected to any SIP server');

    await page.getByLabel('Number to dial').fill('1002');
    await page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await page.getByTestId('simulate-call-404').click();
    const alert = page.getByTestId('call-failure');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('Number not reachable (404)');
    await expect(page.getByTestId('event-log')).toContainText('(failed) SIP 404');

    // No horizontal clipping: the log never scrolls sideways.
    const log = page.getByTestId('event-log');
    const overflow = await log.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(alert).toBeHidden();
  });

  test('full-width layout', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'Full width' }).click();
    await page.getByLabel('Extension / username').fill('1001');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(page.getByLabel('Number to dial')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'CRM' })).toBeVisible();
  });
});

test.describe('plain-HTML embed (IIFE web component)', () => {
  test('renders in shadow DOM, dials and emits DOM events', async ({ page }) => {
    await page.goto('/embed-demo.html');
    const host = page.locator('sipkit-phone');
    // Playwright locators pierce open shadow roots.
    await expect(host.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(host.getByTestId('brand-name')).toHaveText('Acme Phone');
    await expect(host.getByRole('tab', { name: 'Contacts' })).toHaveCount(0);

    // Host CSS (hotpink buttons) must not leak into the widget.
    const bg = await host.getByRole('button', { name: '5', exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 105, 180)');

    await host.getByLabel('Number to dial').fill('1002');
    await host.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(host.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });

    // Dialog inputs work inside the shadow root (non-modal dialog there).
    await host.getByRole('button', { name: 'Transfer' }).click();
    const dialog = host.getByRole('dialog');
    await dialog.getByLabel('Number').fill('1009');
    await expect(dialog.getByLabel('Number')).toHaveValue('1009');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await host.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.locator('#log')).toContainText('sipkit:call created 1002');
    await expect(page.locator('#log')).toContainText('sipkit:cdr 1002 local-hangup');
  });
});
