import type { ResolvedConfig } from '../config';
import type { PluginStorage } from '../plugin';
import type { StorageLike } from '../storage';
import type {
  Call,
  CallId,
  EngineStartOptions,
  Logger,
  RegistrationState,
  ResumeCallDescriptor,
  ResumeSnapshot,
  ResumeState,
  SoftphoneEngine,
  SoftphoneEvents,
} from '../types';
import type { CallRecord, CallRegistry } from './call-registry';
import type { ServiceCalls } from './service-call';
import type { TimerRegistry } from './timers';

export interface ResumeDeps {
  config: () => ResolvedConfig;
  logger: Logger;
  /** Where the descriptor lives (sessionStorage by default, see `resume.storage`). */
  storage: () => StorageLike;
  /** Profile-wide core storage (localStorage): the stable instance id. */
  coreStorage: PluginStorage;
  calls: CallRegistry;
  engine: SoftphoneEngine;
  service: ServiceCalls;
  timers: TimerRegistry;
  getActive: () => CallId | null;
  setActive: (id: CallId | null) => void;
  registrationState: () => RegistrationState;
  get: () => ResumeState;
  set: (state: ResumeState) => void;
  emit: <K extends keyof SoftphoneEvents>(event: K, payload: SoftphoneEvents[K]) => void;
  notify: (n: SoftphoneEvents['notification']) => void;
  /** End a call through call control (idempotent). */
  end: (id: CallId, reason: 'failed' | 'local-hangup', code?: number) => void;
}

export const IDLE_RESUME: ResumeState = { state: 'idle', pendingCalls: 0 };

const STORAGE_KEY = 'sipkit:resume';
const INSTANCE_KEY = 'instanceId';
const ANCHOR_HEADER = 'X-Sipkit-Anchor';
const ESTABLISHED = new Set<Call['state']>(['connected', 'held']);

/** RFC 4122 v4 UUID (crypto when available). */
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A digits-only anchor id for outgoing calls (the dialplan filters 0-9, at least 6 digits). */
export function newAnchorId(): string {
  let id = `${Date.now() % 1_000_000_000}`;
  while (id.length < 16) id += Math.floor(Math.random() * 10);
  return id;
}

function isDescriptor(value: unknown): value is ResumeCallDescriptor {
  const d = value as ResumeCallDescriptor;
  return Boolean(d) && typeof d.id === 'string' && typeof d.anchorId === 'string' && /^\d{6,32}$/.test(d.anchorId) &&
    typeof d.remoteNumber === 'string' && typeof d.createdAt === 'number' && (d.direction === 'incoming' || d.direction === 'outgoing');
}

/** Validate an untrusted (stored / passed-in) snapshot. */
export function parseResumeSnapshot(value: unknown): ResumeSnapshot | null {
  const s = value as ResumeSnapshot;
  if (!s || s.version !== 1 || typeof s.savedAt !== 'number' || typeof s.username !== 'string' || !Array.isArray(s.calls)) return null;
  return { ...s, calls: s.calls.filter(isDescriptor), activeCallId: typeof s.activeCallId === 'string' ? s.activeCallId : null };
}

/**
 * Reload-safe softphone (V2-RESUME-01, docs/resume.md).
 *
 * - Keeps a stable `+sip.instance` per browser profile and tells the PBX (Contact
 *   `;sipkit-resume=<s>`, `X-Sipkit-Anchor` on INVITEs) to anchor answered calls in a
 *   ConfBridge room that survives the page.
 * - Persists the anchored calls (id, anchor, times, mute/hold) on every change.
 * - After a reload, `restore()` puts them back in the snapshot with the same id
 *   and start time (`resuming: true`) and, once registered, dials `*85<anchor>`
 *   for each. When that answers the call is live again (`call:resumed`).
 * - A real hangup also dials `*86<anchor>` so the PBX ends the room.
 */
export class ResumeController {
  private pending = new Set<CallId>();
  private dialed = new Set<CallId>();
  private deadline: number | undefined;
  private unloadOff: (() => void) | undefined;
  private suspended = false;
  private readonly ending = new Set<Promise<void>>();

  constructor(private readonly d: ResumeDeps) {}

  private get cfg(): ResolvedConfig {
    return this.d.config();
  }

