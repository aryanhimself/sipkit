import { definePlugin } from '../plugin';
import type { Cdr, Unsubscribe } from '../types';

export interface CallHistoryOptions {
  /** Maximum records kept (oldest dropped first). Default 200. */
  max?: number;
}

/** Public API of the call history plugin: `softphone.plugin<CallHistoryApi>('call-history')`. */
export interface CallHistoryApi {
  /** Records, newest first. */
  list(): Cdr[];
  /** Remove one record by callId. */
  remove(callId: string): void;
  clear(): void;
  /** Notified with the new list after every change. */
  onChange(listener: (records: Cdr[]) => void): Unsubscribe;
}

const KEY = 'records';

/** Persists every CDR to plugin storage (localStorage by default), capped at `max`. */
export function callHistoryPlugin(options: CallHistoryOptions = {}) {
  const max = Math.max(1, options.max ?? 200);
  return definePlugin<CallHistoryApi>({
    id: 'call-history',
    setup({ api, storage }) {
      const stored = storage.get<Cdr[]>(KEY);
      let records: Cdr[] = Array.isArray(stored) ? stored.slice(0, max) : [];
      const listeners = new Set<(records: Cdr[]) => void>();
      const commit = (next: Cdr[]) => {
        records = next;
        storage.set(KEY, records);
        for (const l of [...listeners]) l(records);
      };
      const off = api.on('cdr', (cdr) => {
        commit([cdr, ...records.filter((r) => r.callId !== cdr.callId)].slice(0, max));
      });
      return {
        api: {
          list: () => records,
          remove: (callId) => commit(records.filter((r) => r.callId !== callId)),
          clear: () => commit([]),
          onChange: (listener) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
        },
        dispose: () => {
          off();
          listeners.clear();
        },
      };
    },
  });
}
