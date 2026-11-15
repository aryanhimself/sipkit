import { Subscriber, SubscriptionState, UserAgent, type Notification } from 'sip.js';
import type { Logger, MessageSummary } from '../../types';
import { parseMessageSummary } from '../../internal/message-summary';
import { buildTargetUri } from './helpers';

export const MWI_EVENT = 'message-summary';
const RETRY_MS = 30_000;
const DISPOSE_TIMEOUT_MS = 2_000;

export interface MwiHost {
  /** Current connected UserAgent (a new one after every failover/reconnect). */
  ua(): UserAgent | undefined;
  domain(): string;
  username(): string;
  expires(): number;
}

/** True if a NOTIFY carries the message-summary event package. */
export function isMessageSummaryNotify(notification: Notification): boolean {
  const event = notification.request.getHeader('Event') ?? '';
  return event.split(';')[0]?.trim().toLowerCase() === MWI_EVENT;
}

/**
 * RFC 3842 message-summary subscription on SIP.js `Subscriber`, plus parsing
 * of unsolicited (out-of-dialog) NOTIFYs. Terminated subscriptions the
 * caller still wants are retried every 30 s.
 */
export class MwiSubscription {
  private subscriber: Subscriber | undefined;
  private wanted: { target?: string } | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: MwiHost,
    private readonly logger: Logger,
    private readonly onSummary: (summary: MessageSummary) => void,
  ) {}

  async subscribe(target?: string): Promise<void> {
    this.wanted = { target };
    await this.disposeSubscriber();
    const ua = this.host.ua();
    if (!ua) throw new Error('Not connected to the SIP server');
    const uriText = buildTargetUri(target ?? this.host.username(), this.host.domain());
    const uri = UserAgent.makeURI(uriText);
    if (!uri) throw new Error(`Invalid MWI target "${uriText}"`);
    const subscriber = new Subscriber(ua, uri, MWI_EVENT, {
      expires: this.host.expires(),
      extraHeaders: ['Accept: application/simple-message-summary'],
    });
    subscriber.delegate = { onNotify: (n) => this.handleNotify(n) };
    subscriber.stateChange.addListener((state) => {
      if (state !== SubscriptionState.Terminated || this.subscriber !== subscriber) return;
      this.subscriber = undefined;
      if (this.wanted) {
        this.logger.info(`message-summary subscription ended; retrying in ${RETRY_MS / 1000}s`);
        this.scheduleRetry();
      }
    });
    this.subscriber = subscriber;
    this.logger.debug(`SUBSCRIBE message-summary ${uriText}`);
    await subscriber.subscribe();
  }

  async unsubscribe(): Promise<void> {
    this.wanted = undefined;
    this.clearRetry();
    await this.disposeSubscriber();
  }

  /** Handle a NOTIFY (in-dialog from the Subscriber, or unsolicited from the UserAgent). */
  handleNotify(notification: Notification): void {
    notification.accept().catch(() => undefined);
    const summary = parseMessageSummary(notification.request.body);
    if (summary) this.onSummary(summary);
    else this.logger.debug('Ignoring message-summary NOTIFY without a usable body');
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const wanted = this.wanted;
      if (!wanted || !this.host.ua()?.isConnected()) return;
      this.subscribe(wanted.target).catch((error: unknown) =>
        this.logger.warn('MWI re-subscribe failed', error),
      );
    }, RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Dispose (sends SUBSCRIBE Expires: 0 when subscribed) without hanging on a dead transport. */
  private async disposeSubscriber(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      subscriber
        .dispose()
        .catch((error: unknown) => this.logger.debug('MWI subscriber dispose failed', error)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
