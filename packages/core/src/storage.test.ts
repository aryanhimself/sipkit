import { describe, expect, it } from 'vitest';
import { createMemoryStorage, createPluginStorage, getDefaultStorage, type StorageLike } from './storage';

describe('plugin storage', () => {
  it('namespaces and JSON-serialises values', () => {
    const backend = createMemoryStorage();
    const s = createPluginStorage('app:p', backend);
    s.set('k', { a: 1 });
    expect(backend.getItem('app:p:k')).toBe('{"a":1}');
    expect(s.get<{ a: number }>('k')).toEqual({ a: 1 });
    s.remove('k');
    expect(s.get('k')).toBeUndefined();
  });

  it('survives corrupt data and throwing backends', () => {
    const backend = createMemoryStorage();
    backend.setItem('p:bad', '{not json');
    const s = createPluginStorage('p', backend);
    expect(s.get('bad')).toBeUndefined();
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const t = createPluginStorage('p', throwing);
    expect(() => t.set('a', 1)).not.toThrow();
    expect(t.get('a')).toBeUndefined();
    expect(() => t.remove('a')).not.toThrow();
  });

  it('getDefaultStorage returns a working storage', () => {
    const s = getDefaultStorage();
    s.setItem('x', '1');
    expect(s.getItem('x')).toBe('1');
    s.removeItem('x');
  });
});
