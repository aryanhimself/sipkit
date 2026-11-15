import {
  NativeSipError,
  type NativeCommand,
  type NativeEvent,
  type NativeEventMessage,
  type NativeMessage,
} from './protocol';
import type { NativeSipTransport, Unsubscribe } from './transport';

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Request/response correlation and event fan-out over a transport (engine side).
 */
export class NativeSipClient {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Set<(event: NativeEvent) => void>();
  private readonly closeHandlers = new Set<(reason?: string) => void>();
  private readonly offs: Unsubscribe[];
  private closed = false;

  constructor(
    private readonly transport: NativeSipTransport,
    private readonly timeoutMs = 15_000,
  ) {
    this.offs = [
      transport.onMessage((message) => this.onMessage(message)),
      transport.onClose((reason) => this.onTransportClose(reason)),
    ];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a command; resolves with its result, rejects with NativeSipError. */
  request(command: NativeCommand, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new NativeSipError('transport', 'Native SIP sidecar is not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new NativeSipError(
            'timeout',
            `Native SIP sidecar did not answer "${command.cmd}" within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ type: 'request', id, ...command });
    });
  }

  onEvent(handler: (event: NativeEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Detach from the transport (and close it). Pending requests fail. */
  close(): void {
    if (this.closed) return;
    this.transport.close();
    this.onTransportClose('closed');
  }

  private onMessage(message: NativeMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(new NativeSipError(message.error.code ?? 'failed', message.error.message));
      return;
    }
    if (message.type === 'event') {
      const { type: _type, ...event } = message as NativeEventMessage;
      for (const handler of [...this.eventHandlers]) handler(event as NativeEvent);
    }
  }

  private onTransportClose(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new NativeSipError(
          'transport',
          `Native SIP sidecar disconnected${reason ? ` (${reason})` : ''}`,
        ),
      );
      this.pending.delete(id);
    }
    for (const handler of [...this.closeHandlers]) handler(reason);
    this.closeHandlers.clear();
    this.eventHandlers.clear();
  }
}
