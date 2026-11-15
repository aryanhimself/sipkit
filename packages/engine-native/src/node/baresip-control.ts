/**
 * Client for baresip's ctrl_tcp module: netstring-framed JSON over TCP.
 *
 *   -> {"command":"dial","params":"sip:2002@pbx","token":"7"}
 *   <- {"response":true,"ok":true,"data":"call id: abc\n","token":"7"}
 *   <- {"event":true,"class":"call","type":"CALL_RINGING","id":"abc","peeruri":"sip:2002@pbx",...}
 *
 * Commands are serialized (one in flight at a time) because many baresip
 * commands act on the "current call"; `exclusive()` lets callers run a short
 * sequence (callfind + command) without interleaving.
 */
import { connect, type Socket } from 'node:net';
import { encodeNetstring, NetstringDecoder } from './netstring';

export interface BaresipEvent {
  event: true;
  class: string;
  type: string;
  accountaor?: string;
  direction?: 'incoming' | 'outgoing';
  peeruri?: string;
  peerdisplayname?: string;
  id?: string;
  param?: string;
  [key: string]: unknown;
}

export interface BaresipResponse {
  ok: boolean;
  data: string;
}

interface Pending {
  resolve(response: BaresipResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class BaresipControl {
  private socket: Socket | undefined;
  private decoder = new NetstringDecoder();
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly eventHandlers = new Set<(event: BaresipEvent) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly commandTimeoutMs = 10_000,
  ) {}

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  /** Connect, retrying until `timeoutMs` (baresip may still be starting). */
  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        this.socket = await this.open();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(
      `Cannot reach baresip ctrl_tcp at ${this.host}:${this.port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  onEvent(handler: (event: BaresipEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Run one command (queued behind any running exclusive section / command). */
  command(command: string, params = ''): Promise<BaresipResponse> {
    return this.exclusive(() => this.raw(command, params));
  }

  /** Run `fn` with the command queue to itself. Inside, use the `run` argument. */
  exclusive<T>(
    fn: (run: (command: string, params?: string) => Promise<BaresipResponse>) => Promise<T>,
  ): Promise<T> {
    const result = this.chain.then(() => fn((c, p = '') => this.raw(c, p)));
    this.chain = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private raw(command: string, params: string): Promise<BaresipResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error('baresip ctrl_tcp not connected'));
    const token = `sipkit${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`baresip did not answer "${command}" within ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      socket.write(encodeNetstring(JSON.stringify({ command, params, token })));
    });
  }

  private open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.port, this.host);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        this.decoder = new NetstringDecoder();
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', () => undefined);
        socket.on('close', () => this.onSocketClose(socket));
        resolve(socket);
      });
    });
  }

  private onData(chunk: Buffer): void {
    let payloads: string[];
    try {
      payloads = this.decoder.push(chunk);
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : undefined);
      return;
    }
    for (const payload of payloads) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.event === true) {
        for (const handler of [...this.eventHandlers]) handler(message as BaresipEvent);
      } else if (message.response === true && typeof message.token === 'string') {
        const pending = this.pending.get(message.token);
        if (!pending) continue;
        this.pending.delete(message.token);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: message.ok === true,
          data: typeof message.data === 'string' ? message.data : '',
        });
      }
    }
  }

  private onSocketClose(socket: Socket): void {
    if (this.socket === socket) this.socket = undefined;
    for (const [token, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('baresip ctrl_tcp connection closed'));
      this.pending.delete(token);
    }
    for (const handler of [...this.closeHandlers]) handler('baresip ctrl_tcp connection closed');
  }
}
