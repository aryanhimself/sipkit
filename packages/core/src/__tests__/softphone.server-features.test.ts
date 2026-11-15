import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, type FakeEngine } from '../testing';
import { createMemoryStorage } from '../storage';
import { getConferenceView, LOCAL_CONFERENCE_CAPABILITIES } from '../conference-view';
import { isSoftphoneError } from '../errors';
import type { Cdr, SoftphoneNotification } from '../types';
import { flush } from './helpers';

const SERVER_DND = { dnd: { mode: 'server' as const } };

/** Engine ids + targets of the silent feature-code calls so far. */
function serviceCalls(engine: FakeEngine): Array<{ id: string; target: string }> {
  return engine
    .commandsFor('call')
    .filter(([id]) => String(id).startsWith('svc-'))
    .map(([id, target]) => ({ id: String(id), target: String(target) }));
}

/** Answer (or fail) the newest feature-code call. */
async function settleLastServiceCall(engine: FakeEngine, outcome: 'answer' | number = 'answer'): Promise<string> {
  await flush();
  const last = serviceCalls(engine).at(-1);
  if (!last) throw new Error('No service call was dialled');
  if (outcome === 'answer') engine.simulateRemoteAnswer(last.id);
  else engine.simulateCallEnded(last.id, outcome === 486 ? 'busy' : 'failed', outcome);
  await flush();
  return last.target;
}

describe('server-side DND', () => {
  it('local mode (default) never dials feature codes', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await softphone.setDnd(true);
    expect(serviceCalls(engine)).toHaveLength(0);
  });

  it('pushes the client state on register, then dials *78 / *79 silently', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: SERVER_DND });
    const cdrs: Cdr[] = [];
    const created = vi.fn();
    softphone.on('cdr', (c) => cdrs.push(c));
    softphone.on('call:created', created);
    expect(await settleLastServiceCall(engine)).toBe('*79'); // sync on register

    const on = softphone.setDnd(true);
    expect(softphone.getSnapshot()).toMatchObject({ dnd: true });
    await flush();
    expect(softphone.getSnapshot().dndPending).toBe(true);
    expect(await settleLastServiceCall(engine)).toBe('*78');
    await on;
    expect(softphone.getSnapshot()).toMatchObject({ dnd: true, dndPending: false });
    // Answered feature code is hung up at once; no UI call, no CDR.
    expect(engine.commandsFor('hangup').map(([id]) => String(id))).toContain(serviceCalls(engine).at(-1)!.id);
    expect(created).not.toHaveBeenCalled();
    expect(cdrs).toHaveLength(0);
    expect(softphone.getSnapshot().calls).toHaveLength(0);

    // Server mode leaves rejecting to the PBX: an INVITE that still arrives rings.
    engine.simulateIncomingCall();
    expect(softphone.getSnapshot().calls).toHaveLength(1);
  });

  it('reverts the toggle, notifies and rejects when the feature code fails', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: SERVER_DND });
    await settleLastServiceCall(engine);
    const notes: SoftphoneNotification[] = [];
    const changes: boolean[] = [];
    softphone.on('notification', (n) => notes.push(n));
    softphone.on('dnd:changed', ({ dnd }) => changes.push(dnd));

    const on = softphone.setDnd(true);
    const settled = on.catch((e: unknown) => e);
    await settleLastServiceCall(engine, 404);
    const error = await settled;
    expect(isSoftphoneError(error, 'ENGINE_ERROR')).toBe(true);
    expect(softphone.getSnapshot()).toMatchObject({ dnd: false, dndPending: false });
    expect(changes).toEqual([true, false]);
    expect(notes).toEqual([
      expect.objectContaining({ level: 'error', code: 'dndServerFailed', params: { state: 'on', reason: 'SIP 404' } }),
    ]);
  });

  it('fails when the engine cannot place the call', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: SERVER_DND });
    await settleLastServiceCall(engine);
    engine.failNext('call', new Error('Not connected'));
    await expect(softphone.setDnd(true)).rejects.toThrow(/Not connected/);
    expect(softphone.getSnapshot().dnd).toBe(false);
  });

  it('times out after dnd.serverTimeout', async () => {
    vi.useFakeTimers();
    try {
      const { softphone, engine } = await createTestSoftphone({ config: { dnd: { mode: 'server', serverTimeout: 2, syncOnRegister: false } } });
      const on = softphone.setDnd(true).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2100);
      expect(String(await on)).toMatch(/no-answer/);
      expect(softphone.getSnapshot().dnd).toBe(false);
      expect(serviceCalls(engine)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers the intended state and re-applies it on the next registration', async () => {
    const storage = createMemoryStorage();
    const a = await createTestSoftphone({ storage, config: SERVER_DND });
    await settleLastServiceCall(a.engine);
    const on = a.softphone.setDnd(true);
    await settleLastServiceCall(a.engine);
    await on;
    await a.softphone.destroy();

    const b = await createTestSoftphone({ storage, config: SERVER_DND });
    expect(b.softphone.getSnapshot().dnd).toBe(true);
    expect(await settleLastServiceCall(b.engine)).toBe('*78');
  });

  it('queues changes made while unregistered and pushes them on register', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { ...SERVER_DND, autoRegister: false },
    });
    await softphone.setDnd(true);
    expect(serviceCalls(engine)).toHaveLength(0);
    await softphone.register();
    expect(await settleLastServiceCall(engine)).toBe('*78');
  });

  it('adopts the server state from the query code on register', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { dnd: { mode: 'server', serverQuery: '*76' } },
    });
    expect(await settleLastServiceCall(engine, 486)).toBe('*76');
    expect(softphone.getSnapshot().dnd).toBe(true);
  });

  it("'both' dials the code and still rejects locally; custom codes are used", async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { dnd: { mode: 'both', serverOn: '*21', serverOff: '*22' } },
    });
    expect(await settleLastServiceCall(engine)).toBe('*22');
    const on = softphone.setDnd(true);
    expect(await settleLastServiceCall(engine)).toBe('*21');
    await on;
    const id = engine.simulateIncomingCall();
    expect(engine.commandsFor('reject')).toEqual([[id, 486]]);
  });
});

