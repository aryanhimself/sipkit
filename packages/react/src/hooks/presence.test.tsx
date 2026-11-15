import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SoftphoneProvider } from '../context';
import { MockSoftphone } from '../testing/mock-softphone';
import { usePresence, usePresenceOf } from './use-presence';

function phone(config: ConstructorParameters<typeof MockSoftphone>[0] = {}) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], ...config },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 20 },
  );
}

const wrap = (p: MockSoftphone) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={p}>{children}</SoftphoneProvider>;
  };

describe('usePresence', () => {
  it('is disabled by default', () => {
    const { result } = renderHook(() => usePresence(), { wrapper: wrap(phone()) });
    expect(result.current).toMatchObject({ enabled: false, list: [], own: 'available' });
    const off = phone({ presence: { enabled: true }, disabledFeatures: ['PRESENCE'] });
    expect(renderHook(() => usePresence(), { wrapper: wrap(off) }).result.current.enabled).toBe(false);
  });

  it('tracks watched extensions, own DND state and picks up', async () => {
    const p = phone({ presence: { enabled: true, watch: ['1002'] } });
    const { result } = renderHook(() => ({ all: usePresence(), one: usePresenceOf('1002') }), {
      wrapper: wrap(p),
    });
    await waitFor(() => expect(result.current.one?.state).toBe('idle'));
    act(() => result.current.all.watch('1003'));
    expect(result.current.all.list.map((x) => x.target)).toEqual(['1002', '1003']);
    act(() => p.simulatePresence('1002', 'ringing', { remoteNumber: '5550100' }));
    expect(result.current.one).toMatchObject({ state: 'ringing', remoteNumber: '5550100' });
    await act(async () => {
      await result.current.all.pickup('1002');
    });
    expect(p.getSnapshot().calls[0]?.remoteNumber).toBe('**1002');
    expect(result.current.one?.state).toBe('idle');
    act(() => result.current.all.unwatch('1003'));
    expect(Object.keys(result.current.all.presence)).toEqual(['1002']);
    act(() => {
      void p.setDnd(true);
    });
    expect(result.current.all.own).toBe('dnd');
  });
});
