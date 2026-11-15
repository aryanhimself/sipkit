import { en, type Messages } from './en';
import type { LocaleDefinition } from './locales';

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * Accent the literal text of an ICU-lite message, leaving argument names and
 * plural/select keywords alone (they sit at odd brace depths), and bracket it
 * so truncation and concatenation bugs are visible.
 */
export function pseudoMessage(message: string): string {
  let depth = 0;
  let out = '';
  for (const ch of message) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    out += depth % 2 === 0 && ch !== '}' ? (ACCENTS[ch] ?? ch) : ch;
  }
  return `[${out}]`;
}

/**
 * A pseudo-locale for testing layout: 'en-XA' (accented, LTR) or, with
 * `rtl: true`, 'ar-XB' (accented, right-to-left). Not registered by default:
 * `registerLocale(createPseudoLocale({ rtl: true }))`.
 */
export function createPseudoLocale({ rtl = false }: { rtl?: boolean } = {}): LocaleDefinition {
  const messages = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, pseudoMessage(v)])) as unknown as Messages;
  return { code: rtl ? 'ar-XB' : 'en-XA', messages, dir: rtl ? 'rtl' : 'ltr', intlLocale: 'en' };
}
