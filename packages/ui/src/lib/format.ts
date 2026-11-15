import type { Call } from 'sipkit-core';

/** Initials for an avatar: "Jane Doe" -> "JD", "1002" -> "#". */
export function initials(name: string | undefined): string {
  if (!name) return '#';
  const words = name.trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return '#';
  const first = words[0]![0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Light formatting of a dialed number for display. Leaves SIP URIs/extensions untouched. */
export function formatNumber(number: string): string {
  const n = number.replace(/^sip:/i, '');
  if (/^\+?\d{10,}$/.test(n)) {
    const plus = n.startsWith('+') ? '+' : '';
    const digits = n.replace(/^\+/, '');
    return plus + digits.replace(/(\d{3})(?=\d{4,})/g, '$1 ').trim();
  }
  return n;
}

/** Keep characters valid in a dial string (digits, DTMF, letters for SIP users, URI chars). */
export function sanitizeDialInput(value: string): string {
  return value.replace(/[^0-9a-zA-Z*#+,@._:-]/g, '');
}

/** Clean pasted text: strip phone formatting (spaces, dashes, brackets, dots) unless it's a SIP URI. */
export function sanitizePastedNumber(text: string): string {
  const t = text.trim().replace(/^tel:/i, '');
  if (t.includes('@')) return sanitizeDialInput(t.replace(/\s+/g, ''));
  return sanitizeDialInput(t.replace(/[\s()\-.\u00a0\u2011]/g, ''));
}

export function callTitle(call: Pick<Call, 'remoteDisplayName' | 'remoteNumber'>, contactName?: string): string {
  return call.remoteDisplayName || contactName || formatNumber(call.remoteNumber);
}

// ---------------------------------------------------------------------------
// Locale-aware formatting (Intl). `locale` is an Intl locale such as 'en',
// 'ne-NP-u-nu-latn' or 'ne-NP-u-nu-deva'. Formatters are cached.
// ---------------------------------------------------------------------------

const formatters = new Map<string, unknown>();
function cached<T>(key: string, make: () => T, fallback: () => T): T {
  let f = formatters.get(key) as T | undefined;
  if (!f) {
    try {
      f = make();
    } catch {
      f = fallback();
    }
    formatters.set(key, f);
  }
  return f;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  return cached(
    `n|${locale}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(locale, options),
    () => new Intl.NumberFormat('en', options),
  );
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(
    `d|${locale}|${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
    () => new Intl.DateTimeFormat('en', options),
  );
}

/** Locale number: 1234.5 -> "1,234.5" (en), "१,२३४.५" (ne-NP-u-nu-deva). */
export function formatLocaleNumber(value: number, locale = 'en', options?: Intl.NumberFormatOptions): string {
  return numberFormat(locale, options).format(value);
}

/** Call timer "m:ss" / "h:mm:ss" with digits in the locale's numbering system. */
export function formatDuration(ms: number, locale = 'en'): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const plain = numberFormat(locale, { useGrouping: false });
  const two = numberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return h > 0 ? `${plain.format(h)}:${two.format(m)}:${two.format(s)}` : `${plain.format(m)}:${two.format(s)}`;
}

/** Wall-clock time in the locale, e.g. "2:05 PM". */
export function formatTime(epochMs: number, locale = 'en'): string {
  return dateFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(epochMs));
}

/** Time for today, "Yesterday" (Intl.RelativeTimeFormat), or a short date like "Mar 3". */
export function formatWhen(epochMs: number, now = Date.now(), locale = 'en'): string {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (epochMs >= startOfToday) return formatTime(epochMs, locale);
  if (epochMs >= startOfToday - 86_400_000) {
    const rtf = cached(
      `r|${locale}`,
      () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
      () => new Intl.RelativeTimeFormat('en', { numeric: 'auto' }),
    );
    const text = rtf.format(-1, 'day');
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  }
  return dateFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(epochMs));
}
