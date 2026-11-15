import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, FakeEngine } from '../testing';
import { createMemoryStorage } from '../storage';
import { parseMessageSummary, voicemailNumberFromAccount } from '../internal/message-summary';
import type { Cdr } from '../types';
import { flush } from './helpers';

const VM = { voicemail: { enabled: true, number: '*97' } };

describe('parseMessageSummary', () => {
  it('parses the RFC 3842 example', () => {
    const body =
      'Messages-Waiting: yes\r\nMessage-Account: sip:alice@vmail.example.com\r\nVoice-Message: 4/8 (1/2)\r\n';
    expect(parseMessageSummary(body)).toEqual({
      waiting: true,
      new: 4,
      old: 8,
      urgentNew: 1,
      urgentOld: 2,
      account: 'sip:alice@vmail.example.com',
    });
  });

  it('accepts Asterisk output, LF line endings, odd case and no urgent counts', () => {
    expect(
      parseMessageSummary(
        'messages-waiting: no\nmessage-account: <sip:*97@pbx>\nvoice-message:0/3\n',
      ),
    ).toEqual({
      waiting: false,
      new: 0,
      old: 3,
      urgentNew: 0,
      urgentOld: 0,
      account: 'sip:*97@pbx',
    });
  });

  it('derives waiting from counts when Messages-Waiting is missing and ignores other classes', () => {
    expect(parseMessageSummary('Fax-Message: 9/9\nVoice-Message: 2/0')).toMatchObject({
      waiting: true,
      new: 2,
    });
  });

  it('returns undefined for empty or unrelated bodies', () => {
    expect(parseMessageSummary('')).toBeUndefined();
    expect(parseMessageSummary(undefined)).toBeUndefined();
    expect(parseMessageSummary('Fax-Message: 1/0')).toBeUndefined();
    expect(parseMessageSummary('garbage')).toBeUndefined();
  });

  it('ignores malformed counts but keeps Messages-Waiting', () => {
    expect(parseMessageSummary('Messages-Waiting: yes\nVoice-Message: lots')).toMatchObject({
      waiting: true,
      new: 0,
    });
  });

  it('extracts the voicemail number from Message-Account', () => {
    expect(voicemailNumberFromAccount('sip:*97@pbx.example.com')).toBe('*97');
    expect(voicemailNumberFromAccount('sips:%2A97@pbx;transport=tls')).toBe('*97');
    expect(voicemailNumberFromAccount('mailto:x')).toBeUndefined();
    expect(voicemailNumberFromAccount(undefined)).toBeUndefined();
  });
});

describe('voicemail (MWI)', () => {
  it('is off by default: no subscription, NOTIFYs ignored', async () => {
    const { softphone, engine } = await createTestSoftphone();
    expect(engine.commandsFor('subscribeMessageSummary')).toHaveLength(0);
    engine.simulateMessageSummary({ new: 3 });
    expect(softphone.getSnapshot().voicemail).toMatchObject({ waiting: false, new: 0 });
  });

  it('subscribes after registration and publishes counts + event', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VM });
    expect(engine.commandsFor('subscribeMessageSummary')).toEqual([[undefined]]);
    const events: unknown[] = [];
    softphone.on('voicemail:updated', (e) => events.push(e));
    engine.simulateMessageSummary('Messages-Waiting: yes\r\nVoice-Message: 2/5 (1/0)');
    expect(softphone.getSnapshot().voicemail).toEqual({
      waiting: true,
      new: 2,
      old: 5,
      urgentNew: 1,
      urgentOld: 0,
    });
    expect(events).toHaveLength(1);
    // identical NOTIFY (refresh) does not re-emit or replace the snapshot
    const before = softphone.getSnapshot();
    engine.simulateMessageSummary('Messages-Waiting: yes\r\nVoice-Message: 2/5 (1/0)');
    expect(softphone.getSnapshot()).toBe(before);
    expect(events).toHaveLength(1);
  });

  it('honours unsolicited NOTIFYs when subscribe=false', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { voicemail: { enabled: true, subscribe: false } },
    });
    expect(engine.commandsFor('subscribeMessageSummary')).toHaveLength(0);
    engine.simulateMessageSummary({ new: 1, waiting: true });
    expect(softphone.getSnapshot().voicemail.new).toBe(1);
  });

  it('subscribes to a configured mailbox target', async () => {
    const { engine } = await createTestSoftphone({
      config: { voicemail: { enabled: true, mailbox: 'sip:1001@vm.example' } },
    });
    expect(engine.mwiSubscription).toBe('sip:1001@vm.example');
  });

  it('re-subscribes after a transport drop and unsubscribes on unregister', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VM });
    engine.simulateTransportState('disconnected', 'WebSocket closed');
    expect(engine.commandsFor('unsubscribeMessageSummary')).toHaveLength(1);
    engine.simulateRegistered();
    expect(engine.commandsFor('subscribeMessageSummary')).toHaveLength(2);
    await softphone.unregister();
    expect(engine.commandsFor('unsubscribeMessageSummary')).toHaveLength(2);
    expect(engine.mwiSubscription).toBeUndefined();
  });

  it('resets counts when the engine stops and when voicemail is disabled at runtime', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VM });
    engine.simulateMessageSummary({ new: 4 });
    await softphone.updateConfig({ voicemail: { enabled: false } });
    expect(softphone.getSnapshot().voicemail.new).toBe(0);
    expect(engine.mwiSubscription).toBeUndefined();
    await softphone.updateConfig({ voicemail: { enabled: true } });
    expect(engine.mwiSubscription).toBe('');
    engine.simulateMessageSummary({ new: 2 });
    await softphone.stop();
    expect(softphone.getSnapshot().voicemail.new).toBe(0);
  });

  it('logs and survives an engine without MWI support', async () => {
    const engine = new FakeEngine({ supportsMwi: false });
    const { softphone } = await createTestSoftphone({ engine, config: VM });
    expect(engine.subscribeMessageSummary).toBeUndefined();
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('recovers when SUBSCRIBE fails', async () => {
    const engine = new FakeEngine();
    engine.failNext('subscribeMessageSummary');
    const { softphone } = await createTestSoftphone({ engine, config: VM });
    await flush();
    engine.simulateTransportState('disconnected');
    engine.simulateRegistered();
    expect(engine.commandsFor('subscribeMessageSummary')).toHaveLength(2);
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('callVoicemail dials the configured number, else the Message-Account user', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VM });
    await softphone.callVoicemail();
    expect(engine.lastCommand('call')?.args[1]).toBe('*97');

    const other = await createTestSoftphone({ config: { voicemail: { enabled: true } } });
    await expect(other.softphone.callVoicemail()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    other.engine.simulateMessageSummary(
      'Messages-Waiting: no\r\nMessage-Account: sip:*98@pbx\r\nVoice-Message: 0/0',
    );
    await other.softphone.callVoicemail();
    expect(other.engine.lastCommand('call')?.args[1]).toBe('*98');
  });
});

