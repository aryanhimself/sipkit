import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SoftphoneConfigInput } from 'sipkit-core';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

const VIDEO: SoftphoneConfigInput = { video: { enabled: true } };

async function renderPhone(config: SoftphoneConfigInput = VIDEO) {
  const phone = createPhone(config);
  render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

describe('video calls UI (V2-VID-01)', () => {
  it('shows no video controls while video is disabled', async () => {
    const phone = await renderPhone({});
    expect(screen.queryByRole('button', { name: 'Video call' })).toBeNull();
    act(() => void phone.simulateIncomingCall('1003', undefined, { video: true }));
    const card = screen.getByTestId('incoming-call');
    expect(within(card).getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Answer with video' })).toBeNull();
  });

  it('places a video call from the dialpad and toggles the camera', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    await user.type(screen.getByLabelText('Number to dial'), '1002');
    await user.click(screen.getByRole('button', { name: 'Video call' }));
    const region = await screen.findByTestId('call-video');
    expect(phone.getSnapshot().calls[0]).toMatchObject({ hasVideo: true, cameraOn: true });
    // jsdom has no MediaStream: the placeholder stands in for the remote video.
    expect(within(region).getByTestId('remote-video-placeholder').textContent).toMatch(/Waiting for video…|Camera off/);
    await waitFor(() => expect(screen.getByTestId('call-screen').dataset.callState).toBe('connected'));

    const camera = screen.getByRole('button', { name: 'Camera' });
    expect(camera.getAttribute('aria-pressed')).toBe('true');
    await user.click(camera);
    await waitFor(() => expect(camera.getAttribute('aria-pressed')).toBe('false'));
    expect(region.dataset.camera).toBe('off');
    await user.click(camera);
    await waitFor(() => expect(region.dataset.camera).toBe('on'));
  });

  it('offers answer with video / audio only on an incoming video call', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    act(() => void phone.simulateIncomingCall('1003', 'Video Caller', { video: true }));
    const card = screen.getByTestId('incoming-call');
    expect(card.dataset.video).toBe('true');
    expect(within(card).getByText('Incoming video call')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Answer audio only' })).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Answer with video' }));
    await screen.findByTestId('call-video');
    expect(phone.getSnapshot().calls[0]).toMatchObject({ hasVideo: true, cameraOn: true, remoteVideo: true });
  });

  it('answers audio only: no video area, camera button can upgrade', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    act(() => void phone.simulateIncomingCall('1003', undefined, { video: true }));
    await user.click(screen.getByRole('button', { name: 'Answer audio only' }));
    await waitFor(() => expect(screen.getByTestId('call-screen').dataset.callState).toBe('connected'));
    expect(screen.queryByTestId('call-video')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Camera' }));
    await screen.findByTestId('call-video');
    expect(phone.getSnapshot().calls[0]).toMatchObject({ hasVideo: true, cameraOn: true });
  });

  it('lists cameras in settings when video is enabled', async () => {
    const user = userEvent.setup();
    await renderPhone();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByLabelText('Camera')).toBeTruthy();
  });
});
