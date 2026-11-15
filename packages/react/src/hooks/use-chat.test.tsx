import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MockSoftphone } from '../testing/mock-softphone';
import { wrapperFor } from '../test-utils';
import { useChat, useConversation } from './use-chat';

function phone(config: ConstructorParameters<typeof MockSoftphone>[0] = {}, options = {}) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], ...config },
    { registerDelayMs: 0, chatSendDelayMs: 5, unreachableChatNumbers: ['9999'], ...options },
  );
}

describe('useChat / useConversation', () => {
  it('is disabled by default and when the CHAT feature is switched off', () => {
    expect(renderHook(() => useChat(), { wrapper: wrapperFor(phone()) }).result.current.enabled).toBe(false);
    const off = phone({ chat: { enabled: true }, disabledFeatures: ['CHAT'] });
    expect(renderHook(() => useChat(), { wrapper: wrapperFor(off) }).result.current.enabled).toBe(false);
  });

  it('sends, receives, counts unread and marks read', async () => {
    const p = phone({ chat: { enabled: true } });
    await p.start();
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    const { result } = renderHook(() => ({ chat: useChat(), conv: useConversation('sip:1002@pbx.example.com') }), {
      wrapper: wrapperFor(p),
    });
    expect(result.current.chat.enabled).toBe(true);
    expect(result.current.conv).toMatchObject({ peer: '1002', messages: [], unread: 0 });

    let sent: Awaited<ReturnType<typeof result.current.conv.send>> | undefined;
    await act(async () => {
      sent = await result.current.conv.send('hello');
    });
    expect(sent).toMatchObject({ status: 'sent', peer: '1002' });

    act(() => {
      p.simulateIncomingMessage('1002', 'hi back', 'Agent 1002');
    });
    expect(result.current.chat.unread).toBe(1);
    expect(result.current.conv.messages.map((m) => m.body)).toEqual(['hello', 'hi back']);
    expect(result.current.conv.conversation?.displayName).toBe('Agent 1002');

    act(() => result.current.conv.markRead());
    expect(result.current.chat.unread).toBe(0);

    await act(async () => {
      expect(await result.current.chat.send('9999', 'x')).toMatchObject({ status: 'failed', code: 404 });
    });
    expect(result.current.chat.conversations.map((c) => c.peer)).toEqual(['9999', '1002']);
    act(() => result.current.chat.deleteConversation('9999'));
    expect(result.current.chat.conversations).toHaveLength(1);
    await p.destroy();
  });

  it('mock auto-reply and delivery failure', async () => {
    const p = phone({ chat: { enabled: true } }, { chatAutoReply: true });
    await p.start();
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    const sent = await p.sendMessage('1002', 'ping');
    await waitFor(() => expect(p.getSnapshot().chat.unread).toBe(1), { timeout: 2000 });
    expect(p.getSnapshot().chat.conversations[0]!.messages.at(-1)!.body).toBe('Auto-reply: ping');
    p.simulateDeliveryFailure(sent.id);
    expect(p.getSnapshot().chat.conversations[0]!.messages[0]!.status).toBe('failed');
    await p.destroy();
  });
});
