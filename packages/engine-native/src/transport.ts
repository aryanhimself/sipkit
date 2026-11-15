/**
 * Host-agnostic transports between the engine and a sidecar. The engine only
 * needs `NativeSipTransport`; how messages travel is up to the host:
 *
 * - tests / same process: `createMemoryTransportPair()`
 * - Electron renderer: `createBridgeTransport(window.sipkitNativeSip)` over a preload IPC bridge
 * - Node: JSON lines over stdio or TCP (`sipkit-engine-native/node`)
 */
import { asNativeMessage, type NativeMessage } from './protocol';

export type Unsubscribe = () => void;

export interface NativeSipTransport {
  /** Deliver a message to the other side. Must not throw once closed (drop instead). */
  send(message: NativeMessage): void;
  /** Subscribe to messages from the other side. */
  onMessage(handler: (message: NativeMessage) => void): Unsubscribe;
  /** Subscribe to the link going away (process exit, socket closed, bridge torn down). */
  onClose(handler: (reason?: string) => void): Unsubscribe;
  /** Close the link (idempotent). */
  close(): void;
}

/** Small helper to implement transports: handler sets plus close bookkeeping. */
export class TransportBase {
  protected readonly messageHandlers = new Set<(message: NativeMessage) => void>();
  protected readonly closeHandlers = new Set<(reason?: string) => void>();
  protected closed = false;

  onMessage(handler: (message: NativeMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Validate and dispatch an incoming value; invalid messages are dropped. */
  protected receive(value: unknown): void {
    const message = asNativeMessage(value);
    if (!message) return;
    for (const handler of [...this.messageHandlers]) handler(message);
  }

  protected markClosed(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler(reason);
    this.messageHandlers.clear();
    this.closeHandlers.clear();
  }
}

class MemoryEnd extends TransportBase implements NativeSipTransport {
  peer!: MemoryEnd;

  send(message: NativeMessage): void {
    if (this.closed) return;
    // Clone like a real IPC hop would, and deliver asynchronously.
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    queueMicrotask(() => {
      if (!this.peer.closed) this.peer.receive(copy);
    });
  }

  close(): void {
    if (this.closed) return;
    this.markClosed('closed');
    queueMicrotask(() => this.peer.markClosed('peer closed'));
  }
}

/** Two connected in-memory transport ends: `[engineSide, sidecarSide]`. */
export function createMemoryTransportPair(): [NativeSipTransport, NativeSipTransport] {
  const a = new MemoryEnd();
  const b = new MemoryEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * What an Electron preload (contextBridge) or Tauri shim exposes to the
 * renderer. Messages are structured-cloned plain objects.
 *
 *   // preload.ts
 *   contextBridge.exposeInMainWorld('sipkitNativeSip', {
 *     send: (m) => ipcRenderer.send('sipkit-native-sip', m),
 *     onMessage: (cb) => { const l = (_e, m) => cb(m); ipcRenderer.on('sipkit-native-sip', l); return () => ipcRenderer.off('sipkit-native-sip', l); },
 *     onClose: (cb) => { ... },
 *   });
 */
export interface NativeSipBridge {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  onClose?(handler: (reason?: string) => void): Unsubscribe;
  close?(): void;
}

class BridgeTransport extends TransportBase implements NativeSipTransport {
  private readonly offs: Unsubscribe[] = [];

  constructor(private readonly bridge: NativeSipBridge) {
    super();
    this.offs.push(bridge.onMessage((value) => this.receive(value)));
    if (bridge.onClose) this.offs.push(bridge.onClose((reason) => this.shutdown(reason)));
  }

  send(message: NativeMessage): void {
    if (!this.closed) this.bridge.send(message);
  }

  close(): void {
    if (this.closed) return;
    this.bridge.close?.();
    this.shutdown('closed');
  }

  private shutdown(reason?: string): void {
    for (const off of this.offs.splice(0)) off();
    this.markClosed(reason);
  }
}

/** Wrap a preload/IPC bridge as a transport (validates every incoming message). */
export function createBridgeTransport(bridge: NativeSipBridge): NativeSipTransport {
  return new BridgeTransport(bridge);
}
