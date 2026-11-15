import type { ResolvedConfig } from '../config';
import type {
  EnginePresenceUpdate,
  Logger,
  PresenceEventPackage,
  PresenceInfo,
  PresenceReport,
  RegistrationState,
  SoftphoneEngine,
} from '../types';
import { combinePresence, samePresence } from './presence-parse';

export interface PresenceChange {
  target: string;
  presence?: PresenceInfo;
  previous?: PresenceInfo;
}

export interface PresenceDeps {
  engine: SoftphoneEngine;
  config: () => ResolvedConfig;
  logger: Logger;
  get: () => Record<string, PresenceInfo>;
  /** Publish the new map (one snapshot update) and the per-target changes (`presence:changed`). */
  publish: (next: Record<string, PresenceInfo>, changes: PresenceChange[]) => void;
  now?: () => number;
}

/** SIP statuses that mean "this will not work soon": retry slowly. 489 Bad Event = never. */
const HARD_FAILURES = new Set([403, 404, 405, 488, 501, 603]);
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

interface Sub {
  target: string;
  event: PresenceEventPackage;
  /** queued: waiting for its throttle slot; sent: SUBSCRIBE sent / active; waiting: retry timer running. */
  status: 'queued' | 'sent' | 'waiting' | 'dead';
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

const key = (target: string, event: PresenceEventPackage) => `${event}\u0000${target}`;

/** Normalise user input: trim, drop empties and duplicates. */
export function normaliseTargets(targets: string | readonly string[]): string[] {
  const list = typeof targets === 'string' ? [targets] : [...targets];
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

/**
 * Presence / BLF subscriptions (V2-PRES-01, V2-BLF-01). Keeps the watch list,
 * SUBSCRIBEs (throttled) to each target × event package while registered,
 * re-subscribes after re-registration, backs off on failures and folds
 * NOTIFYs into one normalised {@link PresenceInfo} per target.
 */
export class PresenceController {
  private readonly targets = new Set<string>();
  /** Targets that came from `config.presence.watch` (so a config change can drop them). */
  private configured = new Set<string>();
  private readonly runtime = new Set<string>();
  private readonly subs = new Map<string, Sub>();
  private readonly reports = new Map<string, Partial<Record<PresenceEventPackage, PresenceReport>>>();
  private readonly errors = new Map<string, number>();
  private queue: string[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt = 0;
  private registered = false;
  private warnedUnsupported = false;
  private disposed = false;

  constructor(private readonly d: PresenceDeps) {
    this.reconcile();
  }

  private get cfg(): ResolvedConfig['presence'] {
    return this.d.config().presence;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Feed every registration state change. */
  onRegistration(state: RegistrationState): void {
    const was = this.registered;
    this.registered = state === 'registered';
    if (this.registered && !was) {
      for (const target of this.targets) this.ensureSubs(target);
      this.pump();
    } else if (!this.registered && was) {
      this.dropAllSubs();
      this.reports.clear();
      this.errors.clear();
      this.refresh([...this.targets]);
    }
  }

  /** Re-evaluate after a config change (enabled flag, watch list, event packages). */
  reconcile(): void {
    if (this.disposed) return;
    if (!this.cfg.enabled) {
      this.configured = new Set();
      this.runtime.clear();
      this.remove([...this.targets]);
      return;
    }
    const nextConfigured = new Set(normaliseTargets(this.cfg.watch));
    const dropped = [...this.configured].filter((t) => !nextConfigured.has(t) && !this.runtime.has(t));
    this.configured = nextConfigured;
    this.remove(dropped);
    // Event packages may have changed: drop subscriptions for packages no longer wanted.
    for (const sub of [...this.subs.values()]) {
      if (!this.cfg.events.includes(sub.event)) this.dropSub(sub);
    }
    this.add([...nextConfigured]);
    if (this.registered) for (const target of this.targets) this.ensureSubs(target);
    this.pump();
  }

  watch(targets: string | readonly string[]): void {
    const list = normaliseTargets(targets);
    for (const t of list) this.runtime.add(t);
    this.add(list);
    this.pump();
  }

  unwatch(targets: string | readonly string[]): void {
    const list = normaliseTargets(targets).filter((t) => this.targets.has(t));
    for (const t of list) {
      this.runtime.delete(t);
      this.configured.delete(t);
    }
    this.remove(list);
  }

  handleUpdate(update: EnginePresenceUpdate): void {
    if (this.disposed) return;
    const sub = this.subs.get(key(update.target, update.event));
    if (!sub || !this.targets.has(update.target)) {
      this.d.logger.debug(`Ignoring ${update.event} update for unwatched ${update.target}`);
      return;
    }
    const reports = this.reports.get(update.target) ?? {};
    if (update.report) {
      sub.failures = 0;
      reports[update.event] = update.report;
      this.errors.delete(update.target);
    }
    if (update.terminated) {
      delete reports[update.event];
      if (update.code && update.code >= 300) this.errors.set(update.target, update.code);
      this.scheduleRetry(sub, update.code);
    }
    this.reports.set(update.target, reports);
    this.refresh([update.target]);
  }

  dispose(): void {
    this.dropAllSubs();
    this.disposed = true;
  }

  // ------------------------------------------------------------------ internals

  private add(list: string[]): void {
    const changes: PresenceChange[] = [];
    const next = { ...this.d.get() };
    for (const target of list) {
      if (this.targets.has(target)) continue;
      if (this.targets.size >= this.cfg.maxWatched) {
        this.d.logger.warn(`presence.maxWatched (${this.cfg.maxWatched}) reached; not watching ${target}`);
        continue;
      }
      this.targets.add(target);
      const info: PresenceInfo = { target, state: 'unknown', updatedAt: this.now() };
      next[target] = info;
      changes.push({ target, presence: info });
      if (this.registered) this.ensureSubs(target);
    }
    if (changes.length) this.d.publish(next, changes);
  }

  private remove(list: string[]): void {
    const changes: PresenceChange[] = [];
    const next = { ...this.d.get() };
    for (const target of list) {
      if (!this.targets.delete(target)) continue;
      for (const sub of [...this.subs.values()]) if (sub.target === target) this.dropSub(sub);
      this.reports.delete(target);
      this.errors.delete(target);
      const previous = next[target];
      delete next[target];
      changes.push({ target, previous });
    }
    if (changes.length) this.d.publish(next, changes);
  }

  /** Recompute the combined state of targets and publish the ones that changed. */
  private refresh(list: string[]): void {
    const current = this.d.get();
    const next = { ...current };
    const changes: PresenceChange[] = [];
    for (const target of list) {
      if (!this.targets.has(target)) continue;
      const r = this.reports.get(target);
      const combined = combinePresence(r?.dialog, r?.presence);
      const info: PresenceInfo = { ...combined, target, updatedAt: this.now() };
      const code = this.errors.get(target);
      if (code !== undefined && combined.state === 'unknown') info.errorCode = code;
      const previous = current[target];
      if (samePresence(previous, info)) continue;
      next[target] = info;
      changes.push({ target, presence: info, previous });
    }
    if (changes.length) this.d.publish(next, changes);
  }

  private ensureSubs(target: string): void {
    for (const event of this.cfg.events) {
      const k = key(target, event);
      if (this.subs.has(k)) continue;
      this.subs.set(k, { target, event, status: 'queued', failures: 0 });
      this.queue.push(k);
    }
  }

  /** Send queued SUBSCRIBEs, at most one per `subscribeIntervalMs`. */
  private pump(): void {
    if (this.pumpTimer || !this.registered || this.disposed) return;
    const engine = this.d.engine;
    if (!engine.subscribePresence) {
      if (this.queue.length && !this.warnedUnsupported) {
        this.d.logger.info(`Engine "${engine.name}" has no presence subscription support`);
        this.warnedUnsupported = true;
      }
      return;
    }
    const interval = this.cfg.subscribeIntervalMs;
    while (this.queue.length) {
      const wait = this.lastSentAt + interval - this.now();
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, wait);
        return;
      }
      const k = this.queue.shift()!;
      const sub = this.subs.get(k);
      if (!sub || sub.status !== 'queued') continue;
      sub.status = 'sent';
      this.lastSentAt = this.now();
      engine.subscribePresence(sub.target, sub.event, this.cfg.expires).catch((error: unknown) => {
        this.d.logger.warn(`${sub.event} SUBSCRIBE for ${sub.target} failed`, error);
        if (this.subs.get(k) === sub) this.handleUpdate({ target: sub.target, event: sub.event, terminated: true });
      });
    }
  }

  private scheduleRetry(sub: Sub, code?: number): void {
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = undefined;
    if (code === 489) {
      // Bad Event: the server does not support this package. Don't hammer it.
      sub.status = 'dead';
      this.d.logger.warn(`Server does not support the "${sub.event}" event package (489); not retrying ${sub.target}`);
      return;
    }
    sub.failures += 1;
    const delay = code && HARD_FAILURES.has(code)
      ? RETRY_MAX_MS
      : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(sub.failures - 1, 8));
    sub.status = 'waiting';
    this.d.logger.info(
      `${sub.event} subscription for ${sub.target} ended${code ? ` (${code})` : ''}; retrying in ${Math.round(delay / 1000)}s`,
    );
    sub.timer = setTimeout(() => {
      sub.timer = undefined;
      const k = key(sub.target, sub.event);
      if (this.subs.get(k) !== sub || !this.registered) return;
      sub.status = 'queued';
      this.queue.push(k);
      this.pump();
    }, delay);
  }

  private dropSub(sub: Sub): void {
    const k = key(sub.target, sub.event);
    if (this.subs.get(k) !== sub) return;
    this.subs.delete(k);
    if (sub.timer) clearTimeout(sub.timer);
    this.queue = this.queue.filter((q) => q !== k);
    const reports = this.reports.get(sub.target);
    if (reports) delete reports[sub.event];
    if (sub.status === 'sent') {
      this.d.engine
        .unsubscribePresence?.(sub.target, sub.event)
        .catch((error: unknown) => this.d.logger.debug('presence unsubscribe failed', error));
    }
  }

  private dropAllSubs(): void {
    for (const sub of [...this.subs.values()]) this.dropSub(sub);
    this.queue = [];
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
  }
}
