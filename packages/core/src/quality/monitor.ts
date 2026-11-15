import type { ResolvedConfig } from '../config';
import type { CallRegistry } from '../internal/call-registry';
import type { TimerRegistry } from '../internal/timers';
import type { Call, CallId, Cdr, Logger, SoftphoneEngine, SoftphoneEvents } from '../types';
import { QualitySummaryBuilder, QualityTracker } from './quality';

export interface QualityMonitorDeps {
  engine: SoftphoneEngine;
  calls: CallRegistry;
  timers: TimerRegistry;
  logger: Logger;
  config: () => ResolvedConfig;
  emit: (payload: SoftphoneEvents['call:quality']) => void;
}

interface Session {
  tracker: QualityTracker;
  summary: QualitySummaryBuilder;
  active: boolean;
  /** Bumped on every (de)activation so in-flight samples from an older phase are dropped. */
  gen: number;
}

/** Sampling runs only while media should flow both ways. */
const shouldSample = (call: Call) => call.state === 'connected' && call.hold === 'none';

const timerKey = (id: CallId) => `quality:${id}`;

/**
 * Samples engine RTP stats every `callQualityInterval` seconds for each
 * connected call, publishes `call.quality` + `call:quality`, and keeps a
 * per-call summary that is attached to the CDR. Paused while on hold; the
 * first sample after resuming only re-baselines the counters.
 */
export class QualityMonitor {
  private sessions = new Map<CallId, Session>();

  constructor(private readonly d: QualityMonitorDeps) {}

  private get enabled(): boolean {
    return typeof this.d.engine.getCallStats === 'function' && this.d.config().callQualityInterval > 0;
  }

  /** Feed every call create/update. Idempotent: acts only on sampling transitions. */
  onCall(call: Call): void {
    let session = this.sessions.get(call.id);
    const want = shouldSample(call) && this.enabled;
    if (call.state === 'disconnected') {
      this.d.timers.clear(timerKey(call.id));
      if (session) {
        session.active = false;
        session.gen += 1;
      }
      return;
    }
    if (!want) {
      if (session?.active) {
        session.active = false;
        session.gen += 1;
        this.d.timers.clear(timerKey(call.id));
      }
      return;
    }
    if (session?.active) return;
    const resumed = session !== undefined;
    if (!session) {
      session = { tracker: new QualityTracker(), summary: new QualitySummaryBuilder(), active: false, gen: 0 };
      this.sessions.set(call.id, session);
    }
    session.active = true;
    session.gen += 1;
    if (resumed) void this.sample(call.id, session, session.gen, true);
    else this.schedule(call.id, session);
  }

  /** Attach (and forget) the call's quality summary. */
  withSummary(cdr: Cdr): Cdr {
    const session = this.sessions.get(cdr.callId);
    if (!session) return cdr;
    this.sessions.delete(cdr.callId);
    this.d.timers.clear(timerKey(cdr.callId));
    const quality = session.summary.build();
    return quality ? { ...cdr, quality } : cdr;
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.d.timers.clear(timerKey(id));
    this.sessions.clear();
  }

  private schedule(id: CallId, session: Session): void {
    const seconds = this.d.config().callQualityInterval;
    if (!(seconds > 0)) return;
    const gen = session.gen;
    this.d.timers.set(timerKey(id), seconds * 1000, () => void this.sample(id, session, gen, false));
  }

  private async sample(id: CallId, session: Session, gen: number, prime: boolean): Promise<void> {
    const current = () => this.sessions.get(id) === session && session.active && session.gen === gen;
    const record = this.d.calls.get(id);
    const getStats = this.d.engine.getCallStats?.bind(this.d.engine);
    if (!record || !getStats || !current()) return;
    let stats;
    try {
      stats = await getStats(record.engineId);
    } catch (error) {
      this.d.logger.debug('getCallStats failed', error);
    }
    if (!current()) return;
    if (stats) {
      if (prime) {
        session.tracker.prime(stats);
      } else {
        const quality = session.tracker.push(stats);
        session.summary.add(quality);
        this.d.calls.patch(id, { quality });
        this.d.emit({ callId: id, quality });
      }
    }
    this.schedule(id, session);
  }
}
