/**
 * Background logic shared by the Chrome service worker and the Firefox
 * background page: settings, credential provisioning with per-site approval,
 * dynamic content scripts, sender checks.
 */
import type { SoftphoneConfigInput } from 'sipkit-core';
import { pickProvisioning } from 'sipkit-core/remote';
import {
  DEFAULT_ORIGINS,
  SECRETS_KEY,
  SETTINGS_KEY,
  isAllowedUrl,
  originOf,
  sanitizeSecrets,
  sanitizeSettings,
  type Secrets,
  type Settings,
} from '../shared/settings';

export async function getSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return sanitizeSettings(raw);
}

export async function getSecrets(): Promise<Secrets> {
  const raw = (await chrome.storage.session.get(SECRETS_KEY))[SECRETS_KEY];
  return sanitizeSecrets(raw);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Secrets stay in session storage (memory, cleared on browser exit) and are never exposed to content scripts. */
export async function initStorageAccess(): Promise<void> {
  await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
}

/** Store provisioned credentials: account fields in settings, password / register headers in session storage. */
export async function applyProvisioning(patch: SoftphoneConfigInput): Promise<void> {
  const p = pickProvisioning(patch);
  const settings = await getSettings();
  const secrets = await getSecrets();
  const account = { ...settings.account };
  if (p.websocketUrls) account.websocketUrls = p.websocketUrls;
  if (typeof p.username === 'string') account.username = p.username;
  if (typeof p.domain === 'string') account.domain = p.domain;
  if (typeof p.displayName === 'string') account.displayName = p.displayName;
  if (typeof p.authUsername === 'string') account.authUsername = p.authUsername;
  if (typeof p.password === 'string') secrets.password = p.password;
  if (p.registerHeaders) secrets.registerHeaders = p.registerHeaders;
  await chrome.storage.session.set({ [SECRETS_KEY]: secrets });
  await saveSettings({ ...settings, account });
}

const PENDING_PREFIX = 'sipkit:pending-provision:';

/**
 * A client asked to provision credentials. Extension pages are trusted. A web
 * page must be approved once by the user ("connect this site"); until then
 * the request is parked and an approval window opens.
 */
export async function handleProvision(
  origin: string,
  trusted: boolean,
  patch: SoftphoneConfigInput,
  apply: () => Promise<void>,
): Promise<void> {
  const settings = await getSettings();
  if (!trusted && !settings.approvedOrigins.includes(origin)) {
    await chrome.storage.session.set({ [PENDING_PREFIX + origin]: pickProvisioning(patch) });
    await chrome.windows
      .create({ url: chrome.runtime.getURL(`approve.html?origin=${encodeURIComponent(origin)}`), type: 'popup', width: 440, height: 360 })
      .catch(() => undefined);
    const err = new Error('This site must be approved in the extension before it can sign in') as Error & { code: string };
    err.code = 'APPROVAL_REQUIRED';
    throw err;
  }
  await applyProvisioning(patch);
  await apply();
}

/** The user answered the approval window. */
export async function handleApproval(origin: string, approved: boolean, apply: () => Promise<void>): Promise<void> {
  if (originOf(origin) !== origin) return;
  const key = PENDING_PREFIX + origin;
  const pending = (await chrome.storage.session.get(key))[key] as SoftphoneConfigInput | undefined;
  await chrome.storage.session.remove(key);
  if (!approved) return;
  const settings = await getSettings();
  if (!settings.approvedOrigins.includes(origin)) await saveSettings({ ...settings, approvedOrigins: [...settings.approvedOrigins, origin] });
  if (pending) {
    await applyProvisioning(pending);
    await apply();
  }
}

/** Sender is one of our own pages (popup, options, approve). */
export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return Boolean(sender.url?.startsWith(chrome.runtime.getURL(''))) && sender.id === chrome.runtime.id;
}

/** Browser-reported origin of a content-script sender (never page-controlled). */
export function senderOrigin(sender: chrome.runtime.MessageSender): string {
  return sender.origin && sender.origin !== 'null' ? sender.origin : originOf(sender.tab?.url ?? sender.url ?? '');
}

/** May this sender attach as a client? Extension pages always; web pages when their URL matches the allow-list. */
export function isAllowedClient(sender: chrome.runtime.MessageSender, settings: Settings): { ok: boolean; origin: string; trusted: boolean } {
  if (sender.id !== chrome.runtime.id) return { ok: false, origin: '', trusted: false };
  if (isExtensionSender(sender)) return { ok: true, origin: originOf(sender.url ?? '') || 'extension', trusted: true };
  const origin = senderOrigin(sender);
  const url = sender.tab?.url ?? sender.url ?? `${origin}/`;
  return { ok: Boolean(origin) && isAllowedUrl(url, settings.allowedOrigins), origin, trusted: false };
}

const DYNAMIC_ID = 'sipkit-dynamic-content';

/**
 * Register the content script on allowed origins beyond the build-time
 * defaults, and on all sites for click-to-call, but only where the user
 * granted the (optional) host permission.
 */
export async function syncContentScripts(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;
  const settings = await getSettings();
  const wanted = new Set(settings.allowedOrigins.filter((p) => !DEFAULT_ORIGINS.includes(p)));
  if (settings.clickToCall) wanted.add('*://*/*');
  const granted: string[] = [];
  for (const p of wanted) {
    if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) granted.push(p);
  }
  await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_ID] }).catch(() => undefined);
  if (!granted.length) return;
  await chrome.scripting
    .registerContentScripts([{ id: DYNAMIC_ID, matches: granted, js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true }])
    .catch(() => undefined);
}
