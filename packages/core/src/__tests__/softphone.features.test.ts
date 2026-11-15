import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, FakeEngine } from '../testing';
import type { ConferenceMixer } from '../media/conference-mixer';
import type { Call } from '../types';
import { callByEngineIncoming } from './helpers';

async function connectedCall(number = '1002') {
  const ctx = await createTestSoftphone();
  const call = await ctx.softphone.call(number);
  ctx.engine.simulateRemoteAnswer(call.id);
  return { ...ctx, call };
}

describe('multi-line', () => {
  it('allocates the lowest free line and enforces maxLines', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { maxLines: 3 } });
    const a = await softphone.call('1');
    const b = await softphone.call('2');
    const c = await softphone.call('3');
    expect([a.line, b.line, c.line]).toEqual([1, 2, 3]);
    await expect(softphone.call('4')).rejects.toMatchObject({ code: 'MAX_LINES' });
    engine.simulateRemoteHangup(b.id);
    const d = await softphone.call('5');
    expect(d.line).toBe(2);
    expect(softphone.getSnapshot().calls.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it('auto-holds other connected lines when dialing or answering', async () => {
    const { softphone, engine, call } = await connectedCall();
    const second = await softphone.call('1003');
    expect(engine.commandsFor('setHold')).toEqual([[call.id, true]]);
    expect(softphone.getCall(call.id)).toMatchObject({ state: 'held', hold: 'local' });
    expect(softphone.getSnapshot().activeCallId).toBe(second.id);
    engine.simulateRemoteAnswer(second.id);
    const inc = engine.simulateIncomingCall();
    expect(softphone.getSnapshot().calls).toHaveLength(2 + 0); // maxLines=2 -> rejected
    expect(engine.commandsFor('reject')).toEqual([[inc, 486]]);
  });

  it('does not auto-hold when autoHoldOtherLines is false', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { autoHoldOtherLines: false } });
    const a = await softphone.call('1');
    engine.simulateRemoteAnswer(a.id);
    await softphone.call('2');
    expect(engine.commandsFor('setHold')).toHaveLength(0);
  });

  it('answering a second call holds the first and resuming swaps back', async () => {
    const { softphone, engine, call } = await connectedCall();
    const inc = engine.simulateIncomingCall();
    const incoming = callByEngineIncoming(softphone, inc);
    expect(softphone.getSnapshot().activeCallId).toBe(call.id); // ringing call does not steal focus
    await softphone.answer(incoming.id);
    expect(softphone.getCall(call.id)?.state).toBe('held');
    expect(softphone.getSnapshot().activeCallId).toBe(incoming.id);
    await softphone.hold(false, call.id);
    expect(softphone.getCall(call.id)?.state).toBe('connected');
    expect(softphone.getCall(incoming.id)?.state).toBe('held');
    expect(softphone.getSnapshot().activeCallId).toBe(call.id);
  });

  it('picks a new active call when the active one ends', async () => {
    const { softphone, engine, call } = await connectedCall();
    const second = await softphone.call('1003');
    engine.simulateRemoteHangup(second.id);
    expect(softphone.getSnapshot().activeCallId).toBe(call.id);
  });

  it('setActiveCall validates the id', async () => {
    const { softphone, call } = await connectedCall();
    softphone.setActiveCall(call.id);
    expect(() => softphone.setActiveCall('missing')).toThrowError(expect.objectContaining({ code: 'CALL_NOT_FOUND' }));
  });

  it('hangupAll ends every call', async () => {
    const { softphone } = await connectedCall();
    await softphone.call('1003');
    await softphone.hangupAll();
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });
});

