/**
 * Desktop settings: shape, defaults and sanitising (V2-DESK-01).
 *
 * Settings live in `<userData>/settings.json` (plain JSON, no secrets). The SIP
 * password is stored separately, encrypted with Electron `safeStorage` (OS
 * keychain / DPAPI / libsecret), see src/main/credentials.ts.
 *
 * Everything that crosses the IPC boundary or comes from disk goes through
 * {@link sanitizeSettings} so a corrupt file or a compromised renderer cannot
 * inject unexpected values.
 */
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, type HotkeySettings } from './hotkeys';

/**
 * Which engine the renderer creates.
 * - `sipjs`: SIP.js WebRTC in the renderer (default, same as the web widget).
 * - `mock`: in-memory MockSoftphone (demo / e2e). Only selectable via settings file or env.
 * - `native`: reserved for V2-DESK-02 (`packages/engine-native`, a SIP sidecar driven over IPC).
 */
export type EngineKind = 'sipjs' | 'mock' | 'native';

export interface AccountSettings {
  /** WebSocket URL of the PBX or gateway, e.g. `wss://pbx.example.com:8089/ws`. */
  server: string;
  /** SIP domain. Empty = host of `server`. */
  domain: string;
  /** Extension / SIP username. */
  extension: string;
  /** Authorization username if different from the extension. */
  authUsername: string;
  displayName: string;
}

export interface DesktopSettings {
  version: 1;
  /** null until first-run setup is completed. */
  account: AccountSettings | null;
  engine: EngineKind;
  hotkeys: HotkeySettings;
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  notifications: { incoming: boolean; missed: boolean };
  /** Register as the OS handler for tel:, sip: and callto: links (packaged builds). */
  handleTelLinks: boolean;
  /** UI language: 'auto' (OS), 'en' or 'ne'. */
  locale: 'auto' | 'en' | 'ne';
  /** Accept self-signed TLS certificates from the configured server only (dev PBX). */
  allowInsecureCerts: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  version: 1,
  account: null,
  engine: 'sipjs',
  hotkeys: { ...DEFAULT_HOTKEYS },
  closeToTray: true,
  notifications: { incoming: true, missed: true },
  handleTelLinks: true,
  locale: 'auto',
  allowInsecureCerts: false,
};

const ENGINES: readonly EngineKind[] = ['sipjs', 'mock', 'native'];
const LOCALES: readonly DesktopSettings['locale'][] = ['auto', 'en', 'ne'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 256): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export type AccountField = 'server' | 'extension' | 'password' | 'domain';
export type AccountError = 'required' | 'invalidServer' | 'invalidExtension' | 'invalidDomain';

/** Field errors for the setup form. `requirePassword` is false when one is already stored. */
export function validateAccount(
  input: Partial<AccountSettings> & { password?: string },
  { requirePassword = true, engine = 'sipjs' as EngineKind } = {},
): Partial<Record<AccountField, AccountError>> {
  const errors: Partial<Record<AccountField, AccountError>> = {};
  const server = str(input.server, 512);
  if (!server) errors.server = 'required';
  else if (engine !== 'native') {
    try {
      const url = new URL(server);
      if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopback(url.hostname))) errors.server = 'invalidServer';
    } catch {
      errors.server = 'invalidServer';
    }
  }
  const extension = str(input.extension, 64);
  if (!extension) errors.extension = 'required';
  else if (!/^[A-Za-z0-9_.+*#-]{1,64}$/.test(extension)) errors.extension = 'invalidExtension';
  const domain = str(input.domain);
  if (domain && !/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(domain)) errors.domain = 'invalidDomain';
  if (requirePassword && !input.password) errors.password = 'required';
  return errors;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function sanitizeAccount(raw: unknown): AccountSettings | null {
  if (!isRecord(raw)) return null;
  const account: AccountSettings = {
    server: str(raw.server, 512),
    domain: str(raw.domain),
    extension: str(raw.extension, 64),
    authUsername: str(raw.authUsername, 64),
    displayName: str(raw.displayName, 128),
  };
  const errors = validateAccount(account, { requirePassword: false, engine: 'native' });
  return errors.server || errors.extension ? null : account;
}

function sanitizeHotkeys(raw: unknown): HotkeySettings {
  const out = { ...DEFAULT_HOTKEYS };
  if (!isRecord(raw)) return out;
  for (const action of HOTKEY_ACTIONS) {
    if (typeof raw[action] === 'string') out[action] = str(raw[action], 64);
  }
  return out;
}

/** Merge untrusted input (disk or IPC) over the defaults, dropping anything invalid. */
export function sanitizeSettings(raw: unknown, base: DesktopSettings = DEFAULT_SETTINGS): DesktopSettings {
  if (!isRecord(raw)) return structuredClone(base);
  const notifications = isRecord(raw.notifications) ? raw.notifications : {};
  return {
    version: 1,
    account: 'account' in raw ? sanitizeAccount(raw.account) : base.account,
    engine: ENGINES.includes(raw.engine as EngineKind) ? (raw.engine as EngineKind) : base.engine,
    hotkeys: 'hotkeys' in raw ? sanitizeHotkeys(raw.hotkeys) : { ...base.hotkeys },
    closeToTray: bool(raw.closeToTray, base.closeToTray),
    notifications: {
      incoming: bool(notifications.incoming, base.notifications.incoming),
      missed: bool(notifications.missed, base.notifications.missed),
    },
    handleTelLinks: bool(raw.handleTelLinks, base.handleTelLinks),
    locale: LOCALES.includes(raw.locale as DesktopSettings['locale']) ? (raw.locale as DesktopSettings['locale']) : base.locale,
    allowInsecureCerts: bool(raw.allowInsecureCerts, base.allowInsecureCerts),
  };
}

/** Host part of the server URL (used as the default SIP domain and for cert pinning). */
export function serverHost(server: string): string {
  try {
    return new URL(server).hostname;
  } catch {
    return '';
  }
}

/** SIP domains a `sip:` link may use to count as "our PBX" (dial the user part only). */
export function localSipDomains(account: AccountSettings | null): string[] {
  if (!account) return [];
  return [account.domain, serverHost(account.server)].filter(Boolean);
}
