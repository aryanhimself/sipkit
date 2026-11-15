import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from '../testing';
import type { Call, Cdr } from '../types';
import { callByEngineIncoming, flush } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('outgoing calls', () => {
  it('dials, rings, connects and hangs up with CDR', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdrs: Cdr[] = [];
    const ended: Call[] = [];
    softphone.on('cdr', (c) => cdrs.push(c));
    softphone.on('call:ended', ({ call }) => ended.push(call));

    const call = await softphone.call('1002');
    expect(call).toMatchObject({ direction: 'outgoing', state: 'setup', line: 1, remoteNumber: '1002' });
    expect(engine.lastCommand('call')?.args.slice(0, 2)).toEqual([call.id, '1002']);
    expect(softphone.getSnapshot().activeCallId).toBe(call.id);

    engine.simulateRinging(call.id);
    expect(softphone.getCall(call.id)?.state).toBe('ringing');
    engine.simulateRemoteAnswer(call.id, 'abc@pbx');
    expect(softphone.getCall(call.id)).toMatchObject({ state: 'connected', sipCallId: 'abc@pbx' });
    expect(softphone.getCall(call.id)?.connectedAt).toBeTypeOf('number');

    await softphone.hangup();
    expect(softphone.getSnapshot().calls).toEqual([]);
    expect(softphone.getSnapshot().activeCallId).toBeNull();
    expect(ended[0]).toMatchObject({ state: 'disconnected', disconnectReason: 'local-hangup' });
    expect(cdrs).toHaveLength(1);
    expect(cdrs[0]).toMatchObject({ direction: 'outgoing', caller: '1001', called: '1002', reason: 'local-hangup', line: 1 });
  });

  it('emits call:updated with previous snapshot', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const updates: Array<[string, string]> = [];
    softphone.on('call:updated', ({ call, previous }) => updates.push([previous.state, call.state]));
    const call = await softphone.call('1002');
    engine.simulateEarlyMedia(call.id);
    engine.simulateRemoteAnswer(call.id);
    engine.simulateRemoteHangup(call.id);
    expect(updates).toEqual([
      ['setup', 'early'],
      ['early', 'connected'],
      ['connected', 'disconnected'],
    ]);
  });

  it('normalizes numbers, applies beforeDial and techPrefix, keeps SIP URIs', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { techPrefix: '9' },
      plugins: [{ id: 'cc', setup: () => ({ hooks: { beforeDial: (n: string) => (n.startsWith('+') ? `00${n.slice(1)}` : n) } }) }],
    });
    const call = await softphone.call(' +1 (555) 123-4567 ');
    expect(engine.lastCommand('call')?.args[1]).toBe('90015551234567');
    expect(call.remoteNumber).toBe('0015551234567');
    await softphone.hangup();
    await softphone.call('sip:alice@example.com');
    expect(engine.lastCommand('call')?.args[1]).toBe('sip:alice@example.com');
  });

  it('skips techPrefix for short extensions when techPrefixMinDigits is set', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { techPrefix: '9', techPrefixMinDigits: 7 } });
    await softphone.call('1002');
    expect(engine.lastCommand('call')?.args[1]).toBe('1002');
    await softphone.hangup();
    const call = await softphone.call('9842477272');
    expect(engine.lastCommand('call')?.args[1]).toBe('99842477272');
    expect(call.remoteNumber).toBe('9842477272');
  });

  it('respects normalizeNumbers=false', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { normalizeNumbers: false } });
    await softphone.call('12-34');
    expect(engine.lastCommand('call')?.args[1]).toBe('12-34');
  });

  it('sends post-dial DTMF once connected', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const call = await softphone.call('123,456#');
    expect(engine.lastCommand('call')?.args[1]).toBe('123');
    expect(engine.commandsFor('sendDtmf')).toHaveLength(0);
    engine.simulateRemoteAnswer(call.id);
    expect(engine.commandsFor('sendDtmf')).toEqual([[call.id, '456#']]);
    engine.simulateRemoteHold(call.id, false);
    expect(engine.commandsFor('sendDtmf')).toHaveLength(1);
  });

  it('passes configured extra headers', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { extraHeaders: ['X-Agent: 42'] } });
    await softphone.call('1002');
    expect(engine.lastCommand('call')?.args[2]).toEqual({ extraHeaders: ['X-Agent: 42'] });
  });

  it('rejects invalid numbers and unregistered dialing', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await expect(softphone.call('  ')).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
    await expect(softphone.call('12,xyz')).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
    engine.simulateRegistrationFailure();
    await expect(softphone.call('1002')).rejects.toMatchObject({ code: 'NOT_REGISTERED' });
  });

  it('ends the call as failed when the engine cannot place it', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    engine.failNext('call', new Error('no transport'));
    await expect(softphone.call('1002')).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getSnapshot().calls).toHaveLength(0);
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }));
  });

  it('ends with media-error, not failed, when the microphone is blocked', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    engine.failNext('call', denied);
    await expect(softphone.call('1002')).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'media-error' }));
  });

  it('cancels an unanswered outgoing call after ringTimeout', async () => {
    vi.useFakeTimers();
    const { softphone, engine } = await createTestSoftphone({ config: { ringTimeout: 10 } });
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const call = await softphone.call('1002');
    engine.simulateRinging(call.id);
    vi.advanceTimersByTime(9_999);
    expect(softphone.getCall(call.id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(engine.commandsFor('hangup')).toEqual([[call.id]]);
    expect(softphone.getCall(call.id)).toBeUndefined();
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'no-answer', durationMs: 0 }));
  });

  it('does not time out a connected call', async () => {
    vi.useFakeTimers();
    const { softphone, engine } = await createTestSoftphone({ config: { ringTimeout: 5 } });
    const call = await softphone.call('1002');
    engine.simulateRemoteAnswer(call.id);
    vi.advanceTimersByTime(60_000);
    expect(softphone.getCall(call.id)?.state).toBe('connected');
  });

  it('maps remote failures into CDR reason/code', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const call = await softphone.call('1002');
    engine.simulateCallEnded(call.id, 'busy', 486);
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'busy', code: 486 }));
  });

  it('computes talk time in CDR', async () => {
    vi.useFakeTimers();
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const call = await softphone.call('1002');
    engine.simulateRemoteAnswer(call.id);
    vi.advanceTimersByTime(42_000);
    engine.simulateRemoteHangup(call.id);
    expect(cdr.mock.lastCall?.[0]).toMatchObject({ durationMs: 42_000, reason: 'remote-hangup' });
  });
});