describe('do not disturb', () => {
  it('rejects incoming calls with 486 without ringing and records a dnd CDR', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdrs: Cdr[] = [];
    const created = vi.fn();
    const notes: string[] = [];
    softphone.on('cdr', (c) => cdrs.push(c));
    softphone.on('call:created', created);
    softphone.on('notification', (n) => notes.push(`${n.title}: ${n.message ?? ''}`));
    const changes: boolean[] = [];
    softphone.on('dnd:changed', ({ dnd }) => changes.push(dnd));

    softphone.setDnd(true);
    expect(softphone.getSnapshot().dnd).toBe(true);
    const id = engine.simulateIncomingCall({ remoteNumber: '1001', remoteDisplayName: 'Agent' });
    expect(engine.commandsFor('reject')).toEqual([[id, 486]]);
    expect(created).not.toHaveBeenCalled();
    expect(softphone.getSnapshot().calls).toHaveLength(0);
    expect(cdrs).toEqual([
      expect.objectContaining({ direction: 'incoming', caller: '1001', reason: 'dnd', code: 486 }),
    ]);
    expect(notes).toEqual(['Missed call: Agent (Do Not Disturb)']);

    softphone.setDnd(true); // no-op
    softphone.setDnd(false);
    expect(changes).toEqual([true, false]);
    engine.simulateIncomingCall();
    expect(softphone.getSnapshot().calls).toHaveLength(1);
  });

  it('bypasses plugins and uses the configured reject code', async () => {
    const onIncomingCall = vi.fn();
    const { softphone, engine } = await createTestSoftphone({
      config: { dnd: { enabled: true, rejectCode: 603 } },
      plugins: [{ id: 'p', setup: () => ({ hooks: { onIncomingCall } }) }],
    });
    expect(softphone.getSnapshot().dnd).toBe(true);
    const id = engine.simulateIncomingCall();
    await flush();
    expect(engine.commandsFor('reject')).toEqual([[id, 603]]);
    expect(onIncomingCall).not.toHaveBeenCalled();
  });

  it('still allows outgoing calls while on', async () => {
    const { softphone } = await createTestSoftphone({ config: { dnd: { enabled: true } } });
    await expect(softphone.call('1002')).resolves.toMatchObject({ direction: 'outgoing' });
  });

  it('persists across instances only when dnd.persist is set', async () => {
    const storage = createMemoryStorage();
    const a = await createTestSoftphone({ storage, config: { dnd: { persist: true } } });
    a.softphone.setDnd(true);
    await a.softphone.destroy();
    const b = await createTestSoftphone({ storage, config: { dnd: { persist: true } } });
    expect(b.softphone.getSnapshot().dnd).toBe(true);
    const c = await createTestSoftphone({ storage });
    expect(c.softphone.getSnapshot().dnd).toBe(false);
  });

  it('rejects config with an invalid reject code', async () => {
    await expect(createTestSoftphone({ config: { dnd: { rejectCode: 200 } } })).rejects.toThrow(
      /dnd.rejectCode/,
    );
  });
});
