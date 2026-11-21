/**
 * Cross-browser bits: the `chrome` namespace (Firefox provides it too, with
 * promise-returning methods in MV3), the build target, internal message
 * types and a RemoteTransport over `runtime.Port`.
 */
import type { Cdr, RegistrationState } from 'sipkit-core';
import { BaseTransport } from 'sipkit-core/remote';

declare const __BROWSER__: 'chrome' | 'firefox' | undefined;

export const BROWSER: 'chrome' | 'firefox' = typeof __BROWSER__ === 'string' ? __BROWSER__ : 'chrome';

declare const __SIPKIT_EXT_VERSION__: string | undefined;
/** Extension version (offscreen documents have no runtime.getManifest). */
export const EXT_VERSION: string = typeof __SIPKIT_EXT_VERSION__ === 'string' ? __SIPKIT_EXT_VERSION__ : '0.0.0';

/** Port name used by every client (content-script relays, popup) to reach the softphone host. */
export const CLIENT_PORT = 'sipkit-client';

/** Small view of the host state for the badge / notifications. */
export interface HostSummary {
  configured: boolean;
  registration: RegistrationState;
  dnd: boolean;
  calls: {
    id: string;
    state: string;
    direction: 'incoming' | 'outgoing';
    remoteNumber: string;
    remoteDisplayName?: string;
    connectedAt?: number;
  }[];
}

/** Messages over runtime.sendMessage between the extension's own contexts. */
export type InternalMessage =
  /** content script / popup → background: make sure the host runs (Chrome: offscreen document). */
  | { type: 'sipkit:ensure-host' }
  /** content script → background: a click on a tel:/sip:/callto: link. */
  | { type: 'sipkit:dial'; number: string }
  /** popup → background: popup opened (reset the missed-call count). */
  | { type: 'sipkit:popup-opened' }
  /** background → host: (re)configure the instance. */
  | { type: 'sipkit:configure'; settings: unknown; secrets: unknown }
  /** background → host: run a whitelisted command (notification buttons, hotkeys, click-to-call). */
  | { type: 'sipkit:host-command'; name: string; args: unknown[] }
  /** host → background: state changed. */
  | { type: 'sipkit:host-state'; summary: HostSummary }
  /** host → background: a call finished. */
  | { type: 'sipkit:host-cdr'; cdr: Cdr }
  /** host → background: a client asked to provision credentials. */
  | { type: 'sipkit:provision'; origin: string; trusted: boolean; patch: unknown }
  /** host → background: a client changed a preference (voice processing, dial prefix). */
  | { type: 'sipkit:preferences'; patch: unknown }
  /** approve page → background: the user decided. */
  | { type: 'sipkit:approve'; origin: string; approved: boolean }
  /** e2e / mock engine only: run a mock helper on the host. */
  | { type: 'sipkit:debug'; method: string; args: unknown[] };

export function isInternalMessage(v: unknown): v is InternalMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && (v as { type: string }).type.startsWith('sipkit:');
}

/** RemoteTransport over a chrome.runtime.Port (JSON-serialised by the browser). */
export class RuntimePortTransport extends BaseTransport {
  constructor(private readonly port: chrome.runtime.Port) {
    super();
    port.onMessage.addListener((m: unknown) => this.deliver(m));
    port.onDisconnect.addListener(() => this.markClosed());
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
    try {
      this.port.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/** chrome.i18n.getMessage with a fallback (tests, missing keys). */
export function msg(key: string, subs?: string | string[]): string {
  try {
    return chrome.i18n.getMessage(key, subs) || key;
  } catch {
    return key;
  }
}

/** 'ne' when the browser UI is Nepali, else 'en'. */
export function uiLocale(): 'en' | 'ne' {
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('ne') ? 'ne' : 'en';
  } catch {
    return 'en';
  }
}
