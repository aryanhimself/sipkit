/**
 * Chrome offscreen document: home of the one softphone instance. Only
 * `chrome.runtime` is available here, so configuration comes from the
 * service worker and badge / notification updates go back to it.
 */
import { createExtensionHost } from '../host/host';
import { CLIENT_PORT, EXT_VERSION, isInternalMessage } from '../shared/ext';
import { isAllowedClient } from '../background/common';

async function toWorker(message: unknown): Promise<unknown> {
  const res = (await chrome.runtime.sendMessage(message).catch(() => undefined)) as
    | { ok: boolean; value?: unknown; error?: string; code?: string }
    | undefined;
  if (res && res.ok === false) {
    const err = new Error(res.error ?? 'Refused') as Error & { code?: string };
    err.code = res.code;
    throw err;
  }
  return res?.value;
}

const host = createExtensionHost(
  {
    provision: async (origin, trusted, patch) => {
      await toWorker({ type: 'sipkit:provision', origin, trusted, patch });
    },
    onSummary: (summary) => void toWorker({ type: 'sipkit:host-state', summary }).catch(() => undefined),
    onCdr: (cdr) => void toWorker({ type: 'sipkit:host-cdr', cdr }).catch(() => undefined),
  },
  { version: EXT_VERSION },
);

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isInternalMessage(raw) || sender.id !== chrome.runtime.id || sender.tab) return false;
  const reply = (p: Promise<unknown>) => {
    p.then(
      (value) => sendResponse({ ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  };
  switch (raw.type) {
    case 'sipkit:configure':
      return reply(host.configure(raw.settings, raw.secrets));
    case 'sipkit:host-command':
      return reply(host.command(raw.name, raw.args));
    case 'sipkit:debug':
      return reply(host.debug(raw.method, raw.args));
    default:
      return false;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CLIENT_PORT || !port.sender) return;
  const check = isAllowedClient(port.sender, host.settings);
  if (!check.ok) {
    port.disconnect();
    return;
  }
  host.attach(port, check.origin, check.trusted);
});
