/**
 * A bidirectional, ordered message channel between one remote client and its
 * host. Implementations: MessagePort (extension bridge), BroadcastChannel
 * (web leader tab), chrome.runtime ports (extension pages, in apps/extension)
 * and an in-memory loopback (the leader tab's own UI).
 */
import type { Unsubscribe } from '../types';

export interface RemoteTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): Unsubscribe;
  /** Fires once when the other side went away (port closed, leader gone). */
  onClose(listener: () => void): Unsubscribe;
  close(): void;
  /** True after close() or the remote end closed. */
  readonly closed: boolean;
}

/** Base class with listener bookkeeping. */
export abstract class BaseTransport implements RemoteTransport {
  private messageListeners = new Set<(message: unknown) => void>();
  private closeListeners = new Set<() => void>();
  closed = false;

  abstract send(message: unknown): void;
  protected abstract teardown(): void;

  /** Messages that arrived before anyone listened (flushed on the next microtask after the first listener). */
  private backlog: unknown[] = [];

  onMessage(listener: (message: unknown) => void): Unsubscribe {
    this.messageListeners.add(listener);
    if (this.backlog.length) {
      queueMicrotask(() => {
        const queued = this.backlog;
        this.backlog = [];
        for (const m of queued) this.deliver(m);
      });
    }
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): Unsubscribe {
    if (this.closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  protected deliver(message: unknown): void {
    if (this.closed) return;
    if (this.messageListeners.size === 0) {
      if (this.backlog.length < 100) this.backlog.push(message);
      return;
    }
    for (const l of [...this.messageListeners]) {
      try {
        l(message);
      } catch {
        /* a listener must not break the channel */
      }
    }
  }

  /** Mark closed and notify (remote end went away). */
  protected markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.closeListeners]) l();
    this.closeListeners.clear();
    this.messageListeners.clear();
  }

  close(): void {
    if (this.closed) return;
    this.teardown();
    this.markClosed();
  }
}

/** Wraps a MessagePort (the extension bridge). `host-bye` / `bye` messages count as close. */
export class MessagePortTransport extends BaseTransport {
  constructor(private readonly port: MessagePort) {
    super();
    port.onmessage = (e: MessageEvent) => {
      const data: unknown = e.data;
      this.deliver(data);
      if (isBye(data)) this.markClosed();
    };
    port.start?.();
  }
  send(message: unknown): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.markClosed();
    }
  }
  protected teardown(): void {
    this.port.onmessage = null;
    this.port.close();
  }
}

function isBye(data: unknown): boolean {
  return typeof data === 'object' && data !== null && ((data as { type?: unknown }).type === 'host-bye');
}

/** In-memory pair (same tab). Delivery is async (microtask) like a real channel; objects are not cloned. */
export function createLoopbackPair(): [RemoteTransport, RemoteTransport] {
  class Loop extends BaseTransport {
    peer: Loop | null = null;
    send(message: unknown): void {
      if (this.closed) return;
      const peer = this.peer;
      queueMicrotask(() => peer?.deliver(message));
    }
    protected teardown(): void {
      const peer = this.peer;
      queueMicrotask(() => peer?.markClosed());
    }
  }
  const a = new Loop();
  const b = new Loop();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