describe('server (ConfBridge) conference', () => {
  async function twoCalls(config: Record<string, unknown> = {}) {
    const t = await createTestSoftphone({ config: { conference: { mode: 'server' }, ...config } });
    const first = await t.softphone.call('1002');
    t.engine.simulateRemoteAnswer(first.id);
    const second = await t.softphone.call('6000');
    t.engine.simulateRemoteAnswer(second.id);
    return { ...t, first, second };
  }

  /** The room leg's engine id once it has been dialled. */
  async function roomLeg(engine: FakeEngine, prefix = '7'): Promise<{ id: string; target: string; headers: string[] }> {
    await flush();
    const cmd = engine.commandsFor('call').find(([, target]) => String(target).startsWith(prefix));
    if (!cmd) throw new Error('Room not dialled');
    const opts = cmd[2] as { extraHeaders?: string[] } | undefined;
    return { id: String(cmd[0]), target: String(cmd[1]), headers: opts?.extraHeaders ?? [] };
  }

  it('joins room 7<username> as owner, then REFERs every party into it', async () => {
    const { softphone, engine, first, second } = await twoCalls();
    const cdrs: Cdr[] = [];
    softphone.on('cdr', (c) => cdrs.push(c));
    const merging = softphone.conference();
    const room = await roomLeg(engine);
    expect(room.target).toBe('71001');
    expect(room.headers).toEqual(['X-Sipkit-Conference: owner']);
    // Both parties are held while we join (one beyond maxLines is fine for the room leg).
    expect(softphone.getSnapshot().calls.filter((c) => c.state === 'held')).toHaveLength(2);
    engine.simulateRemoteAnswer(room.id);
    await merging;

    expect(engine.commandsFor('blindTransfer')).toEqual([
      [first.id, '71001'],
      [second.id, '71001'],
    ]);
    const calls = softphone.getSnapshot().calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ remoteNumber: '71001', inConference: true, state: 'connected' });
    expect(calls[0]!.conference).toMatchObject({
      room: '71001',
      participants: [
        expect.objectContaining({ id: first.id, remoteNumber: '1002' }),
        expect.objectContaining({ id: second.id, remoteNumber: '6000' }),
      ],
      capabilities: { partyMute: false, removeParty: false, split: false, survivesLeave: true },
    });
    expect(softphone.getSnapshot().activeCallId).toBe(calls[0]!.id);
    expect(cdrs.map((c) => c.reason)).toEqual(['transferred', 'transferred']);

    const view = getConferenceView(calls)!;
    expect(view.parties.map((p) => p.remoteNumber)).toEqual(['1002', '6000']);
    expect(view.capabilities.partyMute).toBe(false);

    // Per-party control is not available from the client.
    await expect(softphone.splitConference()).rejects.toThrow(/server conference/);
    expect(() => softphone.setPartyMuted(calls[0]!.id, true)).toThrow(/server conference/);
  });

  it('adds a later call to the existing room; end-on-leave and a fixed room are sent', async () => {
    const { softphone, engine } = await twoCalls({
      conference: { mode: 'server', serverRoom: '555', serverRoomPrefix: '8', serverEndOnLeave: true },
    });
    const merging = softphone.conference();
    const room = await roomLeg(engine, '8');
    expect(room.target).toBe('8555');
    expect(room.headers).toEqual(['X-Sipkit-Conference: owner', 'X-Sipkit-Conference-End: yes']);
    engine.simulateRemoteAnswer(room.id);
    await merging;
    expect(softphone.getSnapshot().calls[0]!.conference?.capabilities.survivesLeave).toBe(false);

    const third = await softphone.call('1003');
    engine.simulateRemoteAnswer(third.id);
    await softphone.conference();
    expect(engine.commandsFor('blindTransfer').at(-1)).toEqual([third.id, '8555']);
    expect(softphone.getSnapshot().calls[0]!.conference?.participants).toHaveLength(3);
  });

  it('keeps a party whose REFER fails on its own held line', async () => {
    const { softphone, engine, second } = await twoCalls();
    const notes: SoftphoneNotification[] = [];
    softphone.on('notification', (n) => notes.push(n));
    const original = engine.blindTransfer.bind(engine);
    engine.blindTransfer = async (id, target) => {
      if (id === second.id) throw new Error('603 Declined');
      return original(id, target);
    };
    const merging = softphone.conference();
    engine.simulateRemoteAnswer((await roomLeg(engine)).id);
    await merging;
    const calls = softphone.getSnapshot().calls;
    expect(calls.map((c) => `${c.remoteNumber}:${c.state}`).sort()).toEqual(['6000:held', '71001:connected']);
    expect(calls.find((c) => c.conference)!.conference!.participants).toHaveLength(1);
    expect(notes).toEqual([expect.objectContaining({ code: 'conferenceTransferFailed', params: { name: '6000' } })]);
  });

  it('fails cleanly when the room does not answer', async () => {
    const { softphone, engine } = await twoCalls();
    const merging = softphone.conference().catch((e: unknown) => e);
    const room = await roomLeg(engine);
    engine.simulateCallEnded(room.id, 'failed', 404);
    expect(String(await merging)).toMatch(/did not answer/);
    expect(engine.commandsFor('blindTransfer')).toHaveLength(0);
    expect(softphone.getSnapshot().calls.map((c) => c.remoteNumber).sort()).toEqual(['1002', '6000']);
  });

  it('local mode keeps the browser mixer and full capabilities', async () => {
    const t = await createTestSoftphone();
    const a = await t.softphone.call('1002');
    t.engine.simulateRemoteAnswer(a.id);
    const b = await t.softphone.call('1003');
    t.engine.simulateRemoteAnswer(b.id);
    await t.softphone.conference();
    expect(t.engine.commandsFor('blindTransfer')).toHaveLength(0);
    const view = getConferenceView(t.softphone.getSnapshot().calls)!;
    expect(view.capabilities).toEqual(LOCAL_CONFERENCE_CAPABILITIES);
    expect(view.parties).toHaveLength(2);
  });
});
