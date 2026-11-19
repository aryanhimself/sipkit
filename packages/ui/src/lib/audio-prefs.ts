import type { ResolvedConfig, SoftphoneApi } from 'sipkit-core';

/** Voice processing choices from Settings → Audio; kept per account in localStorage. */
export type AudioPrefs = ResolvedConfig['audioProcessing'];

const KEYS = ['noiseSuppression', 'echoCancellation', 'autoGainControl', 'voiceIsolation'] as const;
const key = (username: string) => `sipkit:audio-prefs:${username || 'anonymous'}`;

export function loadAudioPrefs(username: string): Partial<AudioPrefs> | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(username));
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<AudioPrefs> = {};
    for (const k of KEYS) if (typeof v[k] === 'boolean') out[k] = v[k];
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function saveAudioPrefs(username: string, prefs: AudioPrefs): void {
  try {
    globalThis.localStorage?.setItem(key(username), JSON.stringify(prefs));
  } catch {
    /* storage blocked: the change still applies for this session */
  }
}

/** Apply saved choices (if any). The user's own choice wins over the host default. */
export async function applySavedAudioPrefs(api: SoftphoneApi): Promise<void> {
  const saved = loadAudioPrefs(api.config.username);
  const current = api.config.audioProcessing;
  if (!saved || !current) return;
  if (KEYS.every((k) => saved[k] === undefined || saved[k] === current[k])) return;
  await api.updateConfig({ audioProcessing: { ...current, ...saved } });
}
