import type { Cdr } from 'sipkit-core';
import type { Contact } from '@/extensions';

/** One autocomplete entry for the dialer. */
export interface DialSuggestion {
  /** The number to put in the dial field. */
  number: string;
  /** Contact name, when the number belongs to a contact. */
  name?: string;
  /** Contact description (company, department). */
  description?: string;
  /** Where it came from. A contact that you also called shows as 'contact'. */
  source: 'contact' | 'recent';
  /** Calls to or from this number in history. */
  calls: number;
  /** Epoch ms of the most recent call, if any. */
  lastCallAt?: number;
}

export interface SuggestionOptions {
  /** Maximum entries returned. Default 5. */
  limit?: number;
  /** Your own extension: never suggested. */
  self?: string;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** The number of the other party in a call record. */
export function cdrPeer(cdr: Cdr): string {
  return cdr.direction === 'outgoing' ? cdr.called : cdr.caller;
}

/**
 * Rank numbers from call history and contacts against what is typed in the dialer.
 *
 * Matching uses digits only, so "984 247" finds "9842477272". Letters (when the
 * dial field holds a SIP user or URI) match the number text or the contact name.
 * Ranking: numbers that start with the query come first, then numbers that
 * contain it, then contacts whose name matches; within each group, more calls
 * and more recent calls rank higher. An exact match of the query is left out,
 * since there is nothing to complete.
 */
export function buildDialSuggestions(
  query: string,
  history: readonly Cdr[],
  contacts: readonly Contact[],
  options: SuggestionOptions = {},
): DialSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 5;
  const qDigits = digits(q);
  const qText = q.toLowerCase();
  const textQuery = /[a-z@:]/i.test(q);

  // Merge history and contacts by their digit key (or raw text for SIP users).
  const byKey = new Map<string, DialSuggestion>();
  const keyOf = (n: string) => digits(n) || n.toLowerCase();
  const contactFor = new Map<string, Contact>();
  for (const c of contacts) if (c.number) contactFor.set(keyOf(c.number), c);

  for (const cdr of history) {
    const number = cdrPeer(cdr);
    if (!number) continue;
    const key = keyOf(number);
    const entry = byKey.get(key);
    if (entry) {
      entry.calls += 1;
      entry.lastCallAt = Math.max(entry.lastCallAt ?? 0, cdr.startedAt);
    } else {
      byKey.set(key, { number, source: 'recent', calls: 1, lastCallAt: cdr.startedAt });
    }
  }
  for (const [key, c] of contactFor) {
    const entry = byKey.get(key);
    if (entry) Object.assign(entry, { number: c.number, name: c.name, description: c.description, source: 'contact' });
    else byKey.set(key, { number: c.number, name: c.name, description: c.description, source: 'contact', calls: 0 });
  }

  const self = options.self ? keyOf(options.self) : undefined;
  const scored: { s: DialSuggestion; rank: number }[] = [];
  for (const [key, s] of byKey) {
    if (key === self) continue;
    const nDigits = digits(s.number);
    const nText = s.number.toLowerCase();
    let rank = -1;
    if (qDigits && !textQuery) {
      if (nDigits === qDigits) continue; // already typed in full
      if (nDigits.startsWith(qDigits)) rank = 0;
      else if (qDigits.length >= 3 && nDigits.includes(qDigits)) rank = 1;
    } else {
      if (nText === qText) continue;
      if (nText.startsWith(qText)) rank = 0;
      else if (nText.includes(qText)) rank = 1;
      else if (s.name?.toLowerCase().includes(qText)) rank = 2;
    }
    if (rank >= 0) scored.push({ s, rank });
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.s.calls - a.s.calls ||
      (b.s.lastCallAt ?? 0) - (a.s.lastCallAt ?? 0) ||
      (a.s.name ?? a.s.number).localeCompare(b.s.name ?? b.s.number),
  );
  return scored.slice(0, limit).map((x) => x.s);
}
