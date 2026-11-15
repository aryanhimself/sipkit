import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, type FakeEngine } from '../testing';
import { createMemoryStorage, type StorageLike } from '../storage';
import { isSoftphoneError } from '../errors';
import { parseResumeSnapshot, newAnchorId } from '../internal/resume';
import type { Call, ResumeSnapshot, SoftphoneNotification } from '../types';
import { flush } from './helpers';

const RESUME = { resume: { enabled: true, rejoinTimeoutMs: 30_000 } };
const KEY = 'sipkit:resume';

/** A "browser profile": localStorage + sessionStorage that survive a reload. */
function profile(): { storage: StorageLike; session: StorageLike } {
  return { storage: createMemoryStorage(), session: createMemoryStorage() };
}

function stored(session: StorageLike): ResumeSnapshot | null {
  const raw = session.getItem(KEY);
  return raw ? (JSON.parse(raw) as ResumeSnapshot) : null;
}

function calls(engine: FakeEngine, prefix: string): Array<{ id: string; target: string; headers?: string[] }> {
  return engine
    .commandsFor('call')
    .map(([id, target, opts]) => ({ id: String(id), target: String(target), headers: (opts as { extraHeaders?: string[] } | undefined)?.extraHeaders }))
    .filter((c) => c.target.startsWith(prefix));
}

/** Answer an incoming anchored call on a fresh softphone in the given profile. */
async function answeredAnchoredCall(p = profile(), config = RESUME) {
  const { softphone, engine } = await createTestSoftphone({ config, storage: p.storage, resumeStorage: p.session });
  const engineId = engine.simulateIncomingCall({ remoteNumber: '1001', remoteDisplayName: 'Agent 1001', anchorId: '1731500000123' });
  await flush();
  await softphone.answer();
  await flush();
  return { softphone, engine, engineId, p, call: softphone.getSnapshot().calls[0]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resume: registration continuity', () => {
  it('passes a stable instance id and the rejoin timeout to the engine', async () => {
    const p = profile();
    const first = await createTestSoftphone({ config: RESUME, storage: p.storage, resumeStorage: p.session });
    const r1 = first.engine.resumeOptions;
    await first.softphone.destroy();
    const second = await createTestSoftphone({ config: RESUME, storage: p.storage, resumeStorage: p.session });
    const r2 = second.engine.resumeOptions;
    expect(r1?.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1?.rejoinTimeoutSec).toBe(30);
    expect(r2?.instanceId).toBe(r1?.instanceId);
  });

  it('is off by default: no engine resume options, no anchor headers, no storage', async () => {
    const p = profile();
    const { softphone, engine } = await createTestSoftphone({ storage: p.storage, resumeStorage: p.session });
    expect(engine.resumeOptions).toBeUndefined();
    await softphone.call('1002');
    expect(calls(engine, '1002')[0]?.headers ?? []).not.toContain(expect.stringContaining('X-Sipkit-Anchor'));
    expect(p.session.getItem(KEY)).toBeNull();
  });

  it('shows "resuming" after a reload until registered again, and keeps DND', async () => {
    const p = profile();
    const first = await createTestSoftphone({ config: RESUME, storage: p.storage, resumeStorage: p.session });
    await first.softphone.setDnd(true);
    expect(stored(p.session)?.calls).toEqual([]);
    // Reload: the old instance just disappears (no stop, no unregister).
    const second = await createTestSoftphone({
      config: RESUME,
      storage: p.storage,
      resumeStorage: p.session,
      engineOptions: { autoRegister: false },
      start: false,
    });
    const resuming = vi.fn();
    second.softphone.on('registration:resuming', resuming);
    await second.softphone.start();
    expect(resuming).toHaveBeenCalledWith({ calls: [] });
    expect(second.softphone.getSnapshot().resume).toEqual({ state: 'resuming', pendingCalls: 0 });
    expect(second.softphone.getSnapshot().dnd).toBe(true);
    second.engine.simulateRegistered();
    await flush();
    expect(second.softphone.getSnapshot().resume?.state).toBe('idle');
  });

  it('unregister() and stop() forget the descriptor', async () => {
    const p = profile();
    const { softphone } = await createTestSoftphone({ config: RESUME, storage: p.storage, resumeStorage: p.session });
    expect(p.session.getItem(KEY)).not.toBeNull();
    await softphone.unregister();
    expect(p.session.getItem(KEY)).toBeNull();
    await softphone.stop();
    expect(p.session.getItem(KEY)).toBeNull();
  });
});

