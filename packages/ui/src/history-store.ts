import type { Cdr, SoftphoneApi } from 'sipkit-core';

export interface HistoryStore {
  getSnapshot(): Cdr[];
  subscribe(listener: () => void): () => void;
  clear(): void;
  dispose(): void;
}

const MAX = 200;

function readStorage(key: string): Cdr[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Cdr[]) : [];
  } catch {
    return [];
  }
}

function writeStorage(key: string, items: Cdr[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(items));
  } catch {
    /* storage full / blocked */
  }
}

/**
 * Fallback call history used when no `call-history` plugin is installed:
 * records `cdr` events (newest first) and persists them to localStorage.
 */
export function createHistoryStore(api: SoftphoneApi, storageKey: string | null): HistoryStore {
  let items = storageKey ? readStorage(storageKey) : [];
  const listeners = new Set<() => void>();
  const emit = () => {
    if (storageKey) writeStorage(storageKey, items);
    for (const l of [...listeners]) l();
  };
  const off = api.on('cdr', (cdr) => {
    if (items.some((c) => c.callId === cdr.callId)) return;
    items = [cdr, ...items].slice(0, MAX);
    emit();
  });
  return {
    getSnapshot: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      items = [];
      emit();
    },
    dispose() {
      off();
      listeners.clear();
    },
  };
}
