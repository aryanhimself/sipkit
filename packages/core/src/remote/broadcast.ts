/**
 * BroadcastChannel transports for the web leader-tab host
 * (docs/shared-instance.md). All tabs of one origin share one channel;
 * frames are addressed by tab id so each client has a private stream.
 */
import { BaseTransport } from './transport';

export const WEB_FRAME_TAG = 'sipkit/web';

/** One BroadcastChannel frame. */
export interface WebFrame {
  t: typeof WEB_FRAME_TAG;
  from: string;
  /** A tab id, 'leader' (whoever leads) or '*' (everyone). */
  to: string;
  kind: 'data' | 'leader' | 'ping' | 'leave' | 'handover';
  data?: unknown;
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  close(): void;
}

export function isWebFrame(v: unknown): v is WebFrame {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.t === WEB_FRAME_TAG &&
    typeof f.from === 'string' &&
    typeof f.to === 'string' &&
    (f.kind === 'data' || f.kind === 'leader' || f.kind === 'ping' || f.kind === 'leave' || f.kind === 'handover')
  );
}

export function webFrame(from: string, to: string, kind: WebFrame['kind'], data?: unknown): WebFrame {
  return { t: WEB_FRAME_TAG, from, to, kind, data };
}

/**
 * Client end: talks to whoever leads. Closes when the leader leaves, a new
 * leader announces itself, or no ping arrives for `staleMs`.
 */
export class BroadcastClientTransport extends BaseTransport {
  private leaderId: string | null = null;
  private watchdog: ReturnType<typeof setInterval>;
  private lastSeen = Date.now();
  private readonly onFrame = (e: MessageEvent) => {
    const f: unknown = e.data;
    if (!isWebFrame(f) || f.from === this.clientId) return;
    if (f.kind === 'leader') {
      if (this.leaderId && f.from !== this.leaderId) this.markClosedAndDetach();
      return;
    }
    if (f.kind === 'leave') {
      if (f.from === this.leaderId) this.markClosedAndDetach();
      return;
    }
    if (f.kind === 'ping') {
      if (f.from === this.leaderId) this.lastSeen = Date.now();
      return;
    }
    if (f.kind !== 'data' || f.to !== this.clientId) return;
    if (this.leaderId && f.from !== this.leaderId) return;
    this.leaderId = f.from;
    this.lastSeen = Date.now();
    this.deliver(f.data);
  };

  constructor(
    private readonly channel: ChannelLike,
    private readonly clientId: string,
    staleMs = 6_000,
  ) {
    super();
    channel.addEventListener('message', this.onFrame);
    this.watchdog = setInterval(() => {
      if (this.leaderId && Date.now() - this.lastSeen > staleMs) this.markClosedAndDetach();
    }, Math.max(250, staleMs / 3));
  }

  /** Id of the leader tab once it answered. */
  get leader(): string | null {
    return this.leaderId;
  }

  send(message: unknown): void {
    if (this.closed) return;
    this.channel.postMessage(webFrame(this.clientId, this.leaderId ?? 'leader', 'data', message));
  }

  private markClosedAndDetach(): void {
    this.detach();
    this.markClosed();
  }

  private detach(): void {
    clearInterval(this.watchdog);
    this.channel.removeEventListener('message', this.onFrame);
  }

  protected teardown(): void {
    this.detach();
  }
}

/** Leader end of one client's stream (created by the leader hub per client id). */
export class BroadcastLeaderTransport extends BaseTransport {
  constructor(
    private readonly channel: ChannelLike,
    private readonly leaderId: string,
    readonly clientId: string,
    private readonly onTeardown: () => void,
  ) {
    super();
  }
  send(message: unknown): void {
    if (this.closed) return;
    this.channel.postMessage(webFrame(this.leaderId, this.clientId, 'data', message));
  }
  /** Called by the hub with frames from this client. */
  push(message: unknown): void {
    this.deliver(message);
  }
  /** The client tab went away. */
  remoteClosed(): void {
    this.markClosed();
  }
  protected teardown(): void {
    this.onTeardown();
  }
}
