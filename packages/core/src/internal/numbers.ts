/** Number / dial-string helpers used by the Softphone orchestrator. */

/** Valid DTMF characters ("," = 2 second pause where the engine supports it). */
export const DTMF_PATTERN = /^[0-9A-D*#,]+$/i;

/** True for full SIP(S) URIs, which must never be normalised or prefixed. */
export function isSipUri(value: string): boolean {
  return /^sips?:/i.test(value.trim());
}

/**
 * Split "123,456" into the number to dial and digits to send as DTMF once
 * connected. Only the first comma separates; further commas become pauses.
 * SIP URIs are returned untouched (commas are legal in URI params).
 */
export function parseDialString(input: string): { number: string; postDial: string } {
  const trimmed = input.trim();
  if (isSipUri(trimmed)) return { number: trimmed, postDial: '' };
  const idx = trimmed.indexOf(',');
  if (idx < 0) return { number: trimmed, postDial: '' };
  const postDial = trimmed
    .slice(idx + 1)
    .replace(/^,+/, '')
    .replace(/\s+/g, '');
  return { number: trimmed.slice(0, idx).trim(), postDial };
}

/**
 * Strip visual separators: spaces, dashes, dots, brackets, slashes.
 * A leading "+" is preserved. SIP URIs are returned untouched.
 */
export function normalizeNumber(value: string): string {
  if (isSipUri(value)) return value.trim();
  return value.replace(/[\s\-().[\]/]/g, '');
}

/** Prepend the tech prefix unless empty, already present, or a SIP URI. */
export function applyTechPrefix(value: string, prefix: string, minDigits = 0): string {
  // No "already starts with the prefix" shortcut: with prefix 9, 98xxxxxxxx is a
  // number that genuinely starts with 9 and still needs the prefix.
  if (!prefix || isSipUri(value)) return value;
  if (minDigits > 0 && value.replace(/\D/g, '').length < minDigits) return value;
  return prefix + value;
}