  get enabled(): boolean {
    return this.cfg.resume.enabled;
  }

  /** Stable per-profile instance id (persisted in the core storage). */
  instanceId(): string {
    const stored = this.d.coreStorage.get<string>(INSTANCE_KEY);
    if (typeof stored === 'string' && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
    const id = uuid();
    this.d.coreStorage.set(INSTANCE_KEY, id);
    return id;
  }

  engineOptions(): EngineStartOptions['resume'] {
    if (!this.enabled) return undefined;
    return { instanceId: this.instanceId(), rejoinTimeoutSec: Math.round(this.cfg.resume.rejoinTimeoutMs / 1000) };
  }

  /** Headers + anchor id for a new outgoing call (resume on), else undefined. */
  outgoing(): { anchorId: string; headers: string[] } | undefined {
    if (!this.enabled) return undefined;
    const anchorId = newAnchorId();
    const seconds = Math.round(this.cfg.resume.rejoinTimeoutMs / 1000);
    return { anchorId, headers: [`${ANCHOR_HEADER}: ${anchorId}`, `${ANCHOR_HEADER}-Timeout: ${seconds}`] };
  }

  /** Anchor id to keep for an incoming call (only with resume on and a PBX that sent one). */
  incoming(anchorId: string | undefined): string | undefined {
    return this.enabled && anchorId && /^\d{6,32}$/.test(anchorId) ? anchorId : undefined;
  }

  isResuming(call: Call): boolean {
    return Boolean(call.resuming);
  }

  // ------------------------------------------------------------ persistence

  /** Start watching pagehide (fresh `savedAt`). */
  attach(): void {
    if (this.unloadOff || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onHide = () => this.persist(true);
    window.addEventListener('pagehide', onHide);
    this.unloadOff = () => window.removeEventListener('pagehide', onHide);
  }

  detach(): void {
    this.unloadOff?.();
    this.unloadOff = undefined;
  }

  /** Snapshot of what a reload would restore, or null. */
  export(): ResumeSnapshot | null {
    if (!this.enabled) return null;
    const calls = this.d.calls
      .all()
      .map((r) => r.call)
      .filter((c) => c.anchorId && (ESTABLISHED.has(c.state) || c.resuming))
      .map<ResumeCallDescriptor>((c) => ({
        id: c.id,
        anchorId: c.anchorId!,
        line: c.line,
        direction: c.direction,
        remoteNumber: c.remoteNumber,
        ...(c.remoteDisplayName ? { remoteDisplayName: c.remoteDisplayName } : {}),
        createdAt: c.createdAt,
        ...(c.connectedAt !== undefined ? { connectedAt: c.connectedAt } : {}),
        muted: c.muted,
        held: c.state === 'held' || c.hold === 'local' || c.hold === 'both',
        ...(c.sipCallId ? { sipCallId: c.sipCallId } : {}),
        ...(c.inviteHeaders ? { inviteHeaders: c.inviteHeaders } : {}),
        ...(c.pushId ? { pushId: c.pushId } : {}),
      }));
    const registered = this.d.registrationState() === 'registered';
    if (calls.length === 0 && !registered && this.d.get().state !== 'resuming') return null;
    const active = this.d.getActive();
    return {
      version: 1,
      savedAt: Date.now(),
      username: this.cfg.username,
      activeCallId: calls.some((c) => c.id === active) ? active : (calls[0]?.id ?? null),
      calls,
    };
  }

  /** Write the descriptor (called on every call / registration change). */
  persist(force = false): void {
    if (!this.enabled || (this.suspended && !force)) return;
    const snapshot = this.export();
    try {
      const store = this.d.storage();
      if (snapshot) store.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      else if (this.d.get().state !== 'resuming') store.removeItem(STORAGE_KEY);
    } catch (error) {
      this.d.logger.debug('Persisting the resume state failed', error);
    }
  }

  /** Forget the descriptor (explicit stop / sign out). */
  clear(): void {
    try {
      this.d.storage().removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Read and validate the stored descriptor (stale or foreign ones are dropped). */
  load(): ResumeSnapshot | null {
    if (!this.enabled) return null;
    let parsed: ResumeSnapshot | null = null;
    try {
      const raw = this.d.storage().getItem(STORAGE_KEY);
      parsed = raw ? parseResumeSnapshot(JSON.parse(raw)) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return null;
    if (parsed.username !== this.cfg.username) {
      this.d.logger.info('Stored resume state belongs to another account; ignoring it');
      this.clear();
      return null;
    }
    if (Date.now() - parsed.savedAt > this.cfg.resume.rejoinTimeoutMs) {
      // The PBX already ran its fallback for these calls; still show "reconnecting" for registration.
      return { ...parsed, calls: [] };
    }
    return parsed;
  }

  // ------------------------------------------------------------ restore

  /**
   * Put the calls of `state` back into the snapshot (same id, line, start time)
   * and rejoin their anchors as soon as we are registered.
   */
  restore(state: ResumeSnapshot): void {
    if (!this.enabled) return;
    const restored: CallId[] = [];
    const age = Math.max(0, Date.now() - state.savedAt);
    this.deadline = Date.now() + Math.max(1000, this.cfg.resume.rejoinTimeoutMs - age);
    for (const c of state.calls) {
      if (this.d.calls.get(c.id) || [...this.d.calls.all()].some((r) => r.call.anchorId === c.anchorId)) continue;
      const line =
        this.d.calls.all().some((r) => r.call.line === c.line) || c.line < 1
          ? this.d.calls.freeLine(Math.max(this.cfg.maxLines, 8))
          : c.line;
      if (line === undefined) continue;
      this.d.calls.create(
        {
          direction: c.direction,
          state: c.held ? 'held' : 'connected',
          line,
          remoteNumber: c.remoteNumber,
          remoteDisplayName: c.remoteDisplayName,
          sipCallId: c.sipCallId,
          anchorId: c.anchorId,
          createdAt: c.createdAt,
          connectedAt: c.connectedAt ?? c.createdAt,
          ...(c.inviteHeaders ? { inviteHeaders: c.inviteHeaders } : {}),
          ...(c.pushId ? { pushId: c.pushId } : {}),
        },
        c.id,
      );
      this.d.calls.patch(c.id, { muted: c.muted, hold: c.held ? 'local' : 'none', resuming: true });
      this.pending.add(c.id);
      restored.push(c.id);
    }
    const active = state.activeCallId && this.d.calls.get(state.activeCallId) ? state.activeCallId : restored[0];
    if (active && !this.d.getActive()) this.d.setActive(active);
    this.d.set({ state: 'resuming', pendingCalls: this.pending.size });
    this.d.logger.info(`Resuming after reload: ${restored.length} call(s) to rejoin`);
    this.d.emit('registration:resuming', { calls: restored });
    if (this.pending.size > 0) {
      this.d.timers.set('resume:deadline', this.deadline - Date.now(), () => this.giveUp('timeout'));
    }
    if (this.d.registrationState() === 'registered') this.rejoinAll();
  }

  /** Feed every registration change. */
  onRegistration(state: RegistrationState): void {
    if (!this.enabled) return;
    if (state === 'registered') {
      this.rejoinAll();
      this.settle();
    }
    this.persist();
  }

  private rejoinAll(): void {
    for (const id of this.pending) {
      if (this.dialed.has(id)) continue;
      const record = this.d.calls.get(id);
      if (!record) {
        this.pending.delete(id);
        continue;
      }
      this.dialed.add(id);
      void this.rejoin(record);
    }
  }

  private async rejoin(record: CallRecord): Promise<void> {
    const { call } = record;
    const target = `${this.cfg.resume.rejoinPrefix.trim()}${call.anchorId}`;
    this.d.logger.info(`Rejoining anchor ${call.anchorId} for call ${call.id}`);
    this.d.timers.set(`${call.id}:rejoin`, this.cfg.resume.rejoinCallTimeout * 1000, () => {
      if (this.pending.has(call.id)) this.failed(call.id, 'rejoin call timed out');
    });
    try {
      const extraHeaders = this.cfg.extraHeaders.length ? [...this.cfg.extraHeaders] : undefined;
      await this.d.engine.call(record.engineId, target, extraHeaders ? { extraHeaders } : undefined);
    } catch (error) {
      this.d.logger.warn(`Rejoining anchor ${call.anchorId} failed`, error);
      this.failed(call.id, 'rejoin call failed');
    }
  }

  /** The rejoin call answered: restore mute/hold on the new media and announce it. */
  async onRejoined(record: CallRecord): Promise<void> {
    const id = record.call.id;
    if (!this.pending.delete(id)) return;
    this.d.timers.clear(`${id}:rejoin`);
    const current = this.d.calls.patch(id, { resuming: false });
    if (!current) return;
    if (current.muted) this.d.engine.setMuted(record.engineId, true);
    if (current.state === 'held') {
      await this.d.engine.setHold(record.engineId, true).catch((e: unknown) => this.d.logger.warn('Restoring hold failed', e));
    }
    this.d.logger.info(`Call ${id} resumed (anchor ${current.anchorId})`);
    this.d.emit('call:resumed', { call: this.d.calls.get(id)?.call ?? current });
    this.settle();
    this.persist();
  }

  /** The rejoin call ended before answering (anchor gone: customer hung up or fallback ran). */
  onRejoinFailed(record: CallRecord, code?: number): void {
    this.failed(record.call.id, code ? `SIP ${code}` : 'ended', code);
  }

  private failed(id: CallId, why: string, code?: number): void {
    if (!this.pending.delete(id)) return;
    const record = this.d.calls.get(id);
    this.d.timers.clear(`${id}:rejoin`);
    if (record) {
      this.d.logger.warn(`Could not resume call ${id}: ${why}`);
      this.d.engine.hangup(record.engineId).catch(() => undefined);
      const who = record.call.remoteDisplayName ?? record.call.remoteNumber;
      this.d.notify({
        level: 'warning',
        title: 'Call ended',
        message: `The call with ${who} could not be reconnected`,
        code: 'callResumeFailed',
        params: { name: who },
      });
      this.d.end(id, 'failed', code);
    }
    this.settle();
    this.persist();
  }

  private giveUp(why: string): void {
    for (const id of [...this.pending]) this.failed(id, why);
  }

  /** A pending call ended some other way (user hung up while reconnecting). */
  forget(id: CallId): void {
    if (!this.pending.delete(id)) return;
    this.d.timers.clear(`${id}:rejoin`);
    this.settle();
  }

  private settle(): void {
    const registered = this.d.registrationState() === 'registered';
    if (this.pending.size === 0 && registered) {
      this.d.timers.clear('resume:deadline');
      if (this.d.get().state !== 'idle') this.d.set({ ...IDLE_RESUME });
    } else if (this.d.get().state === 'resuming' && this.d.get().pendingCalls !== this.pending.size) {
      this.d.set({ state: 'resuming', pendingCalls: this.pending.size });
    }
  }

  // ------------------------------------------------------------ hangup

  /** A real, user-initiated hangup of an anchored call: tell the PBX to end the room. */
  onLocalHangup(call: Call): void {
    if (!call.anchorId) return;
    this.forget(call.id);
    const target = `${this.cfg.resume.endPrefix.trim()}${call.anchorId}`;
    const done = this.d.service.dial(target, this.cfg.resume.rejoinCallTimeout * 1000).then((result) => {
      if (!result.answered) this.d.logger.warn(`Ending anchor ${call.anchorId} failed (${result.code ?? result.reason})`);
    });
    this.ending.add(done);
    void done.finally(() => this.ending.delete(done));
  }

  /** Wait (bounded) for the *86 calls in flight, e.g. before stopping the engine. */
  async flush(): Promise<void> {
    if (this.ending.size === 0) return;
    await Promise.race([
      Promise.all([...this.ending]),
      new Promise((resolve) => setTimeout(resolve, this.cfg.resume.rejoinCallTimeout * 1000)),
    ]);
  }

  /** Stop persisting (stop()/destroy()): the descriptor is cleared by the caller when wanted. */
  suspend(): void {
    this.suspended = true;
    this.giveUpSilently();
  }

  resumeWriting(): void {
    this.suspended = false;
  }

  private giveUpSilently(): void {
    for (const id of [...this.pending]) this.d.timers.clear(`${id}:rejoin`);
    this.pending.clear();
    this.dialed.clear();
    this.d.timers.clear('resume:deadline');
    if (this.d.get().state !== 'idle') this.d.set({ ...IDLE_RESUME });
  }
}