describe('resume: anchored calls', () => {
  it('keeps the PBX anchor id of an answered incoming call and persists it', async () => {
    const { call, p } = await answeredAnchoredCall();
    expect(call.anchorId).toBe('1731500000123');
    const snap = stored(p.session)!;
    expect(snap.username).toBe('1001');
    expect(snap.calls).toEqual([
      expect.objectContaining({ id: call.id, anchorId: '1731500000123', remoteNumber: '1001', direction: 'incoming', muted: false, held: false }),
    ]);
    expect(snap.activeCallId).toBe(call.id);
  });

  it('ignores an anchor header while resume is off', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.simulateIncomingCall({ remoteNumber: '1001', anchorId: '1731500000123' });
    await flush();
    expect(softphone.getSnapshot().calls[0]?.anchorId).toBeUndefined();
  });

  it('anchors outgoing calls with X-Sipkit-Anchor + timeout headers', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { ...RESUME, extraHeaders: ['X-Agent: 7'] } });
    const call = await softphone.call('1002');
    const headers = calls(engine, '1002')[0]!.headers!;
    expect(call.anchorId).toMatch(/^\d{16}$/);
    expect(headers).toEqual(['X-Agent: 7', `X-Sipkit-Anchor: ${call.anchorId}`, 'X-Sipkit-Anchor-Timeout: 30']);
  });

  it('a real hangup dials *86<anchor> silently', async () => {
    const { softphone, engine, call } = await answeredAnchoredCall();
    await softphone.hangup();
    await flush();
    expect(calls(engine, '*86').map((c) => c.target)).toEqual([`*86${call.anchorId}`]);
    expect(calls(engine, '*86')[0]!.id).toMatch(/^svc-/);
  });

  it('a remote hangup does not dial *86', async () => {
    const { softphone, engine, engineId } = await answeredAnchoredCall();
    engine.simulateRemoteHangup(engineId);
    await flush();
    expect(softphone.getSnapshot().calls).toHaveLength(0);
    expect(calls(engine, '*86')).toHaveLength(0);
  });

  it('refuses transfers of anchored calls', async () => {
    const { softphone } = await answeredAnchoredCall();
    await expect(softphone.transfer('1003')).rejects.toSatisfy((e: unknown) => isSoftphoneError(e, 'NOT_SUPPORTED'));
  });
});