describe('incoming calls', () => {
  it('rings, answers and becomes active', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const created = vi.fn();
    softphone.on('call:created', created);
    const id = engine.simulateIncomingCall({ remoteNumber: '2000', remoteDisplayName: 'Bob' });
    const call = callByEngineIncoming(softphone, id);
    expect(call).toMatchObject({ direction: 'incoming', state: 'ringing', remoteDisplayName: 'Bob', line: 1 });
    expect(created).toHaveBeenCalledOnce();
    expect(softphone.getSnapshot().activeCallId).toBe(call.id);
    await softphone.answer();
    expect(engine.commandsFor('answer')).toEqual([[id]]);
    expect(softphone.getCall(call.id)?.state).toBe('connected');
  });

  it('copies the INVITE headers the host asked for onto the call', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { inviteHeaders: ['X-Taskbirt-Call-Id'] } });
    const id = engine.simulateIncomingCall({ remoteNumber: '2000', inviteHeaders: { 'x-taskbirt-call-id': 'vc_9' } });
    expect(callByEngineIncoming(softphone, id).inviteHeaders).toEqual({ 'x-taskbirt-call-id': 'vc_9' });
    const plain = engine.simulateIncomingCall({ remoteNumber: '2001' });
    expect(callByEngineIncoming(softphone, plain).inviteHeaders).toBeUndefined();
  });

  it('reject() sends 486 and records a rejected CDR', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const id = engine.simulateIncomingCall({ remoteNumber: '2000' });
    await softphone.reject();
    expect(engine.commandsFor('reject')).toEqual([[id, undefined]]);
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rejected', caller: '2000', called: '1001' }));
  });

  it('hangup() on a ringing incoming call rejects it', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.simulateIncomingCall();
    await softphone.hangup();
    expect(engine.commandsFor('reject')).toHaveLength(1);
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('remote cancel ends the call', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const id = engine.simulateIncomingCall();
    engine.simulateCallEnded(id, 'cancelled');
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('autoAnswer answers immediately', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { autoAnswer: true } });
    const id = engine.simulateIncomingCall();
    await flush();
    expect(engine.commandsFor('answer')).toEqual([[id]]);
    expect(callByEngineIncoming(softphone, id).state).toBe('connected');
  });

  it('honours header-based auto answer delay', async () => {
    vi.useFakeTimers();
    const { engine } = await createTestSoftphone();
    engine.simulateIncomingCall({ autoAnswerDelay: 2 });
    await flush();
    expect(engine.commandsFor('answer')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.commandsFor('answer')).toHaveLength(1);
  });

  it('ignores header auto answer when autoAnswerOnHeader is false', async () => {
    vi.useFakeTimers();
    const { engine } = await createTestSoftphone({ config: { autoAnswerOnHeader: false } });
    engine.simulateIncomingCall({ autoAnswerDelay: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.commandsFor('answer')).toHaveLength(0);
  });

  it('rejectOnBusy rejects new calls with 486 and emits a busy CDR', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { rejectOnBusy: true } });
    const cdr = vi.fn();
    const notification = vi.fn();
    softphone.on('cdr', cdr);
    softphone.on('notification', notification);
    await softphone.call('1002');
    const id = engine.simulateIncomingCall({ remoteNumber: '3000' });
    expect(engine.commandsFor('reject')).toEqual([[id, 486]]);
    expect(softphone.getSnapshot().calls).toHaveLength(1);
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'busy', code: 486, caller: '3000', line: 0 }));
    expect(notification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Missed call', code: 'missedCall', params: expect.objectContaining({ reason: 'busy' }) }));
  });

  it('rejects when all lines are busy', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { maxLines: 1 } });
    await softphone.call('1002');
    const id = engine.simulateIncomingCall();
    expect(engine.commandsFor('reject')).toEqual([[id, 486]]);
  });

  it('times out an unanswered incoming call with 480', async () => {
    vi.useFakeTimers();
    const { softphone, engine } = await createTestSoftphone({ config: { ringTimeout: 5 } });
    const id = engine.simulateIncomingCall();
    vi.advanceTimersByTime(5000);
    expect(engine.commandsFor('reject')).toEqual([[id, 480]]);
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('forward() redirects an unanswered call', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { techPrefix: '8' } });
    const id = engine.simulateIncomingCall();
    await softphone.forward('2001');
    expect(engine.commandsFor('forward')).toEqual([[id, '82001']]);
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('answer/reject validate state', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await expect(softphone.answer()).rejects.toMatchObject({ code: 'NO_ACTIVE_CALL' });
    await expect(softphone.answer('nope')).rejects.toMatchObject({ code: 'CALL_NOT_FOUND' });
    const out = await softphone.call('1002');
    await expect(softphone.answer(out.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(softphone.reject(out.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    engine.simulateRemoteAnswer(out.id);
    await expect(softphone.forward('1', out.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('surfaces engine answer failures as ENGINE_ERROR', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.simulateIncomingCall();
    engine.failNext('answer', new Error('NotAllowedError'));
    await expect(softphone.answer()).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
  });

  it('emits received DTMF', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const dtmf = vi.fn();
    softphone.on('call:dtmf-received', dtmf);
    const id = engine.simulateIncomingCall();
    engine.simulateDtmf(id, '5');
    expect(dtmf).toHaveBeenCalledWith({ callId: callByEngineIncoming(softphone, id).id, digit: '5' });
    engine.simulateDtmf('unknown', '1');
    expect(dtmf).toHaveBeenCalledOnce();
  });
});
