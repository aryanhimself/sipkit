import { en, type Messages } from './en';
import { ne } from './ne';

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleDefinition {
  /** BCP 47 tag, e.g. 'ne', 'ne-NP', 'hi'. */
  code: string;
  /** Messages for this locale. Missing keys fall back along the chain (ne-NP → ne → en). */
  messages: Partial<Messages>;
  /** Text direction. Default: derived from the language (ar, he, fa, ur… are rtl). */
  dir?: TextDirection;
  /**
   * Locale used for Intl number/date formatting, e.g. 'ne-NP-u-nu-latn'.
   * Default: the requested tag.
   */
  intlLocale?: string;
}

const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

const registry = new Map<string, LocaleDefinition>();
const listeners = new Set<() => void>();
let version = 0;

function key(code: string): string {
  return code.toLowerCase();
}

function add(def: LocaleDefinition): void {
  const prev = registry.get(key(def.code));
  registry.set(key(def.code), {
    ...prev,
    ...def,
    messages: { ...prev?.messages, ...def.messages },
  });
}

add({ code: 'en', messages: en });
// Latin digits by default: numbers, timers and dates stay readable next to the
// (always Latin) phone numbers. Request 'ne-NP-u-nu-deva' for Devanagari digits.
add({ code: 'ne', messages: ne, intlLocale: 'ne-NP-u-nu-latn' });

/**
 * Add a locale, or extend/override messages of an existing one, at runtime.
 * Mounted softphones re-render with the new messages.
 *
 * ```ts
 * registerLocale({ code: 'hi', messages: { 'tab.phone': 'फ़ोन', … } });
 * registerLocale({ code: 'en', messages: { 'tab.contacts': 'Customers' } }); // override
 * ```
 */
export function registerLocale(def: LocaleDefinition): void {
  add(def);
  version++;
  listeners.forEach((l) => l());
}

/** Codes of every registered locale with a complete-enough catalogue to offer in a picker. */
export function registeredLocales(): string[] {
  return [...registry.values()].map((d) => d.code);
}

export function getLocaleDefinition(code: string): LocaleDefinition | undefined {
  return registry.get(key(code));
}

/** @internal change notification for React (useSyncExternalStore). */
export function subscribeLocales(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function localesVersion(): number {
  return version;
}

/** 'ne-NP-u-nu-deva' -> ['ne-NP-u-nu-deva', 'ne-NP', 'ne'] */
function candidates(tag: string): string[] {
  let canonical = tag;
  try {
    canonical = Intl.getCanonicalLocales(tag)[0] ?? tag;
  } catch {
    /* not a valid tag: try it verbatim */
  }
  const base = canonical.split('-u-')[0]!;
  const parts = base.split('-');
  const out = [canonical];
  for (let n = parts.length; n >= 1; n--) out.push(parts.slice(0, n).join('-'));
  return [...new Set(out)];
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  return [...list];
}

export interface ResolvedLocale {
  /** The requested tag that matched (e.g. 'ne-NP'), or 'en'. Used for `lang`. */
  tag: string;
  /** Registered locales merged, most specific first; always ends with 'en'. */
  chain: string[];
  messages: Messages;
  dir: TextDirection;
  intlLocale: string;
}

/**
 * Resolve a requested locale (a tag, a list of tags in preference order, or
 * 'auto' for the browser languages) to merged messages with the fallback
 * chain ne-NP → ne → en.
 */
export function resolveLocale(requested?: string | readonly string[] | null): ResolvedLocale {
  const wanted = (Array.isArray(requested) ? requested : [requested ?? 'en'])
    .flatMap((r: string | null | undefined) => (!r ? [] : r.trim().toLowerCase() === 'auto' ? browserLanguages() : [r.trim()]))
    .filter(Boolean);

  for (const tag of wanted) {
    const chain = candidates(tag)
      .map((c) => registry.get(key(c)))
      .filter((d): d is LocaleDefinition => d !== undefined);
    if (chain.length === 0) continue;
    const codes = [...new Set([...chain.map((d) => d.code), 'en'])];
    const messages = Object.assign(
      {},
      ...codes
        .slice()
        .reverse()
        .map((c) => registry.get(key(c))!.messages),
    ) as Messages;
    const lang = (tag.split('-')[0] ?? 'en').toLowerCase();
    const preferredIntl = chain.find((d) => d.intlLocale)?.intlLocale;
    const intlLocale = tag.includes('-u-') || !preferredIntl ? tag : preferredIntl;
    const dir = chain.find((d) => d.dir)?.dir;
    return {
      tag,
      chain: codes,
      messages,
      dir: dir ?? (RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr'),
      intlLocale: safeIntlLocale(intlLocale),
    };
  }
  return { tag: 'en', chain: ['en'], messages: registry.get('en')!.messages as Messages, dir: 'ltr', intlLocale: 'en' };
}

function safeIntlLocale(tag: string): string {
  try {
    return Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : 'en';
  } catch {
    return 'en';
  }
}
