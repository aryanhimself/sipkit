import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cdr } from 'sipkit-core';
import { useCallQuality } from './use-call-quality';
import { createPhone, wrapperFor } from '../test-utils';

afterEach(() => {
  vi.useRealTimers();
});

async function connected() {
  vi.useFakeTimers();
  const phone = createPhone();
  await act(async () => {
    const started = phone.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
  });
  let id = '';
  await act(async () => {
    id = (await phone.call('1002')).id;
    await vi.advanceTimersByTimeAsync(50);
  });
  return { phone, id };
}

describe('useCallQuality (MockSoftphone)', () => {
  it('is null until the first sample, then follows simulated network changes', async () => {
    const { phone, id } = await connected();
    const { result } = renderHook(() => useCallQuality(), { wrapper: wrapperFor(phone) });
    expect(result.current).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(result.current).toMatchObject({ level: 'good', codec: 'opus' });

    phone.simulateNetwork('poor');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(result.current?.level).toBe('poor');
    expect(result.current?.inbound.packetLossPct).toBe(15);

    const byId = renderHook(() => useCallQuality(id), { wrapper: wrapperFor(phone) });
    expect(byId.result.current?.level).toBe('poor');
  });

  it('attaches a quality summary to the mock CDR', async () => {
    const { phone } = await connected();
    const cdrs: Cdr[] = [];
    phone.on('cdr', (c) => cdrs.push(c));
    await act(() => vi.advanceTimersByTimeAsync(4000));
    await act(() => phone.hangup());
    expect(cdrs[0]?.quality).toMatchObject({ samples: 2, worstLevel: 'good' });
  });
});
