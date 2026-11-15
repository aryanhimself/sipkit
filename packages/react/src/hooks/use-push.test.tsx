import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePushPlatform } from 'sipkit-core/testing';
import { SoftphoneProvider } from '../context';
import { MockSoftphone } from '../testing/mock-softphone';
import { usePush } from './use-push';

const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function phone(platform: FakePushPlatform | null, push: Record<string, unknown> = { enabled: true, serviceUrl: 'https://push.test', token: 't', vapidPublicKey: VAPID }) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], push },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 20, pushPlatform: platform },
  );
}

const wrap = (p: MockSoftphone) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={p}>{children}</SoftphoneProvider>;
  };

afterEach(() => vi.unstubAllGlobals());

describe('usePush', () => {
  it('is unavailable without platform support, config or with the feature disabled', () => {
    expect(renderHook(() => usePush(), { wrapper: wrap(phone(null)) }).result.current).toMatchObject({ available: false, permission: 'unsupported' });
    expect(renderHook(() => usePush(), { wrapper: wrap(phone(new FakePushPlatform(), { enabled: false })) }).result.current.available).toBe(false);
    const off = new MockSoftphone({ push: { enabled: true }, disabledFeatures: ['PUSH'] }, { pushPlatform: new FakePushPlatform() });
    expect(renderHook(() => usePush(), { wrapper: wrap(off) }).result.current.available).toBe(false);
  });

  it('subscribes, toggles off and answers the clicked call in the mock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201 })));
    const platform = new FakePushPlatform();
    const p = phone(platform);
    const { result } = renderHook(() => usePush(), { wrapper: wrap(p) });
    expect(result.current).toMatchObject({ available: true, permission: 'default', subscribed: false });
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current).toMatchObject({ permission: 'granted', subscribed: true });
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.subscribed).toBe(false);

    await p.start();
    await waitFor(() => expect(p.getSnapshot().registration.state).toBe('registered'));
    act(() => p.simulatePushLaunch({ action: 'answer', pushCallId: 'pbx-1' }));
    expect(result.current.pending).toMatchObject({ pushCallId: 'pbx-1' });
    act(() => void p.simulateIncomingCall('1002', undefined, { pushId: 'pbx-1' }));
    await waitFor(() => expect(p.getSnapshot().calls[0]?.state).toBe('connected'));
    expect(result.current.pending).toBeUndefined();
    await p.destroy();
  });
});
