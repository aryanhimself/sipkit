import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SoftphoneProvider } from '../context';
import { MockSoftphone } from '../testing/mock-softphone';
import { useCallVideo } from './use-call-video';

function phone(video = true) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], video: { enabled: video } },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 20 },
  );
}

const wrap = (p: MockSoftphone) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={p}>{children}</SoftphoneProvider>;
  };

describe('useCallVideo', () => {
  it('is unsupported while video is disabled', () => {
    const { result } = renderHook(() => useCallVideo(), { wrapper: wrap(phone(false)) });
    expect(result.current).toMatchObject({ supported: false, hasVideo: false, localStream: null, remoteStream: null });
  });

  it('follows a video call and toggles the camera', async () => {
    const p = phone();
    await p.start();
    const { result } = renderHook(() => useCallVideo(), { wrapper: wrap(p) });
    await act(async () => {
      await p.call('1002', { video: true });
    });
    expect(result.current).toMatchObject({ supported: true, hasVideo: true, cameraOn: true, remoteVideo: false });
    await waitFor(() => expect(result.current.remoteVideo).toBe(true));
    await act(() => result.current.toggleCamera());
    expect(result.current.cameraOn).toBe(false);
    act(() => p.simulateRemoteVideo(false));
    expect(result.current.remoteVideo).toBe(false);
    await act(() => result.current.setVideo(true));
    expect(result.current.cameraOn).toBe(true);
  });

  it('reports an incoming video offer and the audio-only answer', async () => {
    const p = phone();
    await p.start();
    const { result } = renderHook(() => useCallVideo(), { wrapper: wrap(p) });
    act(() => {
      p.simulateIncomingCall('1003', undefined, { video: true });
    });
    const id = p.getSnapshot().calls[0]!.id;
    const { result: forCall } = renderHook(() => useCallVideo(id), { wrapper: wrap(p) });
    expect(forCall.current.hasVideo).toBe(true);
    await act(() => p.answer(id, { video: false }));
    expect(result.current.hasVideo).toBe(false);
  });
});
