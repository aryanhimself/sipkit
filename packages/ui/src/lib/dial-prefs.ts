import type { SoftphoneApi } from 'sipkit-core';

/** Dialing preferences the user can change in Settings; kept per account in localStorage. */
export interface DialPrefs {
  techPrefix: string;
  techPrefixMinDigits: number;
}

export const SHORT_EXTENSION_DIGITS = 7;
export const VALID_PREFIX = /^[0-9*#+]{0,8}$/;

const key = (username: string) => `sipkit:dial-prefs:${username || 'anonymous'}`;

export function loadDialPrefs(username: string): DialPrefs | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(username));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DialPrefs>;
    if (typeof v.techPrefix !== 'string' || !VALID_PREFIX.test(v.techPrefix)) return null;
    const min = typeof v.techPrefixMinDigits === 'number' && v.techPrefixMinDigits >= 0 ? Math.floor(v.techPrefixMinDigits) : 0;
    return { techPrefix: v.techPrefix, techPrefixMinDigits: min };
  } catch {
    return null;
  }
}

export function saveDialPrefs(username: string, prefs: DialPrefs): void {
  try {
    globalThis.localStorage?.setItem(key(username), JSON.stringify(prefs));
  } catch {
    /* storage blocked: the change still applies for this session */
  }
}

/** Apply saved preferences (if any) to a softphone. The user's own choice wins over the host default. */
export async function applySavedDialPrefs(api: SoftphoneApi): Promise<void> {
  const saved = loadDialPrefs(api.config.username);
  if (!saved) return;
  const cfg = api.config;
  if (cfg.techPrefix === saved.techPrefix && cfg.techPrefixMinDigits === saved.techPrefixMinDigits) return;
  await api.updateConfig(saved);
}
