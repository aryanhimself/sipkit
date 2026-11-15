import type { Call, CallDirection, CallId, CallState, Cdr, DisconnectReason } from '../types';

/** Internal per-call bookkeeping next to the public immutable Call snapshot. */
export interface CallRecord {
  call: Call;
  /** Id used with the engine (outgoing: same as call.id; incoming: engine-assigned). */
  engineId: string;
  /** DTMF to send once connected ("123,456" dial strings). */
  postDial: string;
}

export interface CallRegistryEvents {
  created(call: Call): void;
  updated(call: Call, previous: Call): void;
  ended(call: Call): void;
  cdr(cdr: Cdr): void;
  listChanged(calls: Call[]): void;
}

export interface NewCall {
  engineId?: string;
  direction: CallDirection;
  state: CallState;
  line: number;
  remoteNumber: string;
  remoteDisplayName?: string;
  sipCallId?: string;
  postDial?: string;
  /** Video call (V2-VID-01): set only for video calls so audio-only calls keep their shape. */
  hasVideo?: boolean;
  cameraOn?: boolean;
  /** Push correlation id (V2-PUSH-01). */
  pushId?: string;
  /** INVITE headers the host asked for (config `inviteHeaders`). */
  inviteHeaders?: Record<string, string>;
  /** Reload-safe calls (docs/resume.md): PBX anchor room id. */
  anchorId?: string;
  /** Restored after a reload: keep the original times (default: now / unset). */
  createdAt?: number;
  connectedAt?: number;
}

/**
 * Owns the set of live calls. Every mutation replaces the Call object (never
 * mutates it), emits `updated`, and republishes the line-ordered list.
 * Ended calls are removed from the list once `ended` + `cdr` are emitted.
 */
export class CallRegistry {
  private records = new Map<CallId, CallRecord>();
  private engineIndex = new Map<string, CallId>();
  private seq = 0;

  constructor(
    private readonly events: CallRegistryEvents,
    private readonly localNumber: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.records.size;
  }

  newId(): CallId {
    this.seq += 1;
    return `call-${this.now().toString(36)}-${this.seq}`;
  }

  /** Lowest free 1-based line, or undefined when all `maxLines` are busy. */
  freeLine(maxLines: number): number | undefined {
    const used = new Set([...this.records.values()].map((r) => r.call.line));
    for (let line = 1; line <= maxLines; line++) if (!used.has(line)) return line;
    return undefined;
  }

  get(id: CallId): CallRecord | undefined {
    return this.records.get(id);
  }

  byEngineId(engineId: string): CallRecord | undefined {
    const id = this.engineIndex.get(engineId);
    return id === undefined ? undefined : this.records.get(id);
  }

  all(): CallRecord[] {
    return [...this.records.values()].sort((a, b) => a.call.line - b.call.line);
  }

  create(init: NewCall, id: CallId = this.newId()): CallRecord {
    const call: Call = {
      id,
      line: init.line,
      sipCallId: init.sipCallId,
      direction: init.direction,
      state: init.state,
      remoteNumber: init.remoteNumber,
      remoteDisplayName: init.remoteDisplayName,
      muted: false,
      hold: 'none',
      createdAt: init.createdAt ?? this.now(),
      inConference: false,
      meta: {},
    };
    if (init.connectedAt !== undefined) call.connectedAt = init.connectedAt;
    if (init.anchorId) call.anchorId = init.anchorId;
    if (init.pushId) call.pushId = init.pushId;
    if (init.inviteHeaders) call.inviteHeaders = init.inviteHeaders;
    if (init.hasVideo) {
      call.hasVideo = true;
      call.cameraOn = Boolean(init.cameraOn);
      call.remoteVideo = false;
    }
    const record: CallRecord = { call, engineId: init.engineId ?? id, postDial: init.postDial ?? '' };
    this.records.set(id, record);
    this.engineIndex.set(record.engineId, id);
    this.events.created(call);
    this.publish();
    return record;
  }

  /** Replace fields on a call. Returns the new snapshot (or undefined if the call is gone). */
  patch(id: CallId, patch: Partial<Omit<Call, 'id'>>): Call | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const previous = record.call;
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
      (k) => !Object.is(previous[k], patch[k]),
    );
    if (!changed) return previous;
    const next: Call = { ...previous, ...patch };
    record.call = next;
    this.events.updated(next, previous);
    this.publish();
    return next;
  }

  /**
   * Mark a call disconnected, emit `updated`, `ended` and `cdr`, then drop it.
   * Idempotent: returns undefined if the call already ended.
   */
  finalize(id: CallId, reason: DisconnectReason, code?: number): Call | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.records.delete(id);
    this.engineIndex.delete(record.engineId);
    const previous = record.call;
    const ended: Call = {
      ...previous,
      state: 'disconnected',
      endedAt: this.now(),
      disconnectReason: reason,
      disconnectCode: code,
    };
    this.events.updated(ended, previous);
    this.events.ended(ended);
    this.events.cdr(this.toCdr(ended));
    this.publish();
    return ended;
  }

  /** Emit a CDR for a call that never got a line (auto-rejected while busy). */
  emitCdr(call: Call): void {
    this.events.cdr(this.toCdr(call));
  }

  toCdr(call: Call): Cdr {
    const me = this.localNumber();
    const endedAt = call.endedAt ?? this.now();
    return {
      callId: call.id,
      sipCallId: call.sipCallId,
      line: call.line,
      direction: call.direction,
      caller: call.direction === 'outgoing' ? me : call.remoteNumber,
      called: call.direction === 'outgoing' ? call.remoteNumber : me,
      remoteDisplayName: call.remoteDisplayName,
      startedAt: call.createdAt,
      connectedAt: call.connectedAt,
      endedAt,
      durationMs: call.connectedAt ? Math.max(0, endedAt - call.connectedAt) : 0,
      reason: call.disconnectReason ?? 'failed',
      code: call.disconnectCode,
    };
  }

  private publish(): void {
    this.events.listChanged(this.all().map((r) => r.call));
  }
}
