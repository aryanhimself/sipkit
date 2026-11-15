import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'sip.js';
import { createTestSoftphone, FakeEngine } from '../testing';
import { createMemoryStorage } from '../storage';
import { createLogger } from '../logger';
import { chatPeerKey, parseDeliveryReport, baseContentType } from '../chat/peer';
import { createLocalChatStorage } from '../chat/storage';
import { answerMessage, toIncomingMessage } from '../engines/sipjs/messaging';
import type { ChatConversation, ChatHistoryStorage, SoftphoneEvents } from '../types';
import { flush } from './helpers';

const CHAT = { chat: { enabled: true } };

describe('chat helpers', () => {
  it('keys peers by user on the own domain and keeps foreign URIs', () => {
    expect(chatPeerKey('1002', 'pbx.test')).toBe('1002');
    expect(chatPeerKey(' 555-01 00 ', 'pbx.test')).toBe('5550100');
    expect(chatPeerKey('sip:1002@PBX.test', 'pbx.test')).toBe('1002');
    expect(chatPeerKey('1002@pbx.test', 'pbx.test')).toBe('1002');
    expect(chatPeerKey('sip:bob@Example.com;transport=ws', 'pbx.test')).toBe('sip:bob@example.com');
    expect(chatPeerKey('  ', 'pbx.test')).toBe('');
  });

  it('parses delivery reports and content types', () => {
    expect(parseDeliveryReport('failed;to=1003;id=abc')).toEqual({ status: 'failed', to: '1003', messageId: 'abc' });
    expect(parseDeliveryReport('failed;to=1003;id=')).toEqual({ status: 'failed', to: '1003', messageId: undefined });
    expect(parseDeliveryReport('delivered')).toBeUndefined();
    expect(parseDeliveryReport(undefined)).toBeUndefined();
    expect(baseContentType('Text/Plain; charset=UTF-8')).toBe('text/plain');
  });

  it('maps a SIP.js Message and answers it', async () => {
    const accept = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const headers: Record<string, string> = { 'Content-Type': 'text/plain;charset=UTF-8' };
    const message = {
      request: {
        from: { uri: { user: '1001', host: 'pbx.test' }, displayName: 'Agent 1001' },
        body: 'hi',
        getHeader: (name: string) => headers[name],
      },
      accept,
      reject,
    } as unknown as Message;
    expect(toIncomingMessage(message)).toEqual({
      from: '1001',
      fromHost: 'pbx.test',
      fromDisplayName: 'Agent 1001',
      body: 'hi',
      contentType: 'text/plain',
      deliveryReport: undefined,
    });
    headers['X-Sipkit-Delivery'] = 'failed;to=1003;id=m1';
    expect(toIncomingMessage(message).deliveryReport).toEqual({ status: 'failed', to: '1003', messageId: 'm1' });
    const logger = createLogger('t', { level: 'silent', console: false });
    answerMessage(message, 200, logger);
    answerMessage(message, 415, logger);
    expect(accept).toHaveBeenCalledWith({ statusCode: 200 });
    expect(reject).toHaveBeenCalledWith({ statusCode: 415 });
  });
});

