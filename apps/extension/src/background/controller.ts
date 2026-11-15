/**
 * Browser integration around the host instance: toolbar badge, OS
 * notifications, keyboard commands, context menu, omnibox and click-to-call.
 * Runs in the Chrome service worker or the Firefox background page; talks to
 * the host through `ControllerDeps`. State that must survive a service-worker
 * restart lives in chrome.storage.session.
 */
import type { Cdr } from 'sipkit-core';
import { BROWSER, msg, type HostSummary } from '../shared/ext';
import { parseDialLink, parsePhoneFromText } from '../shared/phone';
import type { Settings } from '../shared/settings';

export interface ControllerDeps {
  command(name: string, args: unknown[]): Promise<unknown>;
  ensureHost(): Promise<void>;
  getSettings(): Promise<Settings>;
}

interface ControllerState {
  summary: HostSummary | null;
  missed: number;
  notified: string[];
  pendingDial: { number: string; at: number } | null;
}

const STATE_KEY = 'sipkit:controller';
const PENDING_DIAL_MS = 60_000;
export const MENU_ID = 'sipkit-call-selection';

export interface Badge {
  text: string;
  color: string;
  /** _locales key of the tooltip. */
  title: string;
}

const isRinging = (c: HostSummary['calls'][number]) =>
  c.direction === 'incoming' && (c.state === 'setup' || c.state === 'ringing' || c.state === 'early');

/** Badge for a host state: ringing > in call > offline > missed calls > DND > nothing. */
export function badgeFor(summary: HostSummary | null, missed: number): Badge {
  if (!summary || !summary.configured) return { text: '', color: '#6b7280', title: 'badgeNotConfigured' };
  if (summary.calls.some(isRinging)) return { text: msg('badgeRinging'), color: '#d97706', title: 'badgeRingingTitle' };
  if (summary.calls.length > 0) return { text: msg('badgeInCall'), color: '#16a34a', title: 'badgeInCallTitle' };
  if (summary.registration !== 'registered') return { text: msg('badgeOffline'), color: '#6b7280', title: 'badgeOfflineTitle' };
  if (missed > 0) return { text: missed > 99 ? '99+' : String(missed), color: '#dc2626', title: 'badgeMissedTitle' };
  if (summary.dnd) return { text: msg('badgeDnd'), color: '#dc2626', title: 'badgeDndTitle' };
  return { text: '', color: '#16a34a', title: 'badgeOnlineTitle' };
}

/** An incoming call nobody answered (declining is not "missed"). */
export function isMissed(cdr: Cdr): boolean {
  return cdr.direction === 'incoming' && !cdr.connectedAt && cdr.reason !== 'rejected' && cdr.reason !== 'local-hangup' && cdr.reason !== 'transferred';
}

async function loadState(): Promise<ControllerState> {
  try {
    const raw = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as Partial<ControllerState> | undefined;
    return { summary: raw?.summary ?? null, missed: raw?.missed ?? 0, notified: raw?.notified ?? [], pendingDial: raw?.pendingDial ?? null };
  } catch {
    return { summary: null, missed: 0, notified: [], pendingDial: null };
  }
}

async function saveState(state: ControllerState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state }).catch(() => undefined);
}

const notificationId = (callId: string) => `sipkit-call:${callId}`;

