import type { PresenceInfo, PresenceReport, PresenceState } from '../types';

/*
 * Tolerant, dependency-free parsers for the two NOTIFY bodies used by BLF and
 * presence. They work in browsers, workers and Node (no DOMParser), accept any
 * namespace prefix and never throw: unusable bodies return `undefined`.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Inner XML of the first `<prefix:name ...>...</prefix:name>` element, or undefined. */
function element(xml: string, name: string): { attrs: string; inner: string } | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s>/])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`, 'i');
  const m = re.exec(xml);
  return m ? { attrs: m[1] ?? '', inner: m[2] ?? '' } : undefined;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  const v = m?.[1] ?? m?.[2];
  return v === undefined ? undefined : decodeXml(v);
}

function text(xml: string, name: string): string | undefined {
  const el = element(xml, name);
  if (!el) return undefined;
  const v = decodeXml(el.inner.replace(/<[^>]*>/g, '')).trim();
  return v || undefined;
}

/** User part of a SIP URI ("sip:1002@pbx;transport=ws" → "1002"); other strings unchanged. */
export function userFromUri(uri: string): string {
  const m = /^(?:sips?|tel):([^@;>?]+)/i.exec(uri.trim().replace(/^<|>$/g, ''));
  if (!m?.[1]) return uri.trim();
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

interface ParsedDialog {
  state: string;
  direction?: string;
  held: boolean;
  remoteNumber?: string;
  remoteDisplayName?: string;
}

function parseDialog(attrs: string, inner: string): ParsedDialog {
  const state = (text(inner, 'state') ?? '').toLowerCase();
  const local = element(inner, 'local')?.inner ?? '';
  // RFC 4235 §4.1.6.3 / RFC 3840: +sip.rendering="no" on the local target = held.
  const held = /pname\s*=\s*["']\+sip\.rendering["'][^>]*pvalue\s*=\s*["']no["']/i.test(local);
  const remote = element(inner, 'remote')?.inner;
  const dialog: ParsedDialog = { state, direction: attr(attrs, 'direction')?.toLowerCase(), held };
  if (remote) {
    const identity = element(remote, 'identity');
    const target = element(remote, 'target');
    const uri = identity ? decodeXml(identity.inner).trim() : target ? attr(target.attrs, 'uri') : undefined;
    if (uri) dialog.remoteNumber = userFromUri(uri);
    const display = identity ? attr(identity.attrs, 'display') : undefined;
    if (display?.trim()) dialog.remoteDisplayName = display.trim();
  }
  return dialog;
}

const DIALOG_RANK: Record<PresenceState, number> = { ringing: 4, busy: 3, held: 2, idle: 1, unavailable: 0, unknown: 0 };

function dialogState(d: ParsedDialog): PresenceState {
  switch (d.state) {
    case 'trying':
    case 'proceeding':
    case 'early':
      // Being rung (recipient) vs. dialing out (initiator: shown as busy).
      return d.direction === 'initiator' ? 'busy' : 'ringing';
    case 'confirmed':
      return d.held ? 'held' : 'busy';
    default:
      return 'idle'; // terminated (or unknown) dialogs mean "no call"
  }
}

/**
 * Parse an RFC 4235 `application/dialog-info+xml` body (Asterisk BLF hints).
 * No dialogs / only terminated dialogs = idle. Several dialogs: ringing wins
 * over busy (so a ringing line can be picked up), busy over held.
 */
export function parseDialogInfo(body: string | undefined | null): PresenceReport | undefined {
  if (typeof body !== 'string' || !/<(?:[\w.-]+:)?dialog-info[\s>]/i.test(body)) return undefined;
  const re = /<(?:[\w.-]+:)?dialog(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?dialog\s*>)/gi;
  let best: { state: PresenceState; dialog?: ParsedDialog } = { state: 'idle' };
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const dialog = parseDialog(m[1] ?? '', m[2] ?? '');
    const state = dialogState(dialog);
    if (DIALOG_RANK[state] > DIALOG_RANK[best.state]) best = { state, dialog };
  }
  const report: PresenceReport = { state: best.state };
  const d = best.dialog;
  if (d && best.state !== 'idle') {
    if (d.direction === 'recipient') report.direction = 'incoming';
    else if (d.direction === 'initiator') report.direction = 'outgoing';
    if (d.remoteNumber) report.remoteNumber = d.remoteNumber;
    if (d.remoteDisplayName) report.remoteDisplayName = d.remoteDisplayName;
  }
  return report;
}

/**
 * Parse an RFC 3863 `application/pidf+xml` body (with the RPID / data-model
 * extensions Asterisk uses): `closed` = unavailable, `on-the-phone` = busy,
 * notes "Ringing" / "On hold" = ringing / held, otherwise idle.
 */
export function parsePidf(body: string | undefined | null): PresenceReport | undefined {
  if (typeof body !== 'string' || !/<(?:[\w.-]+:)?presence[\s>]/i.test(body)) return undefined;
  const basic = text(body, 'basic')?.toLowerCase();
  const note = text(body, 'note');
  const onThePhone = /<(?:[\w.-]+:)?on-the-phone[\s/>]/i.test(body);
  let state: PresenceState;
  if (basic === 'closed') state = 'unavailable';
  else if (note && /ring/i.test(note)) state = 'ringing';
  else if (note && /hold/i.test(note)) state = 'held';
  else if (onThePhone || /<(?:[\w.-]+:)?busy[\s/>]/i.test(body) || (note && /on the phone|in use|busy/i.test(note)))
    state = 'busy';
  else if (basic === 'open' || note) state = 'idle';
  else return undefined;
  const report: PresenceReport = { state };
  if (note) report.note = note;
  return report;
}

/**
 * Merge what the dialog and presence packages said about one extension.
 * Call activity from dialog-info wins; PIDF supplies `unavailable` and notes.
 */
export function combinePresence(dialog?: PresenceReport, presence?: PresenceReport): PresenceReport {
  if (!dialog && !presence) return { state: 'unknown' };
  const note = presence?.note;
  const withNote = (r: PresenceReport): PresenceReport => (note && !r.note ? { ...r, note } : r);
  if (dialog && ['ringing', 'busy', 'held'].includes(dialog.state)) return withNote(dialog);
  if (presence && presence.state !== 'unknown' && (!dialog || dialog.state === 'unknown' || presence.state !== 'idle'))
    return presence;
  return withNote(dialog ?? { state: 'unknown' });
}

export function samePresence(a: PresenceInfo | undefined, b: PresenceInfo | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.state === b.state &&
    a.remoteNumber === b.remoteNumber &&
    a.remoteDisplayName === b.remoteDisplayName &&
    a.direction === b.direction &&
    a.note === b.note &&
    a.errorCode === b.errorCode
  );
}
