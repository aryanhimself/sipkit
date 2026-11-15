/**
 * OS notifications for incoming calls (Answer / Decline) and missed calls
 * (V2-DESK-03). Platform specifics live in notification-spec.ts.
 */
import { Notification } from 'electron';
import type { IncomingCallInfo, MissedCallInfo } from '../shared/ipc';
import { incomingCallNotification, missedCallNotification, type NotificationStrings } from './notification-spec';

export interface NotificationEvents {
  answer(callId: string): void;
  decline(callId: string): void;
  show(): void;
}

/** What was shown, for the e2e hook (SIPKIT_DESKTOP_TEST). */
export interface NotificationRecord {
  kind: 'incoming' | 'missed';
  callId: string;
  title: string;
  body: string;
}

export class NotificationCenter {
  private readonly incoming = new Map<string, { n: Notification; programmatic: boolean }>();
  readonly log: NotificationRecord[] = [];

  constructor(
    private readonly platform: string,
    private readonly strings: () => NotificationStrings,
    private readonly events: NotificationEvents,
    /** false in e2e: record only, do not pop real notifications. */
    private readonly display = true,
  ) {}

  private get supported(): boolean {
    return this.display && Notification.isSupported();
  }

  showIncoming(call: IncomingCallInfo): void {
    const spec = incomingCallNotification(this.platform, call, this.strings());
    this.log.push({ kind: 'incoming', callId: call.callId, title: spec.options.title ?? '', body: spec.options.body ?? '' });
    if (!this.supported) return;
    this.dismissIncoming(call.callId);
    const n = new Notification(spec.options);
    const entry = { n, programmatic: false };
    n.on('click', () => this.events.show());
    n.on('action', (_e, index) => {
      if (index === spec.answerActionIndex) this.events.answer(call.callId);
    });
    n.on('close', () => {
      // Our own close() (call answered elsewhere / ended) is not a "Decline".
      if (spec.closeMeansDecline && !entry.programmatic) this.events.decline(call.callId);
      if (this.incoming.get(call.callId) === entry) this.incoming.delete(call.callId);
    });
    this.incoming.set(call.callId, entry);
    n.show();
  }

  dismissIncoming(callId: string): void {
    const entry = this.incoming.get(callId);
    if (!entry) return;
    this.incoming.delete(callId);
    entry.programmatic = true;
    entry.n.close();
  }

  showMissed(call: MissedCallInfo): void {
    const options = missedCallNotification(call, this.strings());
    this.log.push({ kind: 'missed', callId: call.callId, title: options.title ?? '', body: options.body ?? '' });
    if (!this.supported) return;
    const n = new Notification(options);
    n.on('click', () => this.events.show());
    n.show();
  }

  dismissAll(): void {
    for (const id of [...this.incoming.keys()]) this.dismissIncoming(id);
  }
}
