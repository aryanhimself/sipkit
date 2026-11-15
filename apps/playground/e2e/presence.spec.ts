import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

const tile = (page: Page, target: string) => page.locator(`[data-testid="blf-tile"][data-target="${target}"]`);

test.describe('presence / BLF (mock engine)', () => {
  test('BLF grid follows lamp states, calls and picks up', async ({ page }) => {
    await login(page);
    await page.getByRole('tab', { name: 'Lamps' }).click();
    const alice = tile(page, '1002');
    await expect(page.getByTestId('blf-tile')).toHaveCount(3);
    await expect(alice).toHaveAttribute('data-state', 'idle');
    await expect(alice).toContainText('Alice Johnson');
    await expect(alice).toContainText('Available');

    await page.getByTestId('blf-1002-busy').click();
    await expect(alice).toHaveAttribute('data-state', 'busy');
    await expect(alice).toContainText('Busy');
    await expect(page.getByTestId('event-log')).toContainText('presence 1002 → busy');

    await page.getByTestId('blf-1002-ringing').click();
    await expect(alice).toHaveAttribute('data-state', 'ringing');
    await expect(alice).toContainText('Ringing · Jane Customer');
    await alice.getByRole('button', { name: /Pick up/ }).click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    // Directed pickup dials the feature code (the call screen resolves it to the contact).
    await expect(page.getByTestId('event-log')).toContainText('outgoing **1002');
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();

    await page.getByRole('tab', { name: 'Lamps' }).click();
    await expect(alice).toHaveAttribute('data-state', 'idle');
    await alice.getByRole('button', { name: /Alice Johnson: Available\. Call/ }).click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await expect(page.getByTestId('call-title')).toHaveText('Alice Johnson');
  });

  test('contacts list shows lamps with state text', async ({ page }) => {
    await login(page);
    await page.getByTestId('blf-1002-unavailable').click();
    await page.getByRole('tab', { name: 'Contacts' }).click();
    const contacts = page.getByRole('list', { name: 'Contacts' });
    await expect(contacts.locator('[data-testid="presence-lamp"][data-state="unavailable"]')).toHaveCount(1);
    await expect(contacts).toContainText('1002 · Offline');
    await expect(contacts).toContainText('1003 · Available');
  });
});
