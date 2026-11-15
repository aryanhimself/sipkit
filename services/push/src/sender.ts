import webpush from 'web-push';
import type { SubscriptionRecord } from './store.ts';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact for push services (RFC 8292 `sub` claim). */
  subject: string;
}

export interface SendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic (max 32 base64url chars). */
  topic?: string;
}

export interface SendResult {
  statusCode: number;
  body?: string;
}

/** Delivers one encrypted message to one subscription. Swap it out in tests. */
export interface PushSender {
  send(subscription: SubscriptionRecord, payload: string, options: SendOptions): Promise<SendResult>;
}

/**
 * Standard Web Push (RFC 8030 + RFC 8291 aes128gcm + RFC 8292 VAPID) through
 * the `web-push` library's request builder and Node's fetch. Works with every
 * browser push service (FCM for Chrome/Edge, Mozilla autopush, Apple web push)
 * without a vendor account: the VAPID key pair *is* the identity.
 */
export class WebPushSender implements PushSender {
  private readonly vapid: VapidConfig;
  private readonly timeoutMs: number;

  constructor(vapid: VapidConfig, timeoutMs = 10_000) {
    this.vapid = vapid;
    this.timeoutMs = timeoutMs;
  }

  async send(subscription: SubscriptionRecord, payload: string, options: SendOptions): Promise<SendResult> {
    const details = webpush.generateRequestDetails(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      payload,
      {
        TTL: options.ttl,
        urgency: options.urgency ?? 'normal',
        ...(options.topic ? { topic: options.topic } : {}),
        contentEncoding: 'aes128gcm',
        vapidDetails: this.vapid,
      },
    );
    const res = await fetch(details.endpoint, {
      method: details.method,
      headers: details.headers as Record<string, string>,
      body: details.body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = res.status >= 400 ? (await res.text().catch(() => '')).slice(0, 500) : undefined;
    return { statusCode: res.status, ...(body ? { body } : {}) };
  }
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
