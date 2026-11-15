import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SoftphoneConfigInput } from 'sipkit-core';
import type { MockSoftphoneOptions } from 'sipkit-react/testing';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

async function renderPhone(config: SoftphoneConfigInput = {}, options: MockSoftphoneOptions = {}, locale?: string) {
  const phone = createPhone(config, { chatSendDelayMs: 5, unreachableChatNumbers: ['9999'], ...options });
  render(<Softphone softphone={phone} toaster={false} locale={locale} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

const CHAT = { chat: { enabled: true } };

describe('Chat tab', () => {
  it('is hidden unless chat is enabled, and when the CHAT feature is disabled', async () => {
    await renderPhone();
    expect(screen.queryByRole('tab', { name: /Chat/ })).toBeNull();
  });

  it('honours disabledFeatures', async () => {
    await renderPhone({ ...CHAT, disabledFeatures: ['CHAT'] });
    expect(screen.queryByRole('tab', { name: /Chat/ })).toBeNull();
  });

  it('starts a conversation, sends with delivery status, receives with unread badge', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone(CHAT);

    // Incoming while on the phone tab: badge on the Chat tab.
    act(() => void phone.simulateIncomingMessage('1002', 'Are you free?', 'Agent 1002'));
    const badge = screen.getByTestId('chat-unread-badge');
    expect(badge.dataset.count).toBe('1');
    expect(badge.textContent).toContain('1 unread message');

    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    const row = screen.getByTestId('chat-conversation');
    expect(row.dataset.peer).toBe('1002');
    expect(row.textContent).toContain('Agent 1002');
    expect(row.textContent).toContain('Are you free?');

    // Opening the thread marks it read.
    await user.click(row);
    expect(screen.getByTestId('chat-thread-title').textContent).toBe('Agent 1002');
    await waitFor(() => expect(screen.queryByTestId('chat-unread-badge')).toBeNull());
    expect(phone.getSnapshot().chat.unread).toBe(0);

    const composer = screen.getByRole('textbox', { name: 'Message to Agent 1002' });
    await user.type(composer, 'Yes, calling you{Enter}');
    const log = screen.getByRole('log', { name: 'Messages with Agent 1002' });
    await waitFor(() => {
      const out = within(log).getAllByTestId('chat-message').at(-1)!;
      expect(out.dataset.direction).toBe('outgoing');
      expect(out.dataset.status).toBe('sent');
    });
    expect((composer as HTMLTextAreaElement).value).toBe('');

    // Back to the list.
    await user.click(screen.getByRole('button', { name: 'Back to conversations' }));
    expect(screen.getByTestId('chat-conversation').textContent).toContain('You: Yes, calling you');
  });

  it('shows a failed message with retry for unreachable targets', async () => {
    const user = userEvent.setup();
    await renderPhone(CHAT);
    await user.click(screen.getByRole('tab', { name: /Chat/ }));
    await user.type(screen.getByLabelText('Start a conversation with'), '9999{Enter}');
    expect(screen.getByTestId('chat-thread').dataset.peer).toBe('9999');
    await user.type(screen.getByTestId('chat-composer'), 'hello?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('chat-message').dataset.status).toBe('failed'));
    expect(screen.getByTestId('chat-message-status').textContent).toContain('Not delivered');
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(2));
  });

  it('opens a conversation from a contact', async () => {
    const user = userEvent.setup();
    const phone = createPhone(CHAT);
    render(<Softphone softphone={phone} toaster={false} contacts={[{ id: 'c1', name: 'Jane Customer', number: '1002' }]} />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    await user.click(screen.getByRole('tab', { name: 'Contacts' }));
    await user.click(screen.getByRole('button', { name: 'Message Jane Customer' }));
    expect(screen.getByTestId('chat-thread-title').textContent).toBe('Jane Customer');
  });

  it('renders in Nepali', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone(CHAT, {}, 'ne');
    act(() => void phone.simulateIncomingMessage('1002', 'नमस्ते'));
    expect(screen.getByTestId('chat-unread-badge').textContent).toContain('नपढिएको सन्देश');
    await user.click(screen.getByRole('tab', { name: /च्याट/ }));
    expect(screen.getByLabelText('कोसँग कुराकानी सुरु गर्ने')).toBeTruthy();
  });
});
