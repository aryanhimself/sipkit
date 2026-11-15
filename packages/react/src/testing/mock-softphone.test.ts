import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSoftphone } from './mock-softphone';

describe('MockSoftphone', () => {
  let phone: MockSoftphone;
  beforeEach(async () => {
    vi.useFakeTimers();
    phone = new MockSoftphone({ username: '1001', password: 'x' });
    const p = phone.start();
    await vi.advanceTimersByTimeAsync(300);
    await p;
  });
  afterEach(() => vi.useRealTimers());

  it('registers', () => {
    expect(phone.getSnapshot().registration.state).toBe('registered');
  });

  it('rings then connects after 1.5s, sends DTMF, emits CDR', async () => {
    const cdr = vi.fn();
    phone.on('cdr', cdr);
    const call = await phone.call('1002,99');
    await vi.advanceTimersByTimeAsync(200);
    expect(phone.getSnapshot().calls[0]!.state).toBe('ringing');
    await vi.advanceTimersByTimeAsync(1300);
    expect(phone.getSnapshot().calls[0]!.state).toBe('connected');
    expect(phone.dtmfLog).toEqual([{ callId: call.id, tones: '99' }]);
    await phone.sendDtmf('5');
    await phone.hangup();
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'local-hangup', called: '1002' }));
    expect(phone.getSnapshot().calls).toHaveLength(0);
  });

  it('holds, mutes, transfers', async () => {
    await phone.call('1002');
    await vi.advanceTimersByTimeAsync(1500);
    await phone.hold(true);
    expect(phone.getSnapshot().calls[0]!.state).toBe('held');
    await phone.hold(false);
    phone.mute(true);
    expect(phone.getSnapshot().calls[0]).toMatchObject({ state: 'connected', muted: true });
    await phone.transfer('1003');
    expect(phone.cdrs[0]!.reason).toBe('transferred');
  });

  it('attended transfer and conference', async () => {
    const original = await phone.call('1002');
    await vi.advanceTimersByTimeAsync(1500);
    const consult = await phone.startAttendedTransfer('1003');
    expect(phone.getSnapshot().calls.find((c) => c.id === original.id)!.state).toBe('held');
    await vi.advanceTimersByTimeAsync(1500);
    await phone.conference();
    expect(phone.getSnapshot().calls.every((c) => c.inConference)).toBe(true);
    await phone.completeAttendedTransfer(original.id, consult.id);
    expect(phone.getSnapshot().calls).toHaveLength(0);
  });

  it('removes, mutes and splits conference parties', async () => {
    await phone.updateConfig({ maxLines: 4 });
    const ids: string[] = [];
    for (const n of ['1002', '1003', '1004']) {
      ids.push((await phone.call(n)).id);
      await vi.advanceTimersByTimeAsync(1500);
    }
    await phone.conference();
    const [a, b, c] = ids as [string, string, string];
    const get = (id: string) => phone.getSnapshot().calls.find((x) => x.id === id)!;
    phone.setPartyMuted(a, true);
    expect(get(a).partyMuted).toBe(true);
    await phone.removeFromConference(c);
    expect(get(c)).toMatchObject({ inConference: false, state: 'held' });
    expect(get(a).inConference && get(b).inConference).toBe(true);
    phone.setActiveCall(b);
    await phone.splitConference();
    expect(get(b)).toMatchObject({ inConference: false, state: 'connected' });
    expect(get(a)).toMatchObject({ inConference: false, state: 'held', partyMuted: false });
  });

  it('handles incoming calls and auto answer', async () => {
    const incoming = phone.simulateIncomingCall('555', 'Bob')!;
    expect(incoming.state).toBe('ringing');
    await phone.reject();
    expect(phone.cdrs.at(-1)!.reason).toBe('rejected');
    await phone.updateConfig({ autoAnswer: true });
    phone.simulateIncomingCall('556');
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.getSnapshot().calls[0]!.state).toBe('connected');
  });

  it('refuses calls when not registered', async () => {
    await phone.unregister();
    await expect(phone.call('1')).rejects.toThrow(/Not registered/);
  });
});

describe('MockSoftphone resume (V2-RESUME-01)', () => {
  function memory() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it('restores an answered call after a "reload" with the same id and start time', async () => {
    const store = memory();
    const opts = { registerDelayMs: 0, resumeDelayMs: 10, resumeStorage: store };
    const first = new MockSoftphone({ username: '1001', password: 'x', resume: { enabled: true } }, opts);
    await first.start();
    const id = first.simulateIncomingCall('5550100', 'Jane')!.id;
    await first.answer(id);
    first.mute(true);
    const before = first.getSnapshot().calls[0]!;
    expect(before.anchorId).toMatch(/^\d{16}$/);

    // Reload: a new instance with no credentials in its config.
    const second = new MockSoftphone({ resume: { enabled: true } }, opts);
    const resumed: string[] = [];
    second.on('call:resumed', ({ call }) => resumed.push(call.id));
    await second.start();
    expect(second.config.username).toBe('1001');
    const restored = second.getSnapshot().calls[0]!;
    expect(restored).toMatchObject({ id, createdAt: before.createdAt, connectedAt: before.connectedAt, muted: true, resuming: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(resumed).toEqual([id]);
    expect(second.getSnapshot().calls[0]?.resuming).toBe(false);
    expect(second.getSnapshot().resume?.state).toBe('idle');
    await second.hangup(id);
    await second.unregister();
    expect(store.getItem('sipkit-mock:resume')).toBeNull();
  });
});
