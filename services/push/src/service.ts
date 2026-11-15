import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { ServiceConfig } from './config.ts';
import type { CallCancelledPush, IncomingCallPush, PushPayload } from './payload.ts';
import type { PushSender } from './sender.ts';
import type { SubscriptionRecord, SubscriptionStore } from './store.ts';
import { signCallAction, verifyCallAction } from './tokens.ts';

export type CallStatus = 'ringing' | 'declined' | 'cancelled';

export interface NotifyResult {
  sent: number;
  failed: number;
  pruned: number;
  subscriptions: number;
}

export interface ServiceEvent {
  at: number;
  type: 'subscribed' | 'unsubscribed' | 'notify' | 'cancel' | 'decline' | 'sent' | 'send-failed' | 'pruned';
  extension?: string;
  callId?: string;
  callerId?: string;
  status?: number;
  endpointHost?: string;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const EXTENSION_RE = /^[A-Za-z0-9_.+-]{1,64}$/;
const CALL_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function validExtension(ext: unknown): ext is string {
  return typeof ext === 'string' && EXTENSION_RE.test(ext);
}

export function validCallId(id: unknown): id is string {
  return typeof id === 'string' && CALL_ID_RE.test(id);
}

/** Caller id from the PBX is attacker-controlled: keep it short and printable. */
function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || undefined;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

/** Topic header value: max 32 chars of the URL-safe base64 alphabet. */
export function topicFor(callId: string): string {
  return createHash('sha256').update(callId).digest('base64url').slice(0, 22);
}

export interface PushServiceDeps {
  config: ServiceConfig;
  store: SubscriptionStore;
  sender: PushSender;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Business logic of the push service, independent of HTTP (unit-tested directly). */
export class PushService {
  private readonly calls = new Map<string, { extension: string; status: CallStatus; at: number }>();
  private readonly events: ServiceEvent[] = [];
  private readonly now: () => number;

  private readonly d: PushServiceDeps;

  constructor(d: PushServiceDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  get vapidPublicKey(): string {
    return this.d.config.vapidPublicKey;
  }

  recentEvents(): ServiceEvent[] {
    return [...this.events];
  }

  private record(event: Omit<ServiceEvent, 'at'>): void {
    this.events.push({ at: this.now(), ...event });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.d.log?.(event.type, { ...event });
  }

  // ------------------------------------------------------------ subscriptions

  validateSubscription(input: unknown): { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null } {
    const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; expirationTime?: unknown } | null;
    if (!sub || typeof sub !== 'object') throw new ValidationError('subscription is required');
    if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) throw new ValidationError('subscription.endpoint is invalid');
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      throw new ValidationError('subscription.endpoint is not a URL');
    }
    const cfg = this.d.config;
    if (!cfg.allowInsecureEndpoints) {
      if (url.protocol !== 'https:') throw new ValidationError('subscription.endpoint must use https');
      if (isPrivateHost(url.hostname)) throw new ValidationError('subscription.endpoint host is not allowed');
      const host = url.hostname.toLowerCase();
      if (cfg.endpointHosts.length && !cfg.endpointHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        throw new ValidationError(`subscription.endpoint host ${host} is not an allowed push service`);
      }
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ValidationError('subscription.endpoint must be http(s)');
    }
    const p256dh = sub.keys?.p256dh;
    const auth = sub.keys?.auth;
    if (typeof p256dh !== 'string' || !KEY_RE.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) {
      throw new ValidationError('subscription.keys.p256dh is invalid');
    }
    if (typeof auth !== 'string' || !KEY_RE.test(auth) || auth.length < 16 || auth.length > 32) {
      throw new ValidationError('subscription.keys.auth is invalid');
    }
    const expirationTime = typeof sub.expirationTime === 'number' ? sub.expirationTime : null;
    return { endpoint: sub.endpoint, keys: { p256dh, auth }, expirationTime };
  }

  async subscribe(extension: string, subscription: unknown, userAgent?: string): Promise<SubscriptionRecord> {
    if (!validExtension(extension)) throw new ValidationError('extension is invalid');
    const sub = this.validateSubscription(subscription);
    const now = this.now();
    const existing = (await this.d.store.all()).find((r) => r.endpoint === sub.endpoint);
    const record: SubscriptionRecord = {
      extension,
      ...sub,
      userAgent: cleanText(userAgent, 200),
      createdAt: existing?.extension === extension ? existing.createdAt : now,
      updatedAt: now,
      failures: 0,
    };
    await this.d.store.upsert(record);
    // Keep the newest N per extension.
    const mine = (await this.d.store.listByExtension(extension)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of mine.slice(this.d.config.maxPerExtension)) await this.d.store.remove(old.endpoint);
    this.record({ type: 'subscribed', extension, endpointHost: new URL(sub.endpoint).host });
    return record;
  }

  /** Remove one subscription (by endpoint) or, without an endpoint, all of the extension's. */
  async unsubscribe(extension: string, endpoint?: string): Promise<number> {
    if (!validExtension(extension)) throw new ValidationError('extension is invalid');
    const removed = endpoint
      ? await this.d.store.removeWhere((r) => r.endpoint === endpoint && r.extension === extension)
      : await this.d.store.removeWhere((r) => r.extension === extension);
    this.record({ type: 'unsubscribed', extension });
    return removed;
  }

