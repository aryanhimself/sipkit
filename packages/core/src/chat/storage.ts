import { getDefaultStorage, type StorageLike } from '../storage';
import type { ChatConversation, ChatHistoryStorage } from './types';

/** Chat history kept in memory only (the default): lost on reload. */
export function createMemoryChatStorage(): ChatHistoryStorage {
  const map = new Map<string, ChatConversation[]>();
  return {
    load: (account) => map.get(account),
    save: (account, conversations) => void map.set(account, conversations),
    clear: (account) => void map.delete(account),
  };
}

/**
 * Chat history in localStorage (or any {@link StorageLike}), one JSON entry per
 * account under `<prefix>:<account>`. Quota / parse errors are swallowed.
 */
export function createLocalChatStorage(
  backend: StorageLike = getDefaultStorage(),
  prefix = 'sipkit:chat',
): ChatHistoryStorage {
  const key = (account: string) => `${prefix}:${account}`;
  return {
    load(account) {
      try {
        const raw = backend.getItem(key(account));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as ChatConversation[]) : undefined;
      } catch {
        return undefined;
      }
    },
    save(account, conversations) {
      try {
        backend.setItem(key(account), JSON.stringify(conversations));
      } catch {
        /* quota exceeded or storage blocked */
      }
    },
    clear(account) {
      try {
        backend.removeItem(key(account));
      } catch {
        /* ignore */
      }
    },
  };
}
