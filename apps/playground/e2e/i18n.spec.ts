import { expect, test } from '@playwright/test';

test.describe('i18n (mock engine)', () => {
  test('switches to Nepali live, then RTL pseudo-locale', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Extension / username').fill('1001');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');

    const widget = page.locator('.sipkit-phone');
    await expect(page.getByRole('button', { name: 'Call', exact: true })).toBeVisible();
    await expect(widget).toHaveAttribute('dir', 'ltr');

    await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'नेपाली' }).click();
    await expect(page.getByRole('button', { name: 'कल गर्नुहोस्', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Call', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('registration-pill')).toHaveText('अनलाइन');
    await expect(widget).toHaveAttribute('lang', 'ne');

    // The number still dials with Latin digits.
    await page.getByLabel('डायल गर्ने नम्बर').fill('1002');
    await page.getByRole('button', { name: 'कल गर्नुहोस्', exact: true }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await expect(page.getByRole('button', { name: 'होल्ड' })).toBeVisible();
    await page.getByRole('button', { name: 'कल काट्नुहोस्' }).click();
    await expect(page.getByLabel('डायल गर्ने नम्बर')).toBeVisible();

    // RTL smoke test: direction flips, the widget does not overflow, keypad stays 1-2-3.
    await page.getByRole('radiogroup', { name: 'Language' }).getByRole('radio', { name: 'RTL (pseudo)' }).click();
    await expect(widget).toHaveAttribute('dir', 'rtl');
    const overflow = await widget.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const one = await page.locator('[data-key="1"]').boundingBox();
    const three = await page.locator('[data-key="3"]').boundingBox();
    expect(one!.x).toBeLessThan(three!.x);
  });
});
