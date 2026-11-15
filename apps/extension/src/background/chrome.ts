/**
 * Chrome service worker. It does not run the softphone: the instance lives in
 * the offscreen document (WebRTC, getUserMedia, audio), which outlives
 * service-worker restarts. This worker creates / recreates that document,
 * hands it the configuration, approves provisioning and drives the badge,
 * notifications, hotkeys, context menu and omnibox.
 */
import type { Cdr } from 'sipkit-core';
import { createController } from './controller';
import {
  getSecrets,
  getSettings,
  handleApproval,
  handleProvision,
  initStorageAccess,
  isAllowedClient,
  isExtensionSender,
  syncContentScripts,
} from './common';
import { isInternalMessage, type HostSummary, type InternalMessage } from '../shared/ext';
import { SECRETS_KEY, SETTINGS_KEY } from '../shared/settings';

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

let creating: Promise<void> | null = null;

/** Send a message to the offscreen host, retrying while it loads. */
async function toHost<T = unknown>(message: InternalMessage, attempts = 40): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const res = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string } | undefined;
      if (res && typeof res === 'object' && 'ok' in res) {
        if (!res.ok) throw new Error(res.error ?? 'Host error');
        return res.value as T;
      }
    } catch (e) {
      if (e instanceof Error && !/Receiving end does not exist|message port closed/i.test(e.message)) throw e;
    }
    if (i >= attempts) throw new Error('Softphone host not reachable');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function pushConfig(): Promise<void> {
  await toHost({ type: 'sipkit:configure', settings: await getSettings(), secrets: await getSecrets() });
}

/** Create the offscreen document if it is gone, then make sure it runs the current config. */
async function ensureHost(): Promise<void> {
  if (!(await hasOffscreen())) {
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WEB_RTC, chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Runs the softphone (SIP over WebRTC) so calls survive page reloads and play audio',
      })
      .catch((e: unknown) => {
        if (!String(e).includes('single offscreen')) throw e;
      })
      .finally(() => {
        creating = null;
      });
    await creating;
  }
  await pushConfig();
}

const controller = createController({
  command: (name, args) => ensureHost().then(() => toHost({ type: 'sipkit:host-command', name, args })),
  ensureHost,
  getSettings,
});
controller.install();

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isInternalMessage(raw) || sender.id !== chrome.runtime.id) return false;
  const fromOffscreen = sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
  const reply = (p: Promise<unknown>) => {
    p.then(
      (value) => sendResponse({ ok: true, value }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code }),
    );
    return true;
  };
  const m = raw;
  switch (m.type) {
    case 'sipkit:ensure-host':
      return reply(
        (async () => {
          await ensureHost();
          return { allowed: isAllowedClient(sender, await getSettings()).ok };
        })(),
      );
    case 'sipkit:dial':
      return reply(controller.dial(m.number));
    case 'sipkit:popup-opened':
      return isExtensionSender(sender) ? reply(controller.popupOpened()) : false;
    case 'sipkit:approve':
      return isExtensionSender(sender) ? reply(handleApproval(m.origin, m.approved, pushConfig)) : false;
    case 'sipkit:host-state':
      return fromOffscreen ? reply(controller.onSummary(m.summary as HostSummary)) : false;
    case 'sipkit:host-cdr':
      return fromOffscreen ? reply(controller.onCdr(m.cdr as Cdr)) : false;
    case 'sipkit:provision':
      return fromOffscreen ? reply(handleProvision(m.origin, m.trusted, m.patch as object, pushConfig)) : false;
    default:
      return false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && SETTINGS_KEY in changes) || (area === 'session' && SECRETS_KEY in changes)) {
    void hasOffscreen().then((has) => (has ? pushConfig() : undefined)).catch(() => undefined);
    if (area === 'local') void syncContentScripts();
  }
});
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());

// Bring the instance up with the browser (it registers if credentials are available).
chrome.runtime.onStartup.addListener(() => void ensureHost().catch(() => undefined));
chrome.runtime.onInstalled.addListener(() => {
  void initStorageAccess();
  void syncContentScripts();
  void ensureHost().catch(() => undefined);
});
void initStorageAccess();

/** e2e / debugging with the mock engine: `__sipkitDebug('simulateIncomingCall', '5550100', 'Jane')`. */
(globalThis as unknown as { __sipkitDebug: unknown }).__sipkitDebug = (method: string, ...args: unknown[]) =>
  ensureHost().then(() => toHost({ type: 'sipkit:debug', method, args }));
(globalThis as unknown as { __sipkitEnsureHost: unknown }).__sipkitEnsureHost = ensureHost;
