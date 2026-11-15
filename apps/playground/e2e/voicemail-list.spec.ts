import { expect, test, type Page } from '@playwright/test';

/** Voicemail list (V2-VM-02) against the mock engine's in-memory mailbox (no voicemail-api needed). */
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

test.describe('voicemail list (mock engine)', () => {
  test('list, play, mark heard, call back and delete', async ({ page }) => {
    await login(page);
    const badge = page.getByTestId('voicemail-badge');
    await page.getByTestId('simulate-voicemail').click(); // Jane Customer
    await page.getByTestId('simulate-voicemail').click(); // 1002 (Alice Johnson in the demo contacts)
    await expect(badge).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('voicemail-tab-badge')).toHaveAttribute('data-count', '2');

    await page.getByRole('tab', { name: /Voicemail/ }).click();
    const items = page.getByTestId('voicemail-item');
    await expect(items).toHaveCount(2);
    const jane = items.filter({ hasText: 'Jane Customer' });
    await expect(jane).toHaveAttribute('data-folder', 'new');
    await expect(jane).toContainText('0:14');

    // Play: the recording loads through the API into an <audio> element and plays.
    await jane.getByRole('button', { name: 'Play voicemail from Jane Customer' }).click();
    const audio = jane.getByTestId('voicemail-audio');
    await expect(audio).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0);

    // Mark heard: list + MWI badge drop.
    await jane.getByRole('button', { name: 'Mark voicemail from Jane Customer as heard' }).click();
    await expect(jane).toHaveAttribute('data-folder', 'old');
    await expect(badge).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('voicemail-counts')).toHaveText('1 new · 1 saved');

    // Delete asks first.
    await jane.getByRole('button', { name: 'Delete voicemail from Jane Customer' }).click();
    await page.getByTestId('voicemail-confirm').getByRole('button', { name: 'Cancel' }).click();
    await expect(items).toHaveCount(2);
    await jane.getByRole('button', { name: 'Delete voicemail from Jane Customer' }).click();
    await page.getByTestId('voicemail-confirm-delete').click();
    await expect(items).toHaveCount(1);
    await expect(audio).toHaveCount(0);

    // Call back from the remaining message.
    await items.first().getByTestId('voicemail-call-back').click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await expect(page.getByTestId('call-title')).toContainText(/Alice Johnson|1002/);
    await page.getByRole('button', { name: 'Hang up' }).click();
  });

  test('API errors show a retry', async ({ page }) => {
    await login(page);
    await page.getByRole('tab', { name: /Voicemail/ }).click();
    await expect(page.getByText('No voicemail')).toBeVisible();
    await page.getByTestId('simulate-voicemail-error').click();
    await page.getByTestId('voicemail-refresh').click();
    await expect(page.getByTestId('voicemail-error')).toContainText("Couldn't load voicemail.");
    await page.getByTestId('voicemail-error').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('voicemail-error')).toBeHidden();
  });

  test('Nepali strings', async ({ page }) => {
    await login(page);
    await page.getByTestId('simulate-voicemail').click();
    await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'नेपाली' }).click();
    await page.getByRole('tab', { name: /भ्वाइसमेल/ }).click();
    await expect(page.getByTestId('voicemail-item')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Jane Customer को भ्वाइसमेल बजाउनुहोस्' })).toBeVisible();
    await expect(page.getByTestId('voicemail-counts')).toHaveText(/^(१|1) नयाँ · (०|0) सुरक्षित$/);
  });
});