  async list(extension: string): Promise<Array<{ endpointHost: string; createdAt: number; updatedAt: number; lastSuccessAt?: number }>> {
    return (await this.d.store.listByExtension(extension)).map((r) => ({
      endpointHost: new URL(r.endpoint).host,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.lastSuccessAt ? { lastSuccessAt: r.lastSuccessAt } : {}),
    }));
  }

  /**
   * Drop subscriptions that can no longer receive pushes: past their
   * `expirationTime`, or failing for `maxFailures` sends in a row. 404/410
   * answers delete a subscription immediately during sends.
   */
  async prune(maxFailures = 5): Promise<number> {
    const now = this.now();
    const n = await this.d.store.removeWhere(
      (r) => (typeof r.expirationTime === 'number' && r.expirationTime > 0 && r.expirationTime <= now) || (r.failures ?? 0) >= maxFailures,
    );
    if (n) this.record({ type: 'pruned', status: n });
    return n;
  }

  // ------------------------------------------------------------ calls

  async notifyIncoming(input: { extension: unknown; callId: unknown; callerId?: unknown; callerName?: unknown }): Promise<NotifyResult> {
    if (!validExtension(input.extension)) throw new ValidationError('extension is invalid');
    if (!validCallId(input.callId)) throw new ValidationError('callId is invalid');
    const { extension, callId } = input;
    const ttl = this.d.config.callTtl;
    const now = this.now();
    this.gcCalls();
    this.calls.set(callId, { extension, status: 'ringing', at: now });
    const callerId = cleanText(input.callerId, 64) ?? 'unknown';
    const callerName = cleanText(input.callerName, 80);
    const payload: IncomingCallPush = {
      v: 1,
      type: 'incoming-call',
      callId,
      extension,
      callerId,
      ...(callerName && callerName !== callerId ? { callerName } : {}),
      at: now,
      ttl,
    };
    if (this.d.config.tokenSecret) {
      const exp = Math.floor(now / 1000) + ttl + 30;
      const sig = signCallAction(this.d.config.tokenSecret, 'decline', callId, extension, exp);
      const url = this.d.config.publicUrl ? `${this.d.config.publicUrl}/calls/${encodeURIComponent(callId)}/decline` : undefined;
      payload.decline = { exp, sig, ...(url ? { url } : {}) };
    }
    this.record({ type: 'notify', extension, callId, callerId });
    return this.fanOut(extension, payload, { ttl, urgency: 'high', topic: topicFor(callId) });
  }

  async notifyCancel(input: { extension: unknown; callId: unknown; reason?: unknown }): Promise<NotifyResult> {
    if (!validExtension(input.extension)) throw new ValidationError('extension is invalid');
    if (!validCallId(input.callId)) throw new ValidationError('callId is invalid');
    const { extension, callId } = input;
    const call = this.calls.get(callId);
    if (call && call.status === 'ringing') call.status = 'cancelled';
    this.record({ type: 'cancel', extension, callId });
    const payload: CallCancelledPush = { v: 1, type: 'call-cancelled', callId, extension, ...(cleanText(input.reason, 32) ? { reason: cleanText(input.reason, 32) } : {}) };
    // Same topic: replaces the incoming-call message if it was not delivered yet.
    return this.fanOut(extension, payload, { ttl: this.d.config.callTtl, urgency: 'high', topic: topicFor(callId) });
  }

  /** The agent pressed Decline on the notification (signed per call, no agent token). */
  decline(callId: string, extension: string, exp: number, sig: string): boolean {
    if (!this.d.config.tokenSecret || !verifyCallAction(this.d.config.tokenSecret, 'decline', callId, extension, exp, sig, this.now())) {
      return false;
    }
    const call = this.calls.get(callId);
    if (call && call.extension === extension && call.status === 'ringing') call.status = 'declined';
    else if (!call) this.calls.set(callId, { extension, status: 'declined', at: this.now() });
    this.record({ type: 'decline', extension, callId });
    return true;
  }

  /** Polled by the dialplan while it waits for the agent to come online. */
  callStatus(callId: string): CallStatus | 'unknown' {
    return this.calls.get(callId)?.status ?? 'unknown';
  }

  private gcCalls(): void {
    const cutoff = this.now() - Math.max(300, this.d.config.callTtl * 4) * 1000;
    for (const [id, c] of this.calls) if (c.at < cutoff) this.calls.delete(id);
  }

  private async fanOut(extension: string, payload: PushPayload, options: { ttl: number; urgency: 'high'; topic: string }): Promise<NotifyResult> {
    const subs = await this.d.store.listByExtension(extension);
    const body = JSON.stringify(payload);
    const result: NotifyResult = { sent: 0, failed: 0, pruned: 0, subscriptions: subs.length };
    await Promise.all(
      subs.map(async (sub) => {
        const endpointHost = new URL(sub.endpoint).host;
        try {
          const res = await this.d.sender.send(sub, body, options);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            result.sent++;
            await this.d.store.update(sub.endpoint, { lastSuccessAt: this.now(), failures: 0 });
            this.record({ type: 'sent', extension, callId: payload.callId, status: res.statusCode, endpointHost });
          } else if (res.statusCode === 404 || res.statusCode === 410) {
            // Gone: the browser unsubscribed or the subscription expired.
            result.pruned++;
            await this.d.store.remove(sub.endpoint);
            this.record({ type: 'pruned', extension, callId: payload.callId, status: res.statusCode, endpointHost });
          } else {
            result.failed++;
            await this.d.store.update(sub.endpoint, { failures: (sub.failures ?? 0) + 1 });
            this.record({ type: 'send-failed', extension, callId: payload.callId, status: res.statusCode, endpointHost });
          }
        } catch {
          result.failed++;
          await this.d.store.update(sub.endpoint, { failures: (sub.failures ?? 0) + 1 });
          this.record({ type: 'send-failed', extension, callId: payload.callId, endpointHost });
        }
      }),
    );
    return result;
  }
}
