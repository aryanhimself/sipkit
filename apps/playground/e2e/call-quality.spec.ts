import { expect, test } from '@playwright/test';

test.describe('call quality indicator (mock engine)', () => {
  test('starts good, degrades under simulated loss, recovers', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Extension / username').fill('1001');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');

    await page.getByLabel('Number to dial').fill('1002');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });

    const indicator = page.getByTestId('call-quality');
    await expect(indicator).toHaveAttribute('data-level', 'good');
    await expect(indicator).toHaveAccessibleName('Call quality: Good');

    await page.getByTestId('network-poor').click();
    await expect(indicator).toHaveAttribute('data-level', 'poor');
    await expect(indicator).toHaveAccessibleName('Call quality: Poor');
    await indicator.hover();
    await expect(page.getByRole('tooltip')).toContainText('15.0%');

    // Recovery needs two consecutive good samples (hysteresis).
    await page.getByTestId('network-good').click();
    await expect(indicator).toHaveAttribute('data-level', 'good', { timeout: 10_000 });

    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('event-log')).toContainText(/cdr outgoing 1002 \d+s \(local-hangup\) quality poor minMOS/);
  });
});
