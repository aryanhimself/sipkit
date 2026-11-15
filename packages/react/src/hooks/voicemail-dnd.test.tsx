import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Cdr } from 'sipkit-core';
import { SoftphoneProvider } from '../context';
import { MockSoftphone } from '../testing/mock-softphone';
import { useVoicemail } from './use-voicemail';
import { useDnd } from './use-dnd';

function phone(config: ConstructorParameters<typeof MockSoftphone>[0] = {}) {
  return new MockSoftphone(
    {
      username: '1001',
      password: 'secret',
      websocketUrls: ['wss://pbx.example.com/ws'],
      ...config,
    },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 20 },
  );
}

const wrap = (p: MockSoftphone) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={p}>{children}</SoftphoneProvider>;
  };

describe('useVoicemail', () => {
  it('is disabled by default and when the feature is switched off', () => {
    const { result } = renderHook(() => useVoicemail(), { wrapper: wrap(phone()) });
    expect(result.current).toMatchObject({ enabled: false, new: 0, number: undefined });
    const off = phone({ voicemail: { enabled: true }, disabledFeatures: ['VOICEMAIL'] });
    expect(renderHook(() => useVoicemail(), { wrapper: wrap(off) }).result.current.enabled).toBe(
      false,
    );
  });

  it('tracks counts, falls back to Message-Account and dials voicemail', async () => {
    const p = phone({ voicemail: { enabled: true } });
    const { result } = renderHook(() => useVoicemail(), { wrapper: wrap(p) });
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    act(() => p.simulateVoicemail({ new: 3, old: 1, account: 'sip:*97@pbx' }));
    expect(result.current).toMatchObject({
      enabled: true,
      waiting: true,
      new: 3,
      old: 1,
      number: '*97',
    });
    await act(async () => {
      await result.current.call();
    });
    expect(p.getSnapshot().calls[0]?.remoteNumber).toBe('*97');
  });
});

describe('useDnd', () => {
  it('toggles DND and the mock rejects incoming calls while on', async () => {
    const p = phone();
    const cdrs: Cdr[] = [];
    p.on('cdr', (c) => cdrs.push(c));
    const { result } = renderHook(() => useDnd(), { wrapper: wrap(p) });
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    expect(result.current.dnd).toBe(false);
    act(() => {
      void result.current.toggle();
    });
    expect(result.current.dnd).toBe(true);
    expect(p.simulateIncomingCall('1002')).toBeUndefined();
    expect(cdrs[0]).toMatchObject({ reason: 'dnd', code: 486, caller: '1002' });
    act(() => {
      void result.current.setDnd(false);
    });
    expect(result.current.dnd).toBe(false);
    expect(p.simulateIncomingCall('1002')).toBeDefined();
  });

  it('server mode: pending while the feature code runs, reverts on failure, PBX swallows calls', async () => {
    const p = phone({ dnd: { mode: 'server' } });
    const cdrs: Cdr[] = [];
    p.on('cdr', (c) => cdrs.push(c));
    const { result } = renderHook(() => useDnd(), { wrapper: wrap(p) });
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    expect(result.current.server).toBe(true);

    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.toggle();
    });
    expect(result.current).toMatchObject({ dnd: true, pending: true });
    await act(async () => {
      await done;
    });
    expect(result.current).toMatchObject({ dnd: true, pending: false });
    // The PBX answers busy: no INVITE, no CDR in the browser.
    expect(p.simulateIncomingCall('1002')).toBeUndefined();
    expect(cdrs).toHaveLength(0);

    p.failNextServerDnd();
    await act(async () => {
      await result.current.setDnd(false); // never rejects; reverts
    });
    expect(result.current).toMatchObject({ dnd: true, pending: false });
  });
});
