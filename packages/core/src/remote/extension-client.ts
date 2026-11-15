/**
 * Page side of the browser-extension handshake (docs/browser-extension.md).
 *
 * 1. The page posts `ext:hello` on its own window with a fresh MessagePort.
 * 2. The extension's content script (same window, isolated world) checks
 *    source/origin/shape, answers `ext:ack` on that port at once (so the page
 *    knows the extension exists) and relays the port to the extension's
 *    softphone host, which then sends the protocol `welcome` over it.
 * 3. All further traffic uses the private port, not window broadcasts.
 *
 * Content scripts load at document_start, but the page may still post before
 * it listens; the content script then posts `ext:announce` and the page
 * retries once with a new port.
 */
import { MessagePortTransport, type RemoteTransport } from './transport';

export const EXTENSION_BRIDGE_NS = 'sipkit/extension';
export const EXTENSION_BRIDGE_VERSION = 1;

/** Window-level handshake messages (no data beyond these fields). */
export type ExtensionWindowMessage =
  | { ns: typeof EXTENSION_BRIDGE_NS; v: 1; type: 'ext:hello'; clientId: string }
  | { ns: typeof EXTENSION_BRIDGE_NS; v: 1; type: 'ext:announce' };

/** First messages the content script sends on the port. */
export type ExtensionPortControl =
  | { ns: typeof EXTENSION_BRIDGE_NS; v: 1; type: 'ext:ack'; extensionVersion?: string }
  | { ns: typeof EXTENSION_BRIDGE_NS; v: 1; type: 'ext:refused'; reason: 'origin-not-allowed' | 'unavailable' | string };

export function isExtensionWindowMessage(v: unknown): v is ExtensionWindowMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m.ns !== EXTENSION_BRIDGE_NS || m.v !== EXTENSION_BRIDGE_VERSION) return false;
  if (m.type === 'ext:announce') return true;
  return m.type === 'ext:hello' && typeof m.clientId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.clientId);
}

export function isExtensionPortControl(v: unknown): v is ExtensionPortControl {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return m.ns === EXTENSION_BRIDGE_NS && m.v === EXTENSION_BRIDGE_VERSION && (m.type === 'ext:ack' || m.type === 'ext:refused');
}

export interface ConnectExtensionOptions {
  /** Window to talk through (default `window`). */
  window?: Window;
  /** Wait this long for `ext:ack` (default 400 ms). */
  timeoutMs?: number;
  clientId: string;
}

export interface ExtensionConnection {
  transport: RemoteTransport;
  extensionVersion?: string;
}

/**
 * Resolve with a transport to the extension's softphone host, or null when
 * no extension answered (not installed, origin not allowed, or refused).
 */
export function connectExtension(options: ConnectExtensionOptions): Promise<ExtensionConnection | null> {
  const win = options.window ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof MessageChannel === 'undefined') return Promise.resolve(null);
  const origin = win.location.origin;
  return new Promise((resolve) => {
    let done = false;
    let attempts = 0;
    let channel: MessageChannel | null = null;

    const finish = (result: ExtensionConnection | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeEventListener('message', onWindowMessage);
      resolve(result);
    };

    const hello = () => {
      if (channel) {
        channel.port1.onmessage = null;
        channel.port1.close();
      }
      attempts++;
      const ch = new MessageChannel();
      channel = ch;
      ch.port1.onmessage = (e: MessageEvent) => {
        const data: unknown = e.data;
        if (!isExtensionPortControl(data)) return;
        ch.port1.onmessage = null;
        if (data.type === 'ext:refused') {
          ch.port1.close();
          finish(null);
          return;
        }
        // Extension present: hand the port (with any queued welcome) to a transport.
        finish({ transport: new MessagePortTransport(ch.port1), extensionVersion: data.extensionVersion });
      };
      const msg: ExtensionWindowMessage = {
        ns: EXTENSION_BRIDGE_NS,
        v: EXTENSION_BRIDGE_VERSION,
        type: 'ext:hello',
        clientId: options.clientId,
      };
      win.postMessage(msg, origin, [ch.port2]);
    };

    const onWindowMessage = (e: MessageEvent) => {
      if (e.source !== win || e.origin !== origin) return;
      if (isExtensionWindowMessage(e.data) && e.data.type === 'ext:announce' && attempts < 3) hello();
    };

    win.addEventListener('message', onWindowMessage);
    const timer = setTimeout(() => {
      channel?.port1.close();
      finish(null);
    }, options.timeoutMs ?? 400);
    hello();
  });
}
