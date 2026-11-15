/**
 * Phone numbers from links (`tel:`, `sip:`, `sips:`, `callto:`) and selected
 * text, for click-to-call, the context menu and the omnibox.
 */

const LINK_SCHEMES = ['tel:', 'sip:', 'sips:', 'callto:'] as const;

export function isDialLink(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return LINK_SCHEMES.some((s) => lower.startsWith(s));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Digits, a leading +, * and # (visual separators removed). Empty when it does not look like a number. */
export function normalizePhoneNumber(raw: string): string {
  const text = raw.trim();
  if (!text || text.length > 64) return '';
  // Only digits, separators and the dial symbols are allowed.
  if (!/^\+?[\d\s().\-/*#]+$/.test(text)) return '';
  const plus = text.startsWith('+');
  const core = text.replace(/[^\d*#]/g, '');
  const digits = core.replace(/[*#]/g, '');
  if (digits.length < 2 || core.length > 32) return '';
  return (plus ? '+' : '') + core;
}

/**
 * Number or SIP address from a dial link. `tel:+1-555-0100;ext=12` → `+15550100`,
 * `sip:1002@pbx.example.com` → `sip:1002@pbx.example.com`, `callto://5550100` → `5550100`.
 */
export function parseDialLink(href: string): string | null {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sip:') || lower.startsWith('sips:')) {
    const scheme = lower.startsWith('sips:') ? 'sips:' : 'sip:';
    const rest = safeDecode(trimmed.slice(scheme.length)).split(/[?;]/)[0] ?? '';
    if (!/^[A-Za-z0-9._~+*#!$&'()=,-]+(@[A-Za-z0-9.-]+(:\d{1,5})?)?$/.test(rest)) return null;
    if (!rest.includes('@')) return normalizePhoneNumber(rest) || (/^[A-Za-z0-9._-]{1,64}$/.test(rest) ? rest : null);
    return `${scheme}${rest}`;
  }
  let rest: string;
  if (lower.startsWith('tel:')) rest = trimmed.slice(4);
  else if (lower.startsWith('callto:')) rest = trimmed.slice(7).replace(/^\/\//, '');
  else return null;
  rest = safeDecode(rest).split(/[;?]/)[0] ?? '';
  return normalizePhoneNumber(rest) || null;
}

/** A dialable number inside selected text (first plausible match), or null. */
export function parsePhoneFromText(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 200) return null;
  if (isDialLink(t)) return parseDialLink(t);
  const direct = normalizePhoneNumber(t);
  if (direct) return direct;
  const match = /\+?\d[\d\s().\-/]{1,30}\d/.exec(t);
  return match ? normalizePhoneNumber(match[0]) || null : null;
}