describe('hold / mute / dtmf', () => {
  it('holds and resumes via the engine', async () => {
    const { softphone, engine, call } = await connectedCall();
    await softphone.hold(true);
    expect(softphone.getCall(call.id)).toMatchObject({ state: 'held', hold: 'local' });
    await softphone.hold(true); // idempotent
    expect(engine.commandsFor('setHold')).toHaveLength(1);
    await softphone.hold(false);
    expect(softphone.getCall(call.id)).toMatchObject({ state: 'connected', hold: 'none' });
  });

  it('tracks remote hold separately from local hold', async () => {
    const { softphone, engine, call } = await connectedCall();
    engine.simulateRemoteHold(call.id, true);
    expect(softphone.getCall(call.id)?.hold).toBe('remote');
    await softphone.hold(true);
    expect(softphone.getCall(call.id)?.hold).toBe('both');
    engine.simulateRemoteHold(call.id, false);
    expect(softphone.getCall(call.id)?.hold).toBe('local');
  });

  it('rejects hold on unanswered calls and surfaces engine failures', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const call = await softphone.call('1002');
    await expect(softphone.hold(true)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    engine.simulateRemoteAnswer(call.id);
    engine.failNext('setHold');
    await expect(softphone.hold(true)).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getCall(call.id)?.state).toBe('connected');
  });

  it('mutes via the engine', async () => {
    const { softphone, engine, call } = await connectedCall();
    softphone.mute(true);
    expect(engine.commandsFor('setMuted')).toEqual([[call.id, true]]);
    expect(softphone.getCall(call.id)?.muted).toBe(true);
  });

  it('throws NO_ACTIVE_CALL without calls', async () => {
    const { softphone } = await createTestSoftphone();
    expect(() => softphone.mute(true)).toThrowError(expect.objectContaining({ code: 'NO_ACTIVE_CALL' }));
    await expect(softphone.hold(true)).rejects.toMatchObject({ code: 'NO_ACTIVE_CALL' });
    await expect(softphone.hangup()).rejects.toMatchObject({ code: 'NO_ACTIVE_CALL' });
  });

  it('sends DTMF with validation', async () => {
    const { softphone, engine, call } = await connectedCall();
    await softphone.sendDtmf('12*#A,');
    expect(engine.commandsFor('sendDtmf')).toEqual([[call.id, '12*#A,']]);
    await expect(softphone.sendDtmf('x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await softphone.hold(true);
    await expect(softphone.sendDtmf('1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('transfers', () => {
  it('blind transfer sends REFER then ends the call as transferred', async () => {
    const { softphone, engine, call } = await connectedCall();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    await softphone.transfer('1005');
    expect(engine.commandsFor('blindTransfer')).toEqual([[call.id, '1005']]);
    expect(softphone.getSnapshot().calls).toHaveLength(0);
    expect(cdr).toHaveBeenCalledWith(expect.objectContaining({ reason: 'transferred' }));
  });

  it('blind transfer failure keeps the call', async () => {
    const { softphone, engine, call } = await connectedCall();
    engine.failNext('blindTransfer', new Error('REFER rejected (403)'));
    await expect(softphone.transfer('1005')).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getCall(call.id)?.state).toBe('connected');
  });

  it('attended transfer: hold, consult, complete', async () => {
    const { softphone, engine, call } = await connectedCall();
    const consult = await softphone.startAttendedTransfer('1006');
    expect(softphone.getCall(call.id)?.state).toBe('held');
    expect(consult.meta.consultFor).toBe(call.id);
    expect(softphone.getSnapshot().activeCallId).toBe(consult.id);
    await expect(softphone.completeAttendedTransfer(call.id, consult.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    engine.simulateRemoteAnswer(consult.id);
    await softphone.completeAttendedTransfer(call.id, consult.id);
    expect(engine.commandsFor('attendedTransfer')).toEqual([[call.id, consult.id]]);
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('attended transfer validates input and line availability', async () => {
    const { softphone, call } = await connectedCall();
    await expect(softphone.completeAttendedTransfer(call.id, call.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(softphone.completeAttendedTransfer(call.id, 'x')).rejects.toMatchObject({ code: 'CALL_NOT_FOUND' });
    await softphone.call('1003');
    await expect(softphone.startAttendedTransfer('1007', call.id)).rejects.toMatchObject({ code: 'MAX_LINES' });
  });

  it('resumes the original call if the consult call cannot be placed', async () => {
    const { softphone, engine, call } = await connectedCall();
    engine.failNext('call');
    await expect(softphone.startAttendedTransfer('1006')).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getCall(call.id)?.state).toBe('connected');
  });

  it('transfer requires an established call', async () => {
    const { softphone } = await createTestSoftphone();
    await softphone.call('1002');
    await expect(softphone.transfer('1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(softphone.startAttendedTransfer('1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('conference', () => {
  async function twoCalls(mixer?: () => ConferenceMixer | undefined) {
    const engine = new FakeEngine();
    const ctx = await createTestSoftphone({ engine, createMixer: mixer, config: { maxLines: 3 } });
    const a = await ctx.softphone.call('1002');
    engine.simulateRemoteAnswer(a.id);
    const b = await ctx.softphone.call('1003');
    engine.simulateRemoteAnswer(b.id);
    return { ...ctx, a, b };
  }

  it('unholds and marks calls as in conference (unmixed fallback warns)', async () => {
    const { softphone, engine, a, b } = await twoCalls();
    const notification = vi.fn();
    softphone.on('notification', notification);
    expect(softphone.getCall(a.id)?.state).toBe('held');
    await softphone.conference();
    expect(softphone.getCall(a.id)).toMatchObject({ state: 'connected', inConference: true });
    expect(softphone.getCall(b.id)).toMatchObject({ state: 'connected', inConference: true });
    expect(engine.commandsFor('setHold')).toContainEqual([a.id, false]);
    expect(notification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', code: 'conferenceMixingUnavailable' }));
  });

  it('needs at least two established calls', async () => {
    const { softphone, call } = await connectedCall();
    await expect(softphone.conference()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(softphone.conference([call.id, 'nope'])).rejects.toMatchObject({ code: 'CALL_NOT_FOUND' });
  });

  it('dissolves when only one party remains', async () => {
    const { softphone, engine, a, b } = await twoCalls();
    await softphone.conference([a.id, b.id]);
    engine.simulateRemoteHangup(b.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(softphone.getCall(a.id)?.inConference).toBe(false);
  });

  it('mute applies to all conference members', async () => {
    const { softphone, a, b } = await twoCalls();
    await softphone.conference();
    softphone.mute(true, a.id);
    expect(softphone.getCall(a.id)?.muted).toBe(true);
    expect(softphone.getCall(b.id)?.muted).toBe(true);
  });

  it('wires the mixer and replaces outgoing tracks when media is available', async () => {
    const track = (id: string) => ({ id, kind: 'audio', readyState: 'live' }) as unknown as MediaStreamTrack;
    const stream = (t: MediaStreamTrack) => ({ getAudioTracks: () => [t] }) as unknown as MediaStream;
    const mixed = new Map<string, MediaStreamTrack>();
    const fakeMixer = {
      has: (id: string) => mixed.has(id),
      setMicrophone: vi.fn(),
      setMicMuted: vi.fn(),
      addParty: vi.fn((id: string) => {
        const t = track(`mix-${id}`);
        mixed.set(id, t);
        return t;
      }),
      removeParty: vi.fn((id: string) => mixed.delete(id)),
      close: vi.fn(async () => undefined),
    } as unknown as ConferenceMixer;
    const { softphone, engine, a, b } = await twoCalls(() => fakeMixer);
    engine.streams.set(a.id, { local: stream(track('micA')), remote: stream(track('remA')) });
    engine.streams.set(b.id, { local: stream(track('micB')), remote: stream(track('remB')) });
    const notification = vi.fn();
    softphone.on('notification', notification);
    await softphone.conference();
    expect(notification).not.toHaveBeenCalled();
    const replaced = engine.commandsFor('replaceOutgoingTrack').map(([id, t]) => [id, (t as MediaStreamTrack).id]);
    expect(replaced).toEqual([
      [a.id, `mix-${a.id}`],
      [b.id, `mix-${b.id}`],
    ]);
    softphone.mute(true);
    expect(fakeMixer.setMicMuted).toHaveBeenLastCalledWith(true);
    engine.simulateRemoteHangup(b.id);
    await new Promise((r) => setTimeout(r, 0));
    // original mic restored on the remaining call and mixer closed
    const restored = engine.commandsFor('replaceOutgoingTrack').at(-1);
    expect([restored?.[0], (restored?.[1] as MediaStreamTrack).id]).toEqual([a.id, 'micA']);
    expect(fakeMixer.close).toHaveBeenCalled();
    expect(softphone.getCall(a.id)?.inConference).toBe(false);
  });
});

describe('conference: remove, split, per-party hangup and party mute', () => {
  const track = (id: string) => ({ id, kind: 'audio', readyState: 'live', enabled: true }) as unknown as MediaStreamTrack;
  const stream = (t: MediaStreamTrack) => ({ getAudioTracks: () => [t] }) as unknown as MediaStream;

  function fakeMixer() {
    const mixed = new Map<string, MediaStreamTrack>();
    return {
      mixed,
      mixer: {
        has: (id: string) => mixed.has(id),
        setMicrophone: vi.fn(),
        setMicMuted: vi.fn(),
        setPartyMuted: vi.fn(),
        addParty: vi.fn((id: string) => {
          const t = track(`mix-${id}`);
          mixed.set(id, t);
          return t;
        }),
        removeParty: vi.fn((id: string) => mixed.delete(id)),
        close: vi.fn(async () => undefined),
      },
    };
  }

  async function threeWay(withMixer = false) {
    const fm = fakeMixer();
    const engine = new FakeEngine();
    const ctx = await createTestSoftphone({
      engine,
      config: { maxLines: 4 },
      createMixer: withMixer ? () => fm.mixer as unknown as ConferenceMixer : undefined,
    });
    const calls: Call[] = [];
    for (const n of ['1002', '1003', '600']) {
      const c = await ctx.softphone.call(n);
      engine.simulateRemoteAnswer(c.id);
      engine.streams.set(c.id, { local: stream(track(`mic-${c.id}`)), remote: stream(track(`rem-${c.id}`)) });
      calls.push(c);
    }
    const [a, b, c] = calls as [Call, Call, Call];
    await ctx.softphone.conference();
    return { ...ctx, a, b, c, fm };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('removeFromConference keeps the party as a separate held call and the rest mixed', async () => {
    const { softphone, engine, a, b, c, fm } = await threeWay(true);
    engine.clearCommands();
    await softphone.removeFromConference(c.id);
    expect(softphone.getCall(c.id)).toMatchObject({ inConference: false, state: 'held' });
    expect(softphone.getCall(a.id)).toMatchObject({ inConference: true, state: 'connected' });
    expect(softphone.getCall(b.id)).toMatchObject({ inConference: true, state: 'connected' });
    // its own mic goes back on its sender, then it is held
    const restored = engine.commandsFor('replaceOutgoingTrack').map(([id, t]) => [id, (t as MediaStreamTrack).id]);
    expect(restored).toEqual([[c.id, `mic-${c.id}`]]);
    expect(engine.commandsFor('setHold')).toEqual([[c.id, true]]);
    expect(fm.mixer.removeParty).toHaveBeenCalledWith(c.id);
    expect(fm.mixer.close).not.toHaveBeenCalled();
  });

  it('removing down to one party ends the conference', async () => {
    const { softphone, a, b, c } = await threeWay();
    await softphone.removeFromConference(c.id);
    await softphone.removeFromConference(b.id);
    expect(softphone.getCall(a.id)).toMatchObject({ inConference: false, state: 'connected' });
    expect(softphone.getCall(b.id)).toMatchObject({ inConference: false, state: 'held' });
    await expect(softphone.removeFromConference(a.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('splitConference unmixes everyone, keeps the active call and holds the others', async () => {
    const { softphone, engine, a, b, c, fm } = await threeWay(true);
    softphone.setActiveCall(b.id);
    softphone.mute(true, a.id);
    engine.clearCommands();
    await softphone.splitConference();
    for (const call of [a, b, c]) expect(softphone.getCall(call.id)?.inConference).toBe(false);
    expect(softphone.getCall(b.id)?.state).toBe('connected');
    expect(softphone.getCall(a.id)?.state).toBe('held');
    expect(softphone.getCall(c.id)?.state).toBe('held');
    expect(softphone.getSnapshot().activeCallId).toBe(b.id);
    expect(fm.mixer.close).toHaveBeenCalled();
    // every original mic restored; muted flag re-applied at sender level
    const restored = engine.commandsFor('replaceOutgoingTrack').map(([id]) => id as string);
    expect(restored.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(engine.commandsFor('setMuted')).toContainEqual([b.id, true]);
    await expect(softphone.splitConference()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('splitConference honours an explicit keep call', async () => {
    const { softphone, a, b, c } = await threeWay();
    await softphone.splitConference(c.id);
    expect(softphone.getCall(c.id)?.state).toBe('connected');
    expect(softphone.getCall(a.id)?.state).toBe('held');
    expect(softphone.getCall(b.id)?.state).toBe('held');
  });

  it('hanging up one party leaves the others mixed; the last two keep working', async () => {
    const { softphone, a, b, c, fm } = await threeWay(true);
    await softphone.hangup(c.id);
    await tick();
    expect(softphone.getCall(c.id)).toBeUndefined();
    expect(softphone.getCall(a.id)).toMatchObject({ inConference: true, state: 'connected' });
    expect(softphone.getCall(b.id)).toMatchObject({ inConference: true, state: 'connected' });
    expect(fm.mixer.close).not.toHaveBeenCalled();
    await softphone.hangup(b.id);
    await tick();
    expect(softphone.getCall(a.id)).toMatchObject({ inConference: false, state: 'connected' });
    expect(fm.mixer.close).toHaveBeenCalled();
  });

  it('hangupAll ends every party', async () => {
    const { softphone } = await threeWay(true);
    await softphone.hangupAll();
    await tick();
    expect(softphone.getSnapshot().calls).toEqual([]);
  });

  it('setPartyMuted silences one party for everyone and is cleared on leave', async () => {
    const { softphone, engine, a, b, fm } = await threeWay(true);
    softphone.setPartyMuted(a.id, true);
    const remoteA = engine.streams.get(a.id)!.remote!.getAudioTracks()[0]!;
    expect(remoteA.enabled).toBe(false);
    expect(fm.mixer.setPartyMuted).toHaveBeenLastCalledWith(a.id, true);
    expect(softphone.getCall(a.id)?.partyMuted).toBe(true);
    expect(softphone.getCall(b.id)?.partyMuted).toBeFalsy();
    await softphone.removeFromConference(a.id);
    expect(remoteA.enabled).toBe(true);
    expect(softphone.getCall(a.id)?.partyMuted).toBe(false);
    expect(() => softphone.setPartyMuted(a.id, true)).toThrow(/conference/);
  });
});
