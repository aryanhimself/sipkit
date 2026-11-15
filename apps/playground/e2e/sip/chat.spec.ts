import { expect, test, type Page } from '@playwright/test';
import { closePhone, openPhone, type Phone } from './helpers';

/**
 * Chat over SIP MESSAGE (V2-CHAT-01) through the dev PBX:
 * infra/asterisk/config/pbx/extensions.conf [messages] (res_pjsip_messaging +
 * MessageSend), endpoints with message_context=messages.
 */

const conversation = (page: Page, peer: string) =>
  page.locator(`[data-testid="chat-conversation"][data-peer="${peer}"]`);
const messages = (page: Page, direction: 'incoming' | 'outgoing') =>
  page.locator(`[data-testid="chat-message"][data-direction="${direction}"]`);

async function openChatWith(phone: Phone, target: string): Promise<void> {
  await phone.page.getByRole('tab', { name: /Chat/ }).click();
  await phone.page.getByLabel('Start a conversation with').fill(target);
  await phone.page.getByRole('button', { name: 'Start chat' }).click();
  await expect(phone.page.getByTestId('chat-thread')).toHaveAttribute('data-peer', target);
}

async function send(phone: Phone, text: string): Promise<void> {
  const composer = phone.page.getByTestId('chat-composer');
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('real Asterisk: chat (SIP MESSAGE)', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('1001 and 1002 exchange messages with unread counts and delivery status', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    const stamp = Date.now().toString(36);

    await openChatWith(a, '1002');
    await send(a, `hello from 1001 ${stamp}`);
    const sent = messages(a.page, 'outgoing').last();
    await expect(sent).toHaveAttribute('data-status', 'sent');
    await expect(a.page.getByTestId('event-log')).toContainText(/chat → 1002 sent \(20[02]\)/);

    // 1002 is on the phone tab: badge + unread conversation.
    const badge = b.page.getByTestId('chat-unread-badge');
    await expect(badge).toHaveAttribute('data-count', '1');
    await expect(b.page.getByTestId('event-log')).toContainText(`chat ← 1001: hello from 1001 ${stamp}`);
    await b.page.getByRole('tab', { name: /Chat/ }).click();
    await expect(conversation(b.page, '1001')).toHaveAttribute('data-unread', '1');
    await conversation(b.page, '1001').click();
    await expect(messages(b.page, 'incoming').last()).toContainText(`hello from 1001 ${stamp}`);
    await expect(badge).toBeHidden();
    await expect.poll(() => b!.page.evaluate(() => window.__softphone?.getSnapshot().chat.unread)).toBe(0);

    // Reply; 1001 has the thread open and sees it arrive.
    await send(b, `hi 1001 ${stamp}`);
    await expect(messages(b.page, 'outgoing').last()).toHaveAttribute('data-status', 'sent');
    await expect(messages(a.page, 'incoming').last()).toContainText(`hi 1001 ${stamp}`);
    await expect(a.page.getByTestId('chat-unread-badge')).toBeHidden();
  });

  test('unknown and unregistered extensions are reported as not delivered', async ({ browser }) => {
    a = await openPhone(browser, '1001');

    // 9999 matches no [messages] extension: Asterisk answers 404 at once.
    await openChatWith(a, '9999');
    await send(a, 'anyone?');
    const unknown = messages(a.page, 'outgoing').last();
    await expect(unknown).toHaveAttribute('data-status', 'failed');
    await expect(unknown.getByTestId('chat-message-status')).toContainText('Not delivered');
    await expect(a.page.getByTestId('event-log')).toContainText('chat → 9999 failed (404)');

    // 2001 exists but is not registered: 202 Accepted, then the PBX delivery report fails it.
    await a.page.getByRole('button', { name: 'Back to conversations' }).click();
    await openChatWith(a, '2001');
    await send(a, 'are you there?');
    const offline = messages(a.page, 'outgoing').last();
    await expect(offline).toHaveAttribute('data-status', 'failed');
    await expect(a.page.getByTestId('event-log')).toContainText(/chat → 2001 failed \(202\)/);
    // The report is not shown as a chat message.
    await expect(messages(a.page, 'incoming')).toHaveCount(0);
    await expect(a.page.getByTestId('chat-unread-badge')).toBeHidden();
  });
});
