import { Subscriber, SubscriptionState, UserAgent, type Notification } from 'sip.js';
import type { EnginePresenceUpdate, Logger, PresenceEventPackage } from '../../types';
import { parseDialogInfo, parsePidf } from '../../internal/presence-parse';
import { buildTargetUri } from './helpers';

const DISPOSE_TIMEOUT_MS = 2_000;

const ACCEPT: Record<PresenceEventPackage, string> = {
  dialog: 'Accept: application/dialog-info+xml',
  presence: 'Accept: application/pidf+xml',
};

export interface PresenceHost {
  /** Current connected UserAgent (a new one after every failover/reconnect). */
  ua(): UserAgent | undefined;
  domain(): string;
}

interface Entry {
  subscriber: Subscriber;
  /** Status of a rejected initial SUBSCRIBE (captured from SIP.js internals; best effort). */
  failCode?: number;
}

type SubscribeResult = { failure?: { response?: { message?: { statusCode?: number } } } };

/**
 * One SIP.js `Subscriber` per (target, event package): `dialog` (RFC 4235,
 * BLF) and `presence` (PIDF). SIP.js refreshes active subscriptions before
 * they expire; termination (rejected, timed out, ended by the server) is
 * reported so the orchestrator can back off and retry.
 */
export class PresenceSubscriptions {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly host: PresenceHost,
    private readonly logger: Logger,
    private readonly onUpdate: (update: EnginePresenceUpdate) => void,
  ) {}

  async subscribe(target: string, event: PresenceEventPackage, expires: number): Promise<void> {
    const k = `${event}\u0000${target}`;
    await this.dispose(k);
    const ua = this.host.ua();
    if (!ua) throw new Error('Not connected to the SIP server');
    const uriText = buildTargetUri(target, this.host.domain());
    const uri = UserAgent.makeURI(uriText);
    if (!uri) throw new Error(`Invalid presence target "${uriText}"`);
    const subscriber = new Subscriber(ua, uri, event, { expires, extraHeaders: [ACCEPT[event]] });
    const entry: Entry = { subscriber };
    this.tapFailure(subscriber, entry);
    subscriber.delegate = { onNotify: (n) => this.handleNotify(target, event, n) };
    subscriber.stateChange.addListener((state) => {
      if (state !== SubscriptionState.Terminated || this.entries.get(k) !== entry) return;
      this.entries.delete(k);
      this.onUpdate({ target, event, terminated: true, code: entry.failCode });
    });
    this.entries.set(k, entry);
    this.logger.debug(`SUBSCRIBE ${event} ${uriText}`);
    await subscriber.subscribe();
  }

  async unsubscribe(target: string, event: PresenceEventPackage): Promise<void> {
    await this.dispose(`${event}\u0000${target}`);
  }

  async unsubscribeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.dispose(k)));
  }

  handleNotify(target: string, event: PresenceEventPackage, notification: Notification): void {
    notification.accept().catch(() => undefined);
    const body = notification.request.body;
    const report = event === 'dialog' ? parseDialogInfo(body) : parsePidf(body);
    if (report) this.onUpdate({ target, event, report });
    else if (body?.trim()) this.logger.debug(`Ignoring unparsable ${event} NOTIFY for ${target}`);
  }

  /**
   * SIP.js's public Subscriber API does not expose why an initial SUBSCRIBE
   * failed. Peek at the response through the internal request so 403/404/489
   * can be told apart from transient failures. Harmless if the internals change.
   */
  private tapFailure(subscriber: Subscriber, entry: Entry): void {
    const req = (subscriber as unknown as { subscriberRequest?: { subscribe?: () => Promise<SubscribeResult> } })
      .subscriberRequest;
    const original = req?.subscribe;
    if (!req || typeof original !== 'function') return;
    req.subscribe = () =>
      original.call(req).then((result) => {
        const code = result?.failure?.response?.message?.statusCode;
        if (typeof code === 'number') entry.failCode = code;
        return result;
      });
  }

  /** Dispose (sends SUBSCRIBE Expires: 0 when subscribed) without hanging on a dead transport. */
  private async dispose(k: string): Promise<void> {
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      entry.subscriber
        .dispose()
        .catch((error: unknown) => this.logger.debug('presence subscriber dispose failed', error)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
