import { expect, test, type Page } from '@playwright/test';

/** Chat over SIP MESSAGE (V2-CHAT-01) against the mock engine (auto-reply on, 9999 unreachable). */
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

test.describe('chat (mock engine)', () => {
  test('incoming message shows an unread badge; reading and replying', async ({ page }) => {
    await login(page);
    await page.getByTestId('simulate-chat').click();
    const badge = page.getByTestId('chat-unread-badge');
    await expect(badge).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('event-log')).toContainText('chat ← 1002: Hi! Can you call me back?');

    await page.getByRole('tab', { name: /Chat/ }).click();
    const row = page.locator('[data-testid="chat-conversation"][data-peer="1002"]');
    await expect(row).toHaveAttribute('data-unread', '1');
    await row.click();
    await expect(page.getByTestId('chat-thread-title')).toHaveText('Alice Johnson');
    await expect(badge).toBeHidden();

    const composer = page.getByRole('textbox', { name: 'Message to Alice Johnson' });
    await composer.fill('Sure, calling in 5');
    await composer.press('Enter');
    const thread = page.getByRole('log', { name: 'Messages with Alice Johnson' });
    const mine = thread.locator('[data-testid="chat-message"][data-direction="outgoing"]');
    await expect(mine).toHaveAttribute('data-status', 'sent');
    await expect(mine.getByTestId('chat-message-status')).toContainText('Sent');
    // The mock auto-replies; the open thread marks it read at once.
    await expect(thread.getByTestId('chat-message').filter({ hasText: 'Auto-reply: Sure, calling in 5' })).toHaveAttribute(
      'data-direction',
      'incoming',
    );
    await expect(badge).toBeHidden();

    // Call from the thread header.
    await page.getByRole('button', { name: 'Call Alice Johnson' }).click();
    await expect(page.getByTestId('call-screen')).toBeVisible();
    await page.getByRole('button', { name: 'Hang up' }).click();
  });

  test('new conversation to an unreachable number is marked not delivered', async ({ page }) => {
    await login(page);
    await page.getByRole('tab', { name: /Chat/ }).click();
    await expect(page.getByText('No conversations')).toBeVisible();
    await page.getByLabel('Start a conversation with').fill('9999');
    await page.getByRole('button', { name: 'Start chat' }).click();
    await page.getByTestId('chat-composer').fill('anyone there?');
    await page.getByRole('button', { name: 'Send' }).click();
    const msg = page.getByTestId('chat-message');
    await expect(msg).toHaveAttribute('data-status', 'failed');
    await expect(msg.getByTestId('chat-message-status')).toContainText('Not delivered');
    await expect(page.getByTestId('event-log')).toContainText('chat → 9999 failed (404)');
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(page.getByTestId('chat-conversation')).toHaveAttribute('data-peer', '9999');
  });

  test('Message action on a contact opens the conversation', async ({ page }) => {
    await login(page);
    await page.getByRole('tab', { name: 'Contacts' }).click();
    const message = page.getByRole('button', { name: /^Message / }).first();
    const label = (await message.getAttribute('aria-label')) ?? '';
    await message.click();
    await expect(page.getByTestId('chat-thread-title')).toHaveText(label.replace(/^Message /, ''));
  });
});