/** Callback style works with both Chrome's and Firefox's `chrome.notifications`. */
function createNotification(id: string, options: chrome.notifications.NotificationOptions<true>): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, options, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function clearNotification(id: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.notifications.clear(id, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}
const ICON = 'icons/icon-128.png';

export function createController(deps: ControllerDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  /** Serialise state updates (events can arrive back to back). */
  const update = (fn: (s: ControllerState) => Promise<void> | void) => {
    const run = async () => {
      const s = await loadState();
      await fn(s);
      await saveState(s);
      await renderBadge(s);
    };
    chain = chain.then(run, run);
    return chain;
  };

  async function renderBadge(s: ControllerState): Promise<void> {
    const b = badgeFor(s.summary, s.missed);
    await chrome.action.setBadgeText({ text: b.text }).catch(() => undefined);
    await chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => undefined);
    await chrome.action.setTitle({ title: `${msg('extName')} · ${msg(b.title)}` }).catch(() => undefined);
  }

  async function notifyIncoming(call: HostSummary['calls'][number]): Promise<void> {
    const options: chrome.notifications.NotificationOptions<true> = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON),
      title: msg('notifyIncomingTitle'),
      message: call.remoteDisplayName ? `${call.remoteDisplayName} (${call.remoteNumber})` : call.remoteNumber,
      priority: 2,
    };
    // Firefox has no notification buttons: a click opens the softphone instead.
    if (BROWSER === 'chrome') {
      options.buttons = [{ title: msg('notifyAnswer') }, { title: msg('notifyDecline') }];
      options.requireInteraction = true;
    }
    await createNotification(notificationId(call.id), options);
  }

  async function dialNow(number: string): Promise<void> {
    await deps.command('call', [number]).catch(() => undefined);
  }

  async function openSoftphone(): Promise<void> {
    const settings = await deps.getSettings();
    if (settings.softphoneUrl) {
      await chrome.tabs.create({ url: settings.softphoneUrl }).catch(() => undefined);
      return;
    }
    await chrome.windows
      .create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 400, height: 660 })
      .catch(() => undefined);
  }

  const controller = {
    /** New host state: badge, incoming-call notifications, queued click-to-call. */
    onSummary(summary: HostSummary) {
      return update(async (s) => {
        s.summary = summary;
        const settings = await deps.getSettings();
        const ringing = summary.calls.filter(isRinging);
        for (const c of ringing) {
          if (s.notified.includes(c.id)) continue;
          s.notified.push(c.id);
          if (settings.notifications) await notifyIncoming(c);
        }
        const ringingIds = new Set(ringing.map((c) => c.id));
        for (const id of s.notified.filter((n) => !ringingIds.has(n))) await clearNotification(notificationId(id));
        s.notified = s.notified.filter((n) => ringingIds.has(n));
        if (s.pendingDial) {
          if (Date.now() - s.pendingDial.at > PENDING_DIAL_MS) s.pendingDial = null;
          else if (summary.registration === 'registered') {
            const n = s.pendingDial.number;
            s.pendingDial = null;
            void dialNow(n);
          }
        }
      });
    },

    onCdr(cdr: Cdr) {
      if (!isMissed(cdr)) return Promise.resolve();
      return update(async (s) => {
        s.missed += 1;
        const settings = await deps.getSettings();
        if (settings.notifications) {
          await createNotification(`sipkit-missed:${cdr.callId}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL(ICON),
            title: msg('notifyMissedTitle'),
            message: cdr.remoteDisplayName ? `${cdr.remoteDisplayName} (${cdr.caller})` : cdr.caller,
          });
        }
      });
    },

    popupOpened() {
      return update((s) => {
        s.missed = 0;
      });
    },

    /** Click-to-call / omnibox / context menu: dial on the instance, or once it is registered. */
    async dial(raw: string): Promise<boolean> {
      const number = parseDialLink(raw) ?? parsePhoneFromText(raw);
      if (!number) return false;
      await deps.ensureHost();
      const s = await loadState();
      if (s.summary?.registration === 'registered') {
        await dialNow(number);
        return true;
      }
      if (!s.summary?.configured) {
        await chrome.runtime.openOptionsPage().catch(() => undefined);
      }
      await update((st) => {
        st.pendingDial = { number, at: Date.now() };
      });
      return true;
    },

    async answerRinging(): Promise<void> {
      const s = await loadState();
      const call = s.summary?.calls.find(isRinging);
      if (call) await deps.command('answer', [call.id]).catch(() => undefined);
    },

    async hangupOrDecline(): Promise<void> {
      const s = await loadState();
      const calls = s.summary?.calls ?? [];
      const established = calls.find((c) => !isRinging(c));
      if (established) await deps.command('hangup', [established.id]).catch(() => undefined);
      else {
        const ringing = calls.find(isRinging);
        if (ringing) await deps.command('reject', [ringing.id]).catch(() => undefined);
      }
    },

    /** Register browser listeners (call once at the top level of the background script). */
    install(): void {
      chrome.notifications.onButtonClicked?.addListener((id, index) => {
        if (!id.startsWith('sipkit-call:')) return;
        const callId = id.slice('sipkit-call:'.length);
        void deps.command(index === 0 ? 'answer' : 'reject', [callId]).catch(() => undefined);
        void clearNotification(id);
      });
      chrome.notifications.onClicked.addListener((id) => {
        if (!id.startsWith('sipkit-')) return;
        void clearNotification(id);
        void openSoftphone();
      });
      chrome.commands.onCommand.addListener((command) => {
        if (command === 'answer-call') void controller.answerRinging();
        if (command === 'hangup-call') void controller.hangupOrDecline();
      });
      chrome.contextMenus.onClicked.addListener((info) => {
        if (info.menuItemId !== MENU_ID) return;
        const text = info.linkUrl && /^(tel|sips?|callto):/i.test(info.linkUrl) ? info.linkUrl : (info.selectionText ?? '');
        void controller.dial(text);
      });
      chrome.omnibox.setDefaultSuggestion({ description: msg('omniboxHint') });
      chrome.omnibox.onInputEntered.addListener((text) => void controller.dial(text));
      chrome.runtime.onInstalled.addListener(() => {
        chrome.contextMenus.removeAll(() => {
          chrome.contextMenus.create({ id: MENU_ID, title: msg('menuCall'), contexts: ['selection', 'link'] });
        });
      });
    },
  };
  return controller;
}