describe('resume: after a reload', () => {
  it('restores the call with the same id and start time, rejoins *85<anchor> and announces call:resumed', async () => {
    const before = await answeredAnchoredCall();
    before.softphone.mute(true);
    await before.softphone.hold(true);
    const original = before.softphone.getSnapshot().calls[0]!;
    // Reload.
    const after = await createTestSoftphone({ config: RESUME, storage: before.p.storage, resumeStorage: before.p.session, start: false });
    const resumed = vi.fn();
    after.softphone.on('call:resumed', resumed);
    await after.softphone.start();
    await flush();
    const restored = after.softphone.getSnapshot().calls[0]!;
    expect(restored).toMatchObject({
      id: original.id,
      createdAt: original.createdAt,
      connectedAt: original.connectedAt,
      anchorId: original.anchorId,
      state: 'held',
      muted: true,
      resuming: true,
    });
    expect(after.softphone.getSnapshot().activeCallId).toBe(original.id);
    const rejoin = calls(after.engine, '*85');
    expect(rejoin).toEqual([expect.objectContaining({ id: original.id, target: `*85${original.anchorId}` })]);
    // Hold is refused while reconnecting; mute is just remembered.
    await expect(after.softphone.hold(false)).rejects.toSatisfy((e: unknown) => isSoftphoneError(e, 'INVALID_STATE'));

    after.engine.simulateRemoteAnswer(original.id);
    await flush();
    const live = after.softphone.getSnapshot().calls[0]!;
    expect(live.resuming).toBe(false);
    expect(live.connectedAt).toBe(original.connectedAt);
    expect(resumed).toHaveBeenCalledWith({ call: expect.objectContaining({ id: original.id }) });
    expect(after.engine.commandsFor('setMuted')).toContainEqual([original.id, true]);
    expect(after.engine.commandsFor('setHold')).toContainEqual([original.id, true]);
    expect(after.softphone.getSnapshot().resume?.state).toBe('idle');
    // Still anchored after the reload: a hangup ends the room.
    await after.softphone.hold(false);
    await after.softphone.hangup();
    await flush();
    expect(calls(after.engine, '*86').map((c) => c.target)).toEqual([`*86${original.anchorId}`]);
  });

  it('waits for registration before dialling the rejoin', async () => {
    const before = await answeredAnchoredCall();
    const after = await createTestSoftphone({
      config: RESUME,
      storage: before.p.storage,
      resumeStorage: before.p.session,
      engineOptions: { autoRegister: false },
    });
    await flush();
    expect(after.softphone.getSnapshot().calls[0]?.resuming).toBe(true);
    expect(calls(after.engine, '*85')).toHaveLength(0);
    after.engine.simulateRegistered();
    await flush();
    expect(calls(after.engine, '*85')).toHaveLength(1);
  });

  it('ends the call with a notification when the anchor is gone (404)', async () => {
    const before = await answeredAnchoredCall();
    const id = before.call.id;
    const after = await createTestSoftphone({ config: RESUME, storage: before.p.storage, resumeStorage: before.p.session, start: false });
    const notes: SoftphoneNotification[] = [];
    const ended: Call[] = [];
    after.softphone.on('notification', (n) => notes.push(n));
    after.softphone.on('call:ended', ({ call }) => ended.push(call));
    await after.softphone.start();
    await flush();
    after.engine.simulateCallEnded(id, 'failed', 404);
    await flush();
    expect(after.softphone.getSnapshot().calls).toHaveLength(0);
    expect(ended[0]).toMatchObject({ id, disconnectReason: 'failed', disconnectCode: 404 });
    expect(notes).toContainEqual(expect.objectContaining({ code: 'callResumeFailed', params: { name: 'Agent 1001' } }));
    expect(after.softphone.getSnapshot().resume?.state).toBe('idle');
    expect(calls(after.engine, '*86')).toHaveLength(0);
  });

  it('drops calls older than the rejoin timeout (the PBX already ran its fallback)', async () => {
    const before = await answeredAnchoredCall();
    const snap = stored(before.p.session)!;
    before.p.session.setItem(KEY, JSON.stringify({ ...snap, savedAt: Date.now() - 31_000 }));
    const after = await createTestSoftphone({ config: RESUME, storage: before.p.storage, resumeStorage: before.p.session });
    await flush();
    expect(after.softphone.getSnapshot().calls).toHaveLength(0);
    expect(calls(after.engine, '*85')).toHaveLength(0);
  });

  it('ignores a descriptor of another account', async () => {
    const before = await answeredAnchoredCall();
    const after = await createTestSoftphone({
      config: { ...RESUME, username: '1009' },
      storage: before.p.storage,
      resumeStorage: before.p.session,
    });
    await flush();
    expect(after.softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('gives up when the rejoin call is not answered in time', async () => {
    const before = await answeredAnchoredCall();
    vi.useFakeTimers();
    const after = await createTestSoftphone({
      config: { resume: { enabled: true, rejoinCallTimeout: 2 } },
      storage: before.p.storage,
      resumeStorage: before.p.session,
    });
    await flush();
    expect(after.softphone.getSnapshot().calls[0]?.resuming).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(after.softphone.getSnapshot().calls).toHaveLength(0);
    expect(after.engine.commandsFor('hangup')).toContainEqual([before.call.id]);
  });

  it('hanging up while reconnecting ends the anchor room', async () => {
    const before = await answeredAnchoredCall();
    const after = await createTestSoftphone({ config: RESUME, storage: before.p.storage, resumeStorage: before.p.session });
    await flush();
    await after.softphone.hangup();
    await flush();
    expect(after.softphone.getSnapshot().calls).toHaveLength(0);
    expect(calls(after.engine, '*86').map((c) => c.target)).toEqual([`*86${before.call.anchorId}`]);
    expect(after.softphone.getSnapshot().resume?.state).toBe('idle');
  });

  it('resume(state) restores an exported descriptor (leader-tab takeover)', async () => {
    const before = await answeredAnchoredCall();
    const exported = before.softphone.exportResumeState()!;
    expect(exported.calls).toHaveLength(1);
    const other = await createTestSoftphone({ config: RESUME });
    await other.softphone.resume(exported);
    await flush();
    expect(other.softphone.getSnapshot().calls[0]).toMatchObject({ id: before.call.id, resuming: true });
    expect(calls(other.engine, '*85')).toHaveLength(1);
    await expect(other.softphone.resume({ bogus: true } as never)).rejects.toSatisfy((e: unknown) =>
      isSoftphoneError(e, 'INVALID_ARGUMENT'),
    );
  });

  it('resume() can replace start() and is just start() while resume is off', async () => {
    const { softphone } = await createTestSoftphone({ start: false });
    await softphone.resume();
    expect(softphone.getSnapshot().app).toBe('started');
    expect(softphone.getSnapshot().registration.state).toBe('registered');
    await softphone.resume();
    expect(softphone.getSnapshot().calls).toHaveLength(0);
  });

  it('resume() before start() restores the stored descriptor once', async () => {
    const before = await answeredAnchoredCall();
    const after = await createTestSoftphone({ config: RESUME, storage: before.p.storage, resumeStorage: before.p.session, start: false });
    await after.softphone.resume();
    await flush();
    expect(after.softphone.getSnapshot().calls).toHaveLength(1);
    expect(calls(after.engine, '*85')).toHaveLength(1);
  });
});

describe('resume helpers', () => {
  it('newAnchorId is 16 digits', () => {
    expect(newAnchorId()).toMatch(/^\d{16}$/);
  });

  it('parseResumeSnapshot drops invalid calls and rejects garbage', () => {
    expect(parseResumeSnapshot(null)).toBeNull();
    expect(parseResumeSnapshot({ version: 2 })).toBeNull();
    const parsed = parseResumeSnapshot({
      version: 1,
      savedAt: 1,
      username: '1001',
      activeCallId: 5,
      calls: [
        { id: 'a', anchorId: '123456', remoteNumber: '1', createdAt: 1, direction: 'incoming', line: 1, muted: false, held: false },
        { id: 'b', anchorId: 'x;y', remoteNumber: '1', createdAt: 1, direction: 'incoming' },
      ],
    });
    expect(parsed?.calls.map((c) => c.id)).toEqual(['a']);
    expect(parsed?.activeCallId).toBeNull();
  });
});
