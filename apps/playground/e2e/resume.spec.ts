import { expect, test, type Page } from '@playwright/test';

/** Reload-safe softphone with the mock engine (docs/resume.md, V2-RESUME-01). */

async function enableResumeAndLogin(page: Page) {
  await page.goto('/');
  await page.getByLabel(/^Survive reload \(resume\)/).check();
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

const snapshotCall = (page: Page) =>
  page.evaluate(() => {
    const c = window.__softphone!.getSnapshot().calls[0];
    return c ? { id: c.id, connectedAt: c.connectedAt, state: c.state, muted: c.muted, resuming: c.resuming } : null;
  });

/** Seconds shown by the call timer ("0:07" -> 7). */
async function timerSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('call-status').textContent()) ?? '';
  const m = /(\d+):(\d{2})/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

test.describe('resume (mock engine)', () => {
  test('a reload during a call restores it with the same id; the timer keeps counting', async ({ page }) => {
    await enableResumeAndLogin(page);
    await page.getByTestId('simulate-incoming').click();
    await page.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    const screen = page.getByTestId('call-screen');
    await expect(screen).toHaveAttribute('data-call-state', 'connected');
    await page.getByRole('button', { name: 'Mute' }).click();
    await page.waitForTimeout(3000);
    const before = (await snapshotCall(page))!;
    expect(before.muted).toBe(true);
    const secondsBefore = await timerSeconds(page);
    expect(secondsBefore).toBeGreaterThanOrEqual(2);

    await page.reload();

    // Straight back on the call screen, reconnecting; never the login form.
    await expect(screen).toBeVisible();
    await expect(page.getByTestId('call-resuming')).toBeVisible();
    await expect(page.getByTestId('call-resuming')).toContainText('Reconnecting call…');
    await expect(page.getByLabel('Extension / username')).toBeHidden();
    const restored = (await snapshotCall(page))!;
    expect(restored.id).toBe(before.id);
    expect(restored.connectedAt).toBe(before.connectedAt);
    expect(restored.muted).toBe(true);

    await expect(page.getByTestId('call-resuming')).toBeHidden();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(page.getByTestId('event-log')).toContainText(`call:resumed ${before.id}`);
    expect(await timerSeconds(page)).toBeGreaterThanOrEqual(secondsBefore);
    await expect.poll(() => timerSeconds(page)).toBeGreaterThan(secondsBefore + 1);

    // A real hangup ends it; the next reload restores nothing.
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(screen).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(screen).toBeHidden();
  });

  test('Nepali banner while reconnecting', async ({ page }) => {
    await enableResumeAndLogin(page);
    await page.getByLabel('Number to dial').fill('1002');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await page.reload();
    await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'नेपाली' }).click();
    await expect(page.getByTestId('call-resuming')).toContainText('कल पुनः जोड्दै…');
    await expect(page.getByTestId('call-resuming')).toBeHidden();
  });
});
