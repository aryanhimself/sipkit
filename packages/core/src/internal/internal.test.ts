import { describe, expect, it, vi } from 'vitest';
import { applyTechPrefix, normalizeNumber, parseDialString, isSipUri } from './numbers';
import { sortPlugins } from './plugin-host';
import { SnapshotStore } from './store';
import { TimerRegistry } from './timers';
import { CallRegistry } from './call-registry';
import type { SoftphoneSnapshot } from '../types';

describe('numbers', () => {
  it('parses dial strings with post-dial DTMF', () => {
    expect(parseDialString('123,456')).toEqual({ number: '123', postDial: '456' });
    expect(parseDialString('123,,4,5')).toEqual({ number: '123', postDial: '4,5' });
    expect(parseDialString(' 1002 ')).toEqual({ number: '1002', postDial: '' });
    expect(parseDialString('sip:a@b;x=1,2')).toEqual({ number: 'sip:a@b;x=1,2', postDial: '' });
  });

  it('normalizes and prefixes', () => {
    expect(normalizeNumber('+1 (555) 12-34.5/6')).toBe('+1555123456');
    expect(normalizeNumber('sip:x@y')).toBe('sip:x@y');
    expect(applyTechPrefix('100', '9')).toBe('9100');
    expect(applyTechPrefix('9100', '9')).toBe('9100');
    expect(applyTechPrefix('sip:a@b', '9')).toBe('sip:a@b');
    expect(applyTechPrefix('100', '')).toBe('100');
    expect(isSipUri('SIPS:a@b')).toBe(true);
  });
});

describe('sortPlugins', () => {
  const p = (id: string, dependsOn?: string[]) => ({ id, dependsOn, setup: () => ({}) });
  it('orders by dependencies, stable otherwise', () => {
    expect(sortPlugins([p('a'), p('c', ['b']), p('b'), p('d')]).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('throws on duplicates, missing deps and cycles', () => {
    expect(() => sortPlugins([p('a'), p('a')])).toThrow(/Duplicate/);
    expect(() => sortPlugins([p('a', ['z'])])).toThrow(/missing/);
    expect(() => sortPlugins([p('a', ['b']), p('b', ['a'])])).toThrow(/cycle/);
  });
});

describe('SnapshotStore', () => {
  const initial = { app: 'loading', calls: [] } as unknown as SoftphoneSnapshot;
  it('keeps the same reference for no-op updates', () => {
    const onChange = vi.fn();
    const store = new SnapshotStore(initial, onChange);
    const first = store.get();
    store.update({ app: 'loading' });
    expect(store.get()).toBe(first);
    store.update({ app: 'ready' });
    expect(store.get()).not.toBe(first);
    expect(onChange).toHaveBeenCalledOnce();
  });
  it('isolates subscriber errors', () => {
    const store = new SnapshotStore(initial);
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('x');
    });
    store.subscribe(good);
    store.update({ app: 'ready' });
    expect(good).toHaveBeenCalled();
  });
});

describe('TimerRegistry', () => {
  it('replaces keyed timers and clears by prefix', () => {
    vi.useFakeTimers();
    const t = new TimerRegistry();
    const a = vi.fn();
    const b = vi.fn();
    t.set('x:1', 100, a);
    t.set('x:1', 200, b);
    t.set('x:2', 100, a);
    t.clearPrefix('x:2');
    vi.advanceTimersByTime(300);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
    t.set(undefined, 10, a);
    t.clearAll();
    vi.advanceTimersByTime(20);
    expect(a).not.toHaveBeenCalled();
    expect(t.size).toBe(0);
    vi.useRealTimers();
  });
});

describe('CallRegistry', () => {
  it('creates, patches immutably and finalizes once', () => {
    const events = { created: vi.fn(), updated: vi.fn(), ended: vi.fn(), cdr: vi.fn(), listChanged: vi.fn() };
    let now = 1000;
    const reg = new CallRegistry(events, () => '1001', () => now);
    const rec = reg.create({ direction: 'outgoing', state: 'setup', line: 1, remoteNumber: '2' });
    const before = rec.call;
    reg.patch(rec.call.id, { state: 'connected', connectedAt: 2000 });
    expect(before.state).toBe('setup');
    expect(reg.patch(rec.call.id, { state: 'connected' })).toBe(reg.get(rec.call.id)?.call);
    now = 5000;
    reg.finalize(rec.call.id, 'local-hangup');
    expect(reg.finalize(rec.call.id, 'failed')).toBeUndefined();
    expect(events.cdr).toHaveBeenCalledOnce();
    expect(events.cdr.mock.calls[0]?.[0]).toMatchObject({ durationMs: 3000, caller: '1001', called: '2' });
    expect(reg.size).toBe(0);
  });
});
