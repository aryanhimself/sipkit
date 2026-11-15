/**
 * Global hotkeys (V2-DESK-03): validation and normalisation of Electron
 * accelerator strings, and the mapping from settings to bindings.
 *
 * Pure functions: no Electron imports, unit tested in hotkeys.test.ts. The main
 * process registers the bindings with `globalShortcut` (src/main/hotkeys.ts).
 */

export type HotkeyAction = 'answer' | 'hangup' | 'toggleMute' | 'toggleDnd';

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['answer', 'hangup', 'toggleMute', 'toggleDnd'];

/** Accelerator per action. Empty string = not bound. */
export type HotkeySettings = Record<HotkeyAction, string>;

export const DEFAULT_HOTKEYS: HotkeySettings = {
  answer: 'CommandOrControl+Shift+A',
  hangup: 'CommandOrControl+Shift+H',
  toggleMute: '',
  toggleDnd: '',
};

const MODIFIERS: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Meta',
};
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Super', 'Meta', 'Alt', 'AltGr', 'Shift'];

const NAMED_KEYS: Record<string, string> = {
  plus: 'Plus',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  printscreen: 'PrintScreen',
  mediaplaypause: 'MediaPlayPause',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
};
/** Keys that may be bound without a modifier (they never collide with typing). */
const STANDALONE = /^(F1[3-9]|F2[0-4]|Media(PlayPause|NextTrack|PreviousTrack|Stop))$/;
const PUNCTUATION = /^[)!@#$%^&*(:;<>=_,\-.?/~`{}[\]|\\'"]$/;

export type AcceleratorResult = { ok: true; accelerator: string } | { ok: false; error: AcceleratorError };
export type AcceleratorError = 'empty' | 'noKey' | 'unknownKey' | 'tooManyKeys' | 'needsModifier' | 'duplicateModifier';

function normaliseKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^num([0-9]|dec|add|sub|mult|div)$/i.test(raw)) return lower;
  if (PUNCTUATION.test(raw)) return raw;
  return null;
}

/**
 * Validate and canonicalise an accelerator, e.g. `ctrl+shift+a` → `Control+Shift+A`.
 * Requires a modifier unless the key is F13–F24 or a media key, so a global
 * hotkey can never swallow normal typing.
 */
export function normalizeAccelerator(input: string): AcceleratorResult {
  const value = (input ?? '').trim();
  if (!value) return { ok: false, error: 'empty' };
  // "Ctrl++" means Ctrl + Plus.
  const parts = value.replace(/\+\+$/, '+Plus').split('+').map((p) => p.trim());
  const modifiers: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    if (!part) return { ok: false, error: 'unknownKey' };
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      if (modifiers.includes(mod)) return { ok: false, error: 'duplicateModifier' };
      modifiers.push(mod);
      continue;
    }
    if (key) return { ok: false, error: 'tooManyKeys' };
    key = normaliseKey(part);
    if (!key) return { ok: false, error: 'unknownKey' };
  }
  if (!key) return { ok: false, error: 'noKey' };
  if (modifiers.length === 0 && !STANDALONE.test(key)) return { ok: false, error: 'needsModifier' };
  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return { ok: true, accelerator: [...modifiers, key].join('+') };
}

export interface HotkeyBinding {
  action: HotkeyAction;
  accelerator: string;
}

export interface HotkeyPlan {
  bindings: HotkeyBinding[];
  /** Actions whose accelerator was invalid or used twice (the first one wins). */
  problems: { action: HotkeyAction; accelerator: string; error: AcceleratorError | 'duplicate' }[];
}

/** Turn settings into the list of shortcuts to register. Unbound actions are skipped. */
export function planHotkeys(settings: Partial<HotkeySettings>): HotkeyPlan {
  const bindings: HotkeyBinding[] = [];
  const problems: HotkeyPlan['problems'] = [];
  const used = new Set<string>();
  for (const action of HOTKEY_ACTIONS) {
    const raw = settings[action] ?? '';
    if (!raw.trim()) continue;
    const result = normalizeAccelerator(raw);
    if (!result.ok) {
      problems.push({ action, accelerator: raw, error: result.error });
      continue;
    }
    // CommandOrControl+X and Control+X collide on Windows/Linux; compare loosely.
    const key = result.accelerator.replace(/^CommandOrControl\+/, 'Control+').toLowerCase();
    if (used.has(key)) {
      problems.push({ action, accelerator: raw, error: 'duplicate' });
      continue;
    }
    used.add(key);
    bindings.push({ action, accelerator: result.accelerator });
  }
  return { bindings, problems };
}

/** Human readable form for the settings screen (`CommandOrControl` → `⌘`/`Ctrl`). */
export function displayAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin';
  return accelerator
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl') return mac ? '⌘' : 'Ctrl';
      if (p === 'Command') return mac ? '⌘' : 'Cmd';
      if (p === 'Control') return mac ? '⌃' : 'Ctrl';
      if (p === 'Alt') return mac ? '⌥' : 'Alt';
      if (p === 'Shift') return mac ? '⇧' : 'Shift';
      return p;
    })
    .join(mac ? '' : '+');
}
