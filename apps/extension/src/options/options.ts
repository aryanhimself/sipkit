/**
 * Options: SIP account (password kept in session storage only), allowed /
 * approved sites, click-to-call, notifications, and the one-time microphone
 * permission (offscreen documents and background pages cannot prompt).
 */
import { applyI18n } from '../shared/i18n-dom';
import { msg } from '../shared/ext';
import {
  SECRETS_KEY,
  SETTINGS_KEY,
  isValidMatchPattern,
  originOf,
  sanitizeSecrets,
  sanitizeSettings,
  type Settings,
} from '../shared/settings';

applyI18n(document);
const form = document.getElementById('form') as HTMLFormElement;
const status = document.getElementById('status')!;
const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as unknown as T;
const lines = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

async function load(): Promise<void> {
  const settings = sanitizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  const secrets = sanitizeSecrets(((await chrome.storage.session.get(SECRETS_KEY).catch(() => ({}))) as Record<string, unknown>)[SECRETS_KEY]);
  field<HTMLSelectElement>('engine').value = settings.engine;
  field('server').value = settings.account.websocketUrls[0] ?? '';
  field('username').value = settings.account.username;
  field('password').value = secrets.password;
  field('domain').value = settings.account.domain;
  field('displayName').value = settings.account.displayName;
  field<HTMLTextAreaElement>('allowedOrigins').value = settings.allowedOrigins.join('\n');
  field<HTMLTextAreaElement>('approvedOrigins').value = settings.approvedOrigins.join('\n');
  field('softphoneUrl').value = settings.softphoneUrl;
  field('clickToCall').checked = settings.clickToCall;
  field('notifications').checked = settings.notifications;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void save();
});

async function save(): Promise<void> {
  const current = sanitizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  const allowed = lines(field<HTMLTextAreaElement>('allowedOrigins').value);
  const invalid = allowed.filter((p) => !isValidMatchPattern(p));
  if (invalid.length) {
    status.textContent = msg('optionsInvalidPattern', invalid.join(', '));
    return;
  }
  const server = field('server').value.trim();
  const next: Settings = sanitizeSettings({
    ...current,
    engine: field<HTMLSelectElement>('engine').value,
    account: {
      ...current.account,
      websocketUrls: server ? [server] : [],
      username: field('username').value.trim(),
      domain: field('domain').value.trim(),
      displayName: field('displayName').value.trim(),
    },
    allowedOrigins: allowed,
    approvedOrigins: lines(field<HTMLTextAreaElement>('approvedOrigins').value).map(originOf).filter(Boolean),
    softphoneUrl: field('softphoneUrl').value.trim(),
    clickToCall: field('clickToCall').checked,
    notifications: field('notifications').checked,
  });

  // Optional host permissions, asked from this click: extra sites, and all sites for click-to-call.
  const wanted = [...next.allowedOrigins.filter((p) => !current.allowedOrigins.includes(p))];
  if (next.clickToCall && !current.clickToCall) wanted.push('*://*/*');
  if (wanted.length) await chrome.permissions.request({ origins: wanted }).catch(() => false);

  const secrets = sanitizeSecrets(((await chrome.storage.session.get(SECRETS_KEY).catch(() => ({}))) as Record<string, unknown>)[SECRETS_KEY]);
  await chrome.storage.session.set({ [SECRETS_KEY]: { ...secrets, password: field('password').value } });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  status.textContent = msg('optionsSaved');
}

document.getElementById('mic')!.addEventListener('click', () => {
  const out = document.getElementById('mic-status')!;
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      stream.getTracks().forEach((t) => t.stop());
      out.textContent = msg('optionsMicGranted');
    })
    .catch(() => {
      out.textContent = msg('optionsMicDenied');
    });
});

void load();
