import type { PluginStorage } from './plugin';

/** Subset of the Web Storage API the softphone needs (localStorage-compatible). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory StorageLike, used when localStorage is unavailable (SSR, privacy mode, tests). */
export function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * Returns `window.localStorage` when it exists and is writable, otherwise an
 * in-memory fallback. Accessing localStorage can throw (blocked cookies), so
 * the probe is wrapped.
 */
export function getDefaultStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls) {
      const probe = '__sipkit_softphone_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* fall through to memory */
  }
  return createMemoryStorage();
}

/**
 * A namespaced, JSON-serialising PluginStorage on top of a StorageLike.
 * Keys are stored as `<prefix>:<key>`. Read/write failures (quota, corrupt
 * JSON) are swallowed so a plugin can never crash the phone through storage.
 */
export function createPluginStorage(
  prefix: string,
  backend: StorageLike = getDefaultStorage(),
): PluginStorage {
  const full = (key: string) => `${prefix}:${key}`;
  return {
    get<T>(key: string): T | undefined {
      try {
        const raw = backend.getItem(full(key));
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      try {
        backend.setItem(full(key), JSON.stringify(value));
      } catch {
        /* quota exceeded or storage blocked */
      }
    },
    remove(key: string): void {
      try {
        backend.removeItem(full(key));
      } catch {
        /* ignore */
      }
    },
  };
}

/** Convenience: a localStorage-backed PluginStorage with in-memory fallback. */
export function createLocalPluginStorage(prefix: string): PluginStorage {
  return createPluginStorage(prefix, getDefaultStorage());
}
