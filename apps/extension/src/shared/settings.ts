/**
 * Extension settings (chrome.storage.local, no secrets) and secrets
 * (chrome.storage.session: cleared when the browser closes, never readable
 * by content scripts). See docs/browser-extension.md.
 */
import type { SoftphoneConfigInput } from 'sipkit-core';

declare const __SIPKIT_DEFAULT_ORIGINS__: string[] | undefined;
declare const __SIPKIT_SOFTPHONE_URL__: string | undefined;

export type EngineChoice = 'sipjs' | 'mock';

export interface AccountSettings {
  websocketUrls: string[];
  username: string;
  domain: string;
  displayName: string;
  authUsername: string;
}

export interface Settings {
  engine: EngineChoice;
  account: AccountSettings;
  /** Match patterns of pages that may attach as clients (and get the content script). */
  allowedOrigins: string[];
  /** Origins (scheme://host[:port]) the user approved to provision credentials. */
  approvedOrigins: string[];
  /** Opened by "Open softphone page" (e.g. the CRM). */
  softphoneUrl: string;
  /** Intercept tel:/sip:/callto: links. */
  clickToCall: boolean;
  /** OS notifications for incoming / missed calls. */
  notifications: boolean;
  brandName: string;
}

export interface Secrets {
  password: string;
  registerHeaders: string[];
}

export const SETTINGS_KEY = 'settings';
export const SECRETS_KEY = 'secrets';

export const DEFAULT_ORIGINS: string[] =
  typeof __SIPKIT_DEFAULT_ORIGINS__ !== 'undefined' && Array.isArray(__SIPKIT_DEFAULT_ORIGINS__)
    ? __SIPKIT_DEFAULT_ORIGINS__
    : ['http://localhost/*', 'http://127.0.0.1/*'];

export function defaultSettings(): Settings {
  return {
    engine: 'sipjs',
    account: { websocketUrls: [], username: '', domain: '', displayName: '', authUsername: '' },
    allowedOrigins: [...DEFAULT_ORIGINS],
    approvedOrigins: [],
    softphoneUrl: typeof __SIPKIT_SOFTPHONE_URL__ === 'string' ? __SIPKIT_SOFTPHONE_URL__ : '',
    clickToCall: false,
    notifications: true,
    brandName: 'SipKit',
  };
}

const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strList = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 2048).slice(0, max) : [];

/** Validate stored / submitted settings, falling back to defaults per field. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const acc = (typeof r.account === 'object' && r.account !== null ? r.account : {}) as Record<string, unknown>;
  return {
    engine: r.engine === 'mock' ? 'mock' : 'sipjs',
    account: {
      websocketUrls: strList(acc.websocketUrls, 8).filter((u) => /^wss?:\/\//i.test(u)),
      username: str(acc.username, 128),
      domain: str(acc.domain, 256),
      displayName: str(acc.displayName, 128),
      authUsername: str(acc.authUsername, 128),
    },
    allowedOrigins: Array.isArray(r.allowedOrigins) ? strList(r.allowedOrigins).filter(isValidMatchPattern) : d.allowedOrigins,
    approvedOrigins: strList(r.approvedOrigins).filter((o) => originOf(o) === o),
    softphoneUrl: /^https?:\/\//i.test(str(r.softphoneUrl, 2048)) ? str(r.softphoneUrl, 2048) : d.softphoneUrl,
    clickToCall: r.clickToCall === true,
    notifications: r.notifications !== false,
    brandName: str(r.brandName, 64) || d.brandName,
  };
}

export function sanitizeSecrets(raw: unknown): Secrets {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return { password: str(r.password, 1024), registerHeaders: strList(r.registerHeaders, 16) };
}

/** The softphone config the host instance runs with. */
export function buildConfig(settings: Settings, secrets: Secrets): SoftphoneConfigInput {
  const a = settings.account;
  return {
    brandName: settings.brandName,
    websocketUrls: a.websocketUrls,
    username: a.username,
    domain: a.domain,
    ...(a.displayName ? { displayName: a.displayName } : {}),
    ...(a.authUsername ? { authUsername: a.authUsername } : {}),
    password: secrets.password,
    registerHeaders: secrets.registerHeaders,
    // The extension instance itself is always local.
    instance: { mode: 'local' },
  };
}

/** True when there is enough to try a registration. */
export function isConfigured(settings: Settings, secrets: Secrets): boolean {
  if (settings.engine === 'mock') return Boolean(settings.account.username);
  return Boolean(settings.account.username && settings.account.websocketUrls.length && (secrets.password || secrets.registerHeaders.length));
}

// ---- match patterns ------------------------------------------------------------

/** scheme://host[:port] of a URL, or '' for non-http(s). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

const PATTERN = /^(\*|https?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(:(\*|\d{1,5}))?\/.*$/;

export function isValidMatchPattern(p: string): boolean {
  return p === '<all_urls>' || PATTERN.test(p);
}

/**
 * Does `url` match a WebExtension match pattern? Ports in the URL are
 * ignored unless the pattern names one, like Chrome does.
 */
export function matchesPattern(url: string, pattern: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (pattern === '<all_urls>') return true;
  const m = PATTERN.exec(pattern);
  if (!m) return false;
  const [, scheme, host, , port] = m;
  if (scheme !== '*' && `${scheme}:` !== u.protocol) return false;
  if (host !== '*') {
    if (host!.startsWith('*.')) {
      const base = host!.slice(2).toLowerCase();
      if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
    } else if (u.hostname !== host!.toLowerCase()) return false;
  }
  if (port && port !== '*' && u.port !== port) return false;
  const path = pattern.slice(pattern.indexOf('/', pattern.indexOf('://') + 3));
  const re = new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(u.pathname + u.search);
}

export function isAllowedUrl(url: string | undefined, patterns: string[]): boolean {
  return Boolean(url) && patterns.some((p) => matchesPattern(url!, p));
}
