import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from 'sipkit-core';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';
import { useRegistration } from './use-registration';
import { useCalls, useIncomingCalls } from './use-calls';
import { useActiveCall } from './use-active-call';
import { formatDuration, useCallTimer } from './use-call-timer';
import { useDevices } from './use-devices';
import { useSoftphoneEvent } from './use-softphone-event';
import { usePlugin } from './use-plugin';
import { shallowEqual } from '../equality';
import { createPhone, wrapperFor } from '../test-utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('useSoftphone', () => {
  it('returns the instance from the provider', () => {
    const phone = createPhone();
    const { result } = renderHook(() => useSoftphone(), { wrapper: wrapperFor(phone) });
    expect(result.current).toBe(phone);
  });

  it('throws outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useSoftphone())).toThrow(/SoftphoneProvider/);
    spy.mockRestore();
  });
});

describe('useSoftphoneSnapshot', () => {
  it('returns the whole snapshot without selector', async () => {
    const phone = createPhone();
    const { result } = renderHook(() => useSoftphoneSnapshot(), { wrapper: wrapperFor(phone) });
    expect(result.current.engine).toBe('mock');
    await waitFor(() => expect(result.current.registration.state).toBe('registered'));
  });

  it('only re-renders when the selected slice changes', async () => {
    const phone = createPhone();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useSoftphoneSnapshot((s) => s.devices.available.map((d) => d.id), shallowEqual);
      },
      { wrapper: wrapperFor(phone) },
    );
    await waitFor(() => expect(phone.getSnapshot().registration.state).toBe('registered'));
    const before = renders;
    const first = result.current;
    await act(() => phone.updateConfig({ brandName: 'X' }));
    expect(renders).toBe(before);
    expect(result.current).toBe(first);
  });
});

describe('useRegistration', () => {
  it('tracks registration progress and failures', async () => {
    const phone = createPhone({ registerDelayMs: 300 });
    const { result } = renderHook(() => useRegistration(), { wrapper: wrapperFor(phone) });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    await waitFor(() => expect(result.current.isRegistered).toBe(true));

    await act(() => phone.updateConfig({ password: 'wrong' }));
    await waitFor(() => expect(result.current.state).toBe('failed'));
    expect(result.current.code).toBe(403);
  });
});

describe('useCalls / useActiveCall / useIncomingCalls', () => {
  it('reflects outgoing and incoming calls', async () => {
    const phone = createPhone();
    const { result } = renderHook(
      () => ({ calls: useCalls(), active: useActiveCall(), incoming: useIncomingCalls() }),
      { wrapper: wrapperFor(phone) },
    );
    await waitFor(() => expect(phone.getSnapshot().registration.state).toBe('registered'));

    await act(async () => {
      await phone.call('1002');
    });
    expect(result.current.calls).toHaveLength(1);
    expect(result.current.active?.remoteNumber).toBe('1002');
    await waitFor(() => expect(result.current.active?.state).toBe('connected'));

    act(() => {
      phone.simulateIncomingCall('5551234', 'Alice');
    });
    expect(result.current.incoming).toHaveLength(1);
    expect(result.current.calls.map((c) => c.line)).toEqual([1, 2]);

    await act(() => phone.answer(result.current.incoming[0]!.id));
    expect(result.current.active?.remoteNumber).toBe('5551234');
    expect(result.current.calls.find((c) => c.remoteNumber === '1002')?.state).toBe('held');

    await act(() => phone.hangupAll());
    expect(result.current.calls).toHaveLength(0);
    expect(result.current.active).toBeNull();
  });
});

describe('useCallTimer', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('ticks while connected', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { result, rerender } = renderHook(({ call }) => useCallTimer(call), {
      initialProps: { call: { state: 'connected' as const, connectedAt: start } },
    });
    expect(result.current.formatted).toBe('0:00');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.seconds).toBe(3);
    expect(result.current.running).toBe(true);
    rerender({ call: { state: 'connected', connectedAt: start, endedAt: start + 5000 } as never });
    expect(result.current.formatted).toBe('0:05');
    expect(result.current.running).toBe(false);
  });

  it('is zero without a connected call', () => {
    const { result } = renderHook(() => useCallTimer(null));
    expect(result.current.elapsedMs).toBe(0);
  });
});

describe('useDevices', () => {
  it('lists and selects devices', async () => {
    const phone = createPhone();
    const { result } = renderHook(() => useDevices(), { wrapper: wrapperFor(phone) });
    expect(result.current.microphones).toHaveLength(2);
    expect(result.current.speakers).toHaveLength(2);
    await act(() => result.current.setDevice('microphone', 'headset-mic'));
    expect(result.current.selected.microphone).toBe('headset-mic');
    act(() => result.current.setVolume('speaker', 0.4));
    expect(result.current.volume.speaker).toBe(0.4);
  });
});

describe('useSoftphoneEvent', () => {
  it('calls the latest handler and unsubscribes on unmount', async () => {
    const phone = createPhone();
    const a = vi.fn();
    const b = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler }) => useSoftphoneEvent('notification', handler),
      { wrapper: wrapperFor(phone), initialProps: { handler: a } },
    );
    phone.simulateNotification('info', 'one');
    expect(a).toHaveBeenCalledWith({ level: 'info', title: 'one', message: undefined });
    rerender({ handler: b });
    phone.simulateNotification('warning', 'two');
    expect(b).toHaveBeenCalledTimes(1);
    unmount();
    phone.simulateNotification('error', 'three');
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('usePlugin', () => {
  it('returns plugin api once set up', async () => {
    const plugin = definePlugin({ id: 'greeter', setup: () => ({ api: { hello: () => 'hi' } }) });
    const phone = createPhone({ plugins: [plugin] });
    const { result } = renderHook(
      () => ({ greeter: usePlugin<{ hello(): string }>('greeter'), missing: usePlugin('nope') }),
      { wrapper: wrapperFor(phone) },
    );
    await waitFor(() => expect(result.current.greeter?.hello()).toBe('hi'));
    expect(result.current.missing).toBeUndefined();
  });
});
