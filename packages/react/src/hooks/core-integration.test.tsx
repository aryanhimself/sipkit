import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callHistoryPlugin, type CallHistoryApi } from 'sipkit-core';
import { createTestSoftphone } from 'sipkit-core/testing';
import { SoftphoneProvider } from '../context';
import { useActiveCall } from './use-active-call';
import { useCalls } from './use-calls';
import { usePlugin } from './use-plugin';
import { useRegistration } from './use-registration';
import { useSoftphoneEvent } from './use-softphone-event';

describe('hooks with the real core Softphone + FakeEngine', () => {
  it('tracks registration, calls, events and plugins', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { logLevel: 'silent' },
      plugins: [callHistoryPlugin()],
    });
    const ended: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SoftphoneProvider softphone={softphone}>{children}</SoftphoneProvider>
    );
    const { result } = renderHook(
      () => {
        useSoftphoneEvent('call:ended', ({ call }) => ended.push(call.remoteNumber));
        return {
          reg: useRegistration(),
          calls: useCalls(),
          active: useActiveCall(),
          history: usePlugin<CallHistoryApi>('call-history'),
        };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.reg.isRegistered).toBe(true));

    await act(async () => {
      await softphone.call('1002');
    });
    expect(result.current.calls).toHaveLength(1);
    const engineCallId = [...engine.calls.keys()][0]!;
    act(() => engine.simulateRemoteAnswer(engineCallId));
    await waitFor(() => expect(result.current.active?.state).toBe('connected'));

    act(() => engine.simulateRemoteHangup(engineCallId));
    await waitFor(() => expect(result.current.calls).toHaveLength(0));
    expect(ended).toEqual(['1002']);
    expect(result.current.history?.list()).toHaveLength(1);
  });
});
