import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftphoneProvider } from '../context';
import { MockSoftphone } from '../testing/mock-softphone';
import { useVoicemail } from './use-voicemail';
import { useVoicemailList, useVoicemailPlayer } from './use-voicemail-list';

const API = { baseUrl: 'https://pbx.example.com/voicemail', token: 'dev' };

function phone(config: ConstructorParameters<typeof MockSoftphone>[0] = {}, seed = [{ callerNumber: '1002', callerName: 'Ann' }]) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], ...config },
    { registerDelayMs: 0, voicemailMessages: seed },
  );
}

const wrap = (p: MockSoftphone) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={p}>{children}</SoftphoneProvider>;
  };

const both = () => ({ list: useVoicemailList(), mwi: useVoicemail() });

afterEach(() => vi.restoreAllMocks());

describe('useVoicemailList', () => {
  it('is disabled without voicemail.api or with the feature off', () => {
    expect(renderHook(() => useVoicemailList(), { wrapper: wrap(phone({ voicemail: { enabled: true } })) }).result.current).toMatchObject({
      enabled: false,
      status: 'disabled',
      messages: [],
    });
    const off = phone({ voicemail: { enabled: true, api: API }, disabledFeatures: ['voicemail'] });
    expect(renderHook(() => useVoicemailList(), { wrapper: wrap(off) }).result.current.enabled).toBe(false);
  });

  it('loads after registering; mark read and delete update the list and MWI', async () => {
    const p = phone({ voicemail: { enabled: true, api: API } });
    const { result } = renderHook(both, { wrapper: wrap(p) });
    expect(result.current.list.enabled).toBe(true);
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    expect(result.current.list.messages).toHaveLength(1);
    await waitFor(() => expect(result.current.mwi.new).toBe(1));

    const id = result.current.list.messages[0]!.id;
    await act(() => result.current.list.markRead(id));
    expect(result.current.list.counts).toEqual({ new: 0, old: 1 });
    expect(result.current.mwi).toMatchObject({ new: 0, old: 1 });

    act(() => void p.simulateVoicemailMessage({ callerNumber: '1003' }));
    await waitFor(() => expect(result.current.list.messages).toHaveLength(2));
    expect(result.current.mwi.new).toBe(1);

    await act(() => result.current.list.remove(id));
    expect(result.current.list.messages.map((m) => m.callerNumber)).toEqual(['1003']);
    expect(result.current.mwi).toMatchObject({ new: 1, old: 0 });
  });

  it('reports errors and recovers on refresh', async () => {
    const p = phone({ voicemail: { enabled: true, api: API } });
    const { result } = renderHook(() => useVoicemailList(), { wrapper: wrap(p) });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await new Promise((r) => setTimeout(r, 200)); // let the MWI-triggered reload finish
    p.voicemailBackend.failNext(503);
    await act(() => result.current.refresh().catch(() => undefined));
    expect(result.current).toMatchObject({ status: 'error', error: 'http' });
    expect(result.current.messages).toHaveLength(1);
    await act(() => result.current.refresh());
    expect(result.current.status).toBe('ready');
  });
});

describe('useVoicemailPlayer', () => {
  it('loads a recording into an object URL and revokes it', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    Object.assign(URL, {
      createObjectURL: () => {
        created.push(`blob:${created.length}`);
        return created.at(-1)!;
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    });
    const p = phone({ voicemail: { enabled: true, api: API } });
    const { result, unmount } = renderHook(() => ({ list: useVoicemailList(), player: useVoicemailPlayer() }), { wrapper: wrap(p) });
    await waitFor(() => expect(result.current.list.status).toBe('ready'));
    const id = result.current.list.messages[0]!.id;
    await act(() => result.current.player.load(id));
    expect(result.current.player).toMatchObject({ id, url: 'blob:0', status: 'ready' });
    await act(() => result.current.player.load(id));
    expect(revoked).toEqual(['blob:0']);
    act(() => result.current.player.stop());
    expect(result.current.player).toMatchObject({ id: null, url: null, status: 'idle' });
    expect(revoked).toEqual(['blob:0', 'blob:1']);
    unmount();
  });
});
