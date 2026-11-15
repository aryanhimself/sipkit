/**
 * Firefox background (event page). Firefox has no offscreen documents, so
 * the softphone instance runs right here, next to the badge / notification
 * logic. Open client ports (content-script relays, the popup) and an active
 * call keep the page alive; see docs/browser-extension.md for the caveats.
 */
import type { SoftphoneConfigInput } from 'sipkit-core';
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
import { createExtensionHost } from '../host/host';
import { CLIENT_PORT, EXT_VERSION, isInternalMessage } from '../shared/ext';
import { SECRETS_KEY, SETTINGS_KEY } from '../shared/settings';

let controllerRef: ReturnType<typeof createController> | null = null;

const host = createExtensionHost(
  {
    provision: (origin, trusted, patch: SoftphoneConfigInput) => handleProvision(origin, trusted, patch, pushConfig),
    onSummary: (summary) => void controllerRef?.onSummary(summary),
    onCdr: (cdr) => void controllerRef?.onCdr(cdr),
  },
  { version: EXT_VERSION },
);

async function pushConfig(): Promise<void> {
  await host.configure(await getSettings(), await getSecrets());
}

let started: Promise<void> | null = null;
const ensureHost = () => (started ??= pushConfig());

const controller = createController({
  command: (name, args) => ensureHost().then(() => host.command(name, args)),
  ensureHost,
  getSettings,
});
controllerRef = controller;
controller.install();

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isInternalMessage(raw) || sender.id !== chrome.runtime.id) return false;
  const reply = (p: Promise<unknown>) => {
    p.then(
      (value) => sendResponse({ ok: true, value }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  };
  switch (raw.type) {
    case 'sipkit:ensure-host':
      return reply(ensureHost().then(async () => ({ allowed: isAllowedClient(sender, await getSettings()).ok })));
    case 'sipkit:dial':
      return reply(controller.dial(raw.number));
    case 'sipkit:popup-opened':
      return isExtensionSender(sender) ? reply(controller.popupOpened()) : false;
    case 'sipkit:approve':
      return isExtensionSender(sender) ? reply(handleApproval(raw.origin, raw.approved, pushConfig)) : false;
    default:
      return false;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CLIENT_PORT || !port.sender) return;
  void ensureHost().then(async () => {
    const check = isAllowedClient(port.sender!, await getSettings());
    if (!check.ok) port.disconnect();
    else host.attach(port, check.origin, check.trusted);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && SETTINGS_KEY in changes) || (area === 'session' && SECRETS_KEY in changes)) {
    void pushConfig();
    if (area === 'local') void syncContentScripts();
  }
});
chrome.permissions.onAdded.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());
chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
void initStorageAccess();
void ensureHost();
