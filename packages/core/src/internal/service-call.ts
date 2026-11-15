import type { DisconnectReason, EngineListener, Logger, SoftphoneEngine } from '../types';

type Progress = Parameters<EngineListener['onCallProgress']>[1];

/** Outcome of a silent service call (feature code). */
export type ServiceCallResult =
  | { answered: true }
  | { answered: false; reason: DisconnectReason; code?: number; error?: unknown };

interface Pending {
  resolve: (result: ServiceCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PREFIX = 'svc-';

/**
 * Short-lived, invisible calls to PBX feature codes (e.g. *78 DND on). They
 * never enter the call registry: no line, no UI, no CDR, no plugins. The PBX
 * answering (200 OK) counts as success; we hang up straight away.
 */
export class ServiceCalls {
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly engine: SoftphoneEngine,
    private readonly logger: Logger,
  ) {}

  static isServiceCallId(engineCallId: string): boolean {
    return engineCallId.startsWith(PREFIX);
  }

  /** Consume engine progress for service calls. Returns true when the id was one of ours. */
  handleProgress(engineCallId: string, progress: Progress): boolean {
    if (!ServiceCalls.isServiceCallId(engineCallId)) return false;
    const entry = this.pending.get(engineCallId);
    if (!entry) return true;
    if (progress.type === 'connected') {
      this.settle(engineCallId, { answered: true });
      this.engine.hangup(engineCallId).catch((e: unknown) => this.logger.debug('Service call hangup failed', e));
    } else if (progress.type === 'ended') {
      this.settle(engineCallId, { answered: false, reason: progress.reason, code: progress.code });
    }
    return true;
  }

  /** Dial `target` silently. Never rejects: failures come back as `{ answered: false }`. */
  dial(target: string, timeoutMs: number, extraHeaders?: string[]): Promise<ServiceCallResult> {
    const id = `${PREFIX}${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<ServiceCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, { answered: false, reason: 'no-answer' });
        this.engine.hangup(id).catch(() => undefined);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.logger.debug(`Service call ${target}`);
      this.engine.call(id, target, extraHeaders?.length ? { extraHeaders } : undefined).catch((error: unknown) => {
        this.settle(id, { answered: false, reason: 'failed', error });
      });
    });
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { answered: false, reason: 'cancelled' });
  }

  private settle(id: string, result: ServiceCallResult): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