describe('Softphone chat', () => {
  it('is off by default: no snapshot data, sendMessage throws, incoming answered 480', async () => {
    const { softphone, engine } = await createTestSoftphone();
    expect(softphone.getSnapshot().chat).toEqual({ conversations: [], unread: 0 });
    await expect(softphone.sendMessage('1002', 'hi')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(engine.simulateIncomingMessage('1002', 'hi')).toBe(480);
    expect(softphone.getSnapshot().chat.conversations).toHaveLength(0);
  });

  it('sends a MESSAGE and moves sending → sent on 2xx', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT });
    const statuses: SoftphoneEvents['message:status'][] = [];
    softphone.on('message:status', (e) => statuses.push(e));
    engine.messageResponses.set('*', 'pending');

    const pending = softphone.sendMessage('sip:1002@pbx.test', '  hello  ');
    await flush();
    const conv = softphone.getSnapshot().chat.conversations[0]!;
    expect(conv.peer).toBe('1002');
    expect(conv.messages[0]).toMatchObject({ direction: 'outgoing', body: 'hello', status: 'sending' });
    expect(engine.sentMessages[0]).toMatchObject({ target: '1002', body: 'hello', contentType: 'text/plain' });
    expect(engine.sentMessages[0]!.messageId).toBe(conv.messages[0]!.id);

    engine.resolveMessage(engine.sentMessages[0]!.messageId, 202);
    const final = await pending;
    expect(final).toMatchObject({ status: 'sent', code: 202 });
    expect(softphone.getSnapshot().chat.conversations[0]!.messages[0]!.status).toBe('sent');
    expect(statuses.map((s) => [s.previous, s.message.status])).toEqual([
      [undefined, 'sending'],
      ['sending', 'sent'],
    ]);
    expect(softphone.getSnapshot().chat.unread).toBe(0);
  });

  it('marks a message failed on 4xx and on transport errors', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT });
    engine.messageResponses.set('9999', 404);
    expect(await softphone.sendMessage('9999', 'x')).toMatchObject({ status: 'failed', code: 404 });
    engine.failNext('sendMessage', new Error('socket closed'));
    expect(await softphone.sendMessage('1002', 'y')).toMatchObject({ status: 'failed', code: 503 });
  });

  it('validates input and registration', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { chat: { enabled: true, maxLength: 5 } } });
    await expect(softphone.sendMessage('1002', '   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(softphone.sendMessage('1002', 'too long')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(softphone.sendMessage(' ', 'hi')).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
    engine.simulateRegistrationFailure();
    await expect(softphone.sendMessage('1002', 'hi')).rejects.toMatchObject({ code: 'NOT_REGISTERED' });
  });

  it('reports NOT_SUPPORTED for engines without MESSAGE', async () => {
    const { softphone } = await createTestSoftphone({ config: CHAT, engineOptions: { supportsMessaging: false } });
    await expect(softphone.sendMessage('1002', 'hi')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('receives messages into conversations with unread counts and markConversationRead', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT });
    const received = vi.fn();
    const read = vi.fn();
    softphone.on('message:received', received);
    softphone.on('conversation:read', read);

    expect(engine.simulateIncomingMessage('1002', 'one', { fromHost: 'pbx.test', fromDisplayName: 'Agent 1002' })).toBe(200);
    engine.simulateIncomingMessage('1002', 'two', { fromHost: 'pbx.test' });
    engine.simulateIncomingMessage('1003', 'hey', { fromHost: 'pbx.test' });

    const chat = softphone.getSnapshot().chat;
    expect(chat.unread).toBe(3);
    expect(chat.conversations.map((c) => c.peer)).toEqual(['1003', '1002']);
    const c1002 = chat.conversations.find((c) => c.peer === '1002')!;
    expect(c1002).toMatchObject({ unread: 2, displayName: 'Agent 1002' });
    expect(c1002.messages.map((m) => [m.direction, m.body, m.status])).toEqual([
      ['incoming', 'one', 'received'],
      ['incoming', 'two', 'received'],
    ]);
    expect(received).toHaveBeenCalledTimes(3);
    expect(received.mock.calls[0]![0].conversation.peer).toBe('1002');

    softphone.markConversationRead('sip:1002@pbx.test');
    expect(read).toHaveBeenCalledWith({ peer: '1002' });
    expect(softphone.getSnapshot().chat.unread).toBe(1);
    softphone.markConversationRead('1002'); // no-op
    expect(read).toHaveBeenCalledTimes(1);

    softphone.deleteConversation('1003');
    expect(softphone.getSnapshot().chat).toMatchObject({ unread: 0 });
    expect(softphone.getSnapshot().chat.conversations.map((c) => c.peer)).toEqual(['1002']);
  });

  it('keys foreign senders by full URI, ignores typing indicators, rejects other types', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT });
    engine.simulateIncomingMessage('bob', 'hi', { fromHost: 'example.com' });
    expect(softphone.getSnapshot().chat.conversations[0]!.peer).toBe('sip:bob@example.com');
    expect(engine.simulateIncomingMessage('1002', '<isComposing/>', { contentType: 'application/im-iscomposing+xml' })).toBe(200);
    expect(engine.simulateIncomingMessage('1002', '{}', { contentType: 'application/json' })).toBe(415);
    expect(softphone.getSnapshot().chat.conversations).toHaveLength(1);
  });

  it('applies PBX delivery reports by message id, then by recipient', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT });
    const status = vi.fn();
    softphone.on('message:status', status);
    const first = await softphone.sendMessage('1003', 'a');
    expect(first.status).toBe('sent');
    expect(engine.simulateDeliveryReport(first.id, '1003')).toBe(200);
    expect(softphone.getSnapshot().chat.conversations[0]!.messages[0]).toMatchObject({ status: 'failed', reason: 'Not delivered' });
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ previous: 'sent' }));

    await softphone.sendMessage('1003', 'b');
    engine.simulateDeliveryReport(undefined, '1003');
    const messages = softphone.getSnapshot().chat.conversations[0]!.messages;
    expect(messages.map((m) => m.status)).toEqual(['failed', 'failed']);
    // Reports never show up as chat.
    expect(messages).toHaveLength(2);
    expect(softphone.getSnapshot().chat.unread).toBe(0);
  });

  it('ignores delivery reports when deliveryReports is off', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { chat: { enabled: true, deliveryReports: false } } });
    const sent = await softphone.sendMessage('1003', 'a');
    engine.simulateDeliveryReport(sent.id, '1003');
    expect(softphone.getSnapshot().chat.conversations[0]!.messages[0]!.status).toBe('sent');
  });

  it('caps history per conversation and the number of conversations', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { chat: { enabled: true, historyLimit: 10, maxConversations: 2 } },
    });
    for (let i = 0; i < 12; i++) engine.simulateIncomingMessage('1002', `m${i}`);
    const conv = softphone.getSnapshot().chat.conversations[0]!;
    expect(conv.messages).toHaveLength(10);
    expect(conv.messages[0]!.body).toBe('m2');
    expect(conv.unread).toBe(10);
    engine.simulateIncomingMessage('1003', 'x');
    engine.simulateIncomingMessage('1004', 'y');
    expect(softphone.getSnapshot().chat.conversations.map((c) => c.peer)).toEqual(['1004', '1003']);
  });

  it('persists history in softphone storage when chat.persist and restores it', async () => {
    const storage = createMemoryStorage();
    const config = { chat: { enabled: true, persist: true } };
    const first = await createTestSoftphone({ config, storage });
    first.engine.simulateIncomingMessage('1002', 'remember me');
    first.engine.messageResponses.set('*', 'pending');
    void first.softphone.sendMessage('1002', 'in flight');
    await flush();
    await first.softphone.destroy();

    const second = await createTestSoftphone({ config, storage });
    const conv = second.softphone.getSnapshot().chat.conversations[0]!;
    expect(conv.messages.map((m) => [m.body, m.status])).toEqual([
      ['remember me', 'received'],
      ['in flight', 'failed'],
    ]);
    expect(conv.unread).toBe(1);
    expect(second.softphone.getSnapshot().chat.unread).toBe(1);
  });

  it('switches history with the account and clears it when chat is turned off', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: CHAT, engine: new FakeEngine() });
    engine.simulateIncomingMessage('1002', 'for 1001');
    await softphone.updateConfig({ chat: { enabled: false } });
    expect(softphone.getSnapshot().chat.conversations).toHaveLength(0);
    expect(engine.simulateIncomingMessage('1002', 'nope')).toBe(480);
    await softphone.updateConfig({ chat: { enabled: true } });
    // Default memory storage keeps history across the toggle.
    expect(softphone.getSnapshot().chat.conversations[0]!.messages[0]!.body).toBe('for 1001');
    await softphone.updateConfig({ username: '1005' });
    expect(softphone.getSnapshot().chat.conversations).toHaveLength(0);
  });

  it('accepts a custom async storage and merges history under live messages', async () => {
    let resolveLoad: (list: ChatConversation[]) => void = () => undefined;
    const saved: ChatConversation[][] = [];
    const chatStorage: ChatHistoryStorage = {
      load: () => new Promise((r) => (resolveLoad = r)),
      save: (_account, list) => void saved.push(list),
    };
    const engine = new FakeEngine();
    const { Softphone } = await import('../softphone');
    const softphone = new Softphone({
      config: { username: '1001', password: 'x', websocketUrls: ['wss://pbx.test/ws'], ...CHAT },
      engine: () => engine,
      storage: createMemoryStorage(),
      mediaDevices: null,
      console: false,
      chatStorage,
    });
    await softphone.start();
    engine.simulateIncomingMessage('1002', 'live');
    resolveLoad([
      {
        peer: '1002',
        messages: [{ id: 'old', peer: '1002', direction: 'outgoing', body: 'stored', contentType: 'text/plain', at: 1, status: 'sent' }],
        unread: 0,
        updatedAt: 1,
      },
    ]);
    await flush();
    expect(softphone.getSnapshot().chat.conversations[0]!.messages.map((m) => m.body)).toEqual(['stored', 'live']);
    expect(saved.length).toBeGreaterThan(0);
    await softphone.destroy();
  });

  it('localStorage adapter round-trips and survives corrupt data', () => {
    const backend = createMemoryStorage();
    const store = createLocalChatStorage(backend, 'p');
    expect(store.load('a')).toBeUndefined();
    store.save('a', [{ peer: '1', messages: [], unread: 0, updatedAt: 1 }]);
    expect(store.load('a')).toEqual([{ peer: '1', messages: [], unread: 0, updatedAt: 1 }]);
    backend.setItem('p:a', '{bad');
    expect(store.load('a')).toBeUndefined();
    store.clear?.('a');
    expect(backend.getItem('p:a')).toBeNull();
  });
});
