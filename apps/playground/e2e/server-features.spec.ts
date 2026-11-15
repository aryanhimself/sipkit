import { expect, test, type Page } from '@playwright/test';

/** Mock engine coverage for server-side DND and ConfBridge conference mode (docs/server-features.md). */
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

const serverFeatures = (page: Page) => page.getByRole('group', { name: 'Server features' });

test.describe('server features (mock engine)', () => {
  test('server DND: pending while the feature code runs, PBX swallows calls, failure reverts', async ({ page }) => {
    await login(page);
    await serverFeatures(page).getByRole('radiogroup', { name: 'DND mode' }).getByRole('radio', { name: 'Server' }).click();

    const toggle = page.getByTestId('dnd-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'on');
    await expect(toggle).toHaveAttribute('data-pending', 'true');
    await expect(toggle).not.toHaveAttribute('data-pending', 'true');

    // The PBX answers busy: the browser sees nothing at all (no ringing, no missed-call CDR).
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toBeHidden();
    await expect(page.getByTestId('event-log')).not.toContainText('(dnd)');

    // A failing feature code reverts the toggle and tells the user.
    await page.getByTestId('fail-next-dnd').click();
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'off');
    await expect(page.getByText('Could not turn Do Not Disturb off on the phone system (SIP 404)')).toBeVisible();
    await expect(toggle).toHaveAttribute('data-state', 'on');

    await toggle.click();
    await expect(toggle).not.toHaveAttribute('data-pending', 'true');
    await expect(toggle).toHaveAttribute('data-state', 'off');
    await page.getByTestId('simulate-incoming').click();
    await expect(page.getByTestId('incoming-call')).toBeVisible();
  });

  test('ConfBridge conference: merge moves parties into the room, panel follows capabilities', async ({ page }) => {
    await login(page);
    await serverFeatures(page)
      .getByRole('radiogroup', { name: 'Conference mode' })
      .getByRole('radio', { name: 'ConfBridge' })
      .click();
    const callScreen = page.getByTestId('call-screen');
    await page.getByLabel('Number to dial').fill('1002');
    await page.keyboard.press('Enter');
    await expect(callScreen).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await page.getByRole('button', { name: 'Add call' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Number').fill('1003');
    await dialog.getByRole('button', { name: 'Call' }).click();
    await expect(callScreen).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await page.getByRole('button', { name: 'Merge' }).click();

    const panel = page.getByRole('region', { name: 'Conference', exact: true });
    await expect(panel.getByTestId('conference-room')).toHaveText('Room 71001');
    await expect(panel.getByTestId('conference-party')).toHaveCount(2);
    await expect(page.getByTestId('call-title')).toHaveText('Conference call');
    // Per-party control is not available for a server room.
    await expect(panel.getByRole('button', { name: /^Mute / })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /from conference$/ })).toHaveCount(0);
    await expect(panel.getByTestId('conference-split')).toHaveCount(0);
    await expect(page.getByTestId('event-log')).toContainText('(transferred)');
    const calls = await page.evaluate(() =>
      window.__softphone!.getSnapshot().calls.map((c) => [c.remoteNumber, c.conference?.participants.length]),
    );
    expect(calls).toEqual([['71001', 2]]);

    await panel.getByTestId('conference-end').click();
    await expect(callScreen).toBeHidden();
  });
});
