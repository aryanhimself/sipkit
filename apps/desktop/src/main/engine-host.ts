/**
 * Extension point for V2-DESK-02 (native SIP engine, `packages/engine-native`).
 *
 * A native engine host lives in the main process (or proxies to a sidecar it
 * spawns) and implements the `SoftphoneEngine` methods. The renderer reaches it
 * through `window.sipkitDesktop.engine` (see shared/ipc.ts `EngineBridge`):
 *
 *   renderer IpcEngine.method(...args)
 *     → ipcRenderer.invoke('sipkit:engine:invoke', method, args)
 *     → host.invoke(method, args)
 *   host emit({ listener: 'onIncomingCall', args })
 *     → webContents.send('sipkit:engine:event', event)
 *     → IpcEngine replays it on its EngineListener
 *
 * Nothing registers a host yet: `invoke` rejects with NATIVE_ENGINE_UNAVAILABLE
 * and the renderer keeps using SIP.js. A later change calls
 * `registerNativeEngineHost()` from main/index.ts before the window loads.
 */
import type { EngineIpcEvent } from '../shared/ipc';

export interface NativeEngineHost {
  /** Run `SoftphoneEngine[method](...args)`. Args/results are structured-clone data. */
  invoke(method: string, args: unknown[]): Promise<unknown>;
  /** Receives the function that pushes `EngineListener` facts to the renderer. */
  attach(emit: (event: EngineIpcEvent) => void): void;
  dispose?(): void | Promise<void>;
}

export const ENGINE_METHOD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export const NATIVE_ENGINE_UNAVAILABLE = 'NATIVE_ENGINE_UNAVAILABLE';

let host: NativeEngineHost | null = null;
let emitter: ((event: EngineIpcEvent) => void) | null = null;

export function registerNativeEngineHost(next: NativeEngineHost | null): void {
  host = next;
  if (host && emitter) host.attach(emitter);
}

export function nativeEngineHost(): NativeEngineHost | null {
  return host;
}

/** Called by the IPC layer once a window exists to deliver events to. */
export function setNativeEngineEmitter(emit: (event: EngineIpcEvent) => void): void {
  emitter = emit;
  host?.attach(emit);
}

/** Validated entry point for the `sipkit:engine:invoke` IPC handler. */
export async function invokeNativeEngine(method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !ENGINE_METHOD.test(method)) throw new Error('Invalid engine method');
  if (!Array.isArray(args)) throw new Error('Invalid engine arguments');
  if (!host) throw new Error(NATIVE_ENGINE_UNAVAILABLE);
  return host.invoke(method, args);
}
