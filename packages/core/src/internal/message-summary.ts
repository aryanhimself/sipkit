import type { MessageSummary } from '../types';

/** The empty state: no messages. */
export const EMPTY_MESSAGE_SUMMARY: Readonly<MessageSummary> = Object.freeze({
  waiting: false,
  new: 0,
  old: 0,
  urgentNew: 0,
  urgentOld: 0,
});

const COUNTS = /^(\d+)\s*\/\s*(\d+)(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/;

/**
 * Parse an RFC 3842 `application/simple-message-summary` body:
 *
 * ```
 * Messages-Waiting: yes
 * Message-Account: sip:*97@pbx.example.com
 * Voice-Message: 2/8 (1/0)
 * ```
 *
 * Header names are case-insensitive, unknown lines (other message classes,
 * the optional message headers section) are ignored. Returns `undefined` when
 * the body carries neither `Messages-Waiting` nor `Voice-Message`.
 */
export function parseMessageSummary(body: string | undefined | null): MessageSummary | undefined {
  if (typeof body !== 'string' || !body.trim()) return undefined;
  let waiting: boolean | undefined;
  let account: string | undefined;
  let counts: [number, number, number, number] | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (name === 'messages-waiting') {
      waiting = value.toLowerCase() === 'yes';
    } else if (name === 'message-account') {
      if (value) account = value.replace(/^<(.*)>$/, '$1');
    } else if (name === 'voice-message') {
      const m = COUNTS.exec(value);
      if (m) counts = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    }
  }
  if (waiting === undefined && !counts) return undefined;
  const [fresh, old, urgentNew, urgentOld] = counts ?? [0, 0, 0, 0];
  const summary: MessageSummary = {
    waiting: waiting ?? fresh > 0,
    new: fresh,
    old,
    urgentNew,
    urgentOld,
  };
  if (account) summary.account = account;
  return summary;
}

/** User part of a `Message-Account` URI ("sip:*97@pbx" → "*97"), or undefined. */
export function voicemailNumberFromAccount(account: string | undefined): string | undefined {
  if (!account) return undefined;
  const m = /^sips?:([^@;>]+)@/i.exec(account.trim());
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

export function sameSummary(a: MessageSummary, b: MessageSummary): boolean {
  return (
    a.waiting === b.waiting &&
    a.new === b.new &&
    a.old === b.old &&
    a.urgentNew === b.urgentNew &&
    a.urgentOld === b.urgentOld &&
    a.account === b.account
  );
}
