import { expect, test } from '@playwright/test';
import { answerIncoming, closePhone, expectCallState, expectMediaFlowing, openPhone, type Phone } from './helpers';

/**
 * 1:1 video against the real dev PBX (V2-VID-01). Chromium's fake camera
 * (--use-fake-device-for-media-stream) supplies the video; RTP stats prove
 * that video really flows, not just that signalling succeeded.
 */

/** Total RTP *video* bytes received / sent across the page's peer connections. */
async function videoBytes(phone: Phone): Promise<{ received: number; sent: number }> {
  return phone.page.evaluate(async () => {
    let received = 0;
    let sent = 0;
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s: { type: string; kind?: string; bytesReceived?: number; bytesSent?: number }) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') received += s.bytesReceived ?? 0;
        if (s.type === 'outbound-rtp' && s.kind === 'video') sent += s.bytesSent ?? 0;
      });
    }
    return { received, sent };
  });
}

/** Assert video bytes received keep increasing. */
async function expectVideoReceived(phone: Phone, timeout = 15_000): Promise<void> {
  const before = await videoBytes(phone);
  await expect
    .poll(async () => (await videoBytes(phone)).received - before.received, {
      message: `${phone.user} should receive RTP video`,
      timeout,
    })
    .toBeGreaterThan(5_000);
}

/** Video bytes received during `ms`. */
async function videoReceivedDuring(phone: Phone, ms: number): Promise<number> {
  const before = await videoBytes(phone);
  await phone.page.waitForTimeout(ms);
  return (await videoBytes(phone)).received - before.received;
}

const activeCall = (phone: Phone) =>
  phone.page.evaluate(() => {
    const s = window.__softphone?.getSnapshot();
    return s?.calls.find((c) => c.id === s.activeCallId) ?? null;
  });

async function videoDial(phone: Phone, number: string): Promise<void> {
  await phone.page.getByLabel('Number to dial').fill(number);
  await phone.page.getByRole('button', { name: 'Video call', exact: true }).click();
  await expect(phone.page.getByTestId('call-screen')).toBeVisible();
}

test.describe('video calls (real Asterisk)', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('1001 video-calls 1002: video both ways, camera off/on mid-call', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');

    await videoDial(a, '1002');
    // Local preview shows before the far end answers.
    await expect(a.page.getByTestId('local-video')).toBeVisible();

    const incoming = b.page.getByTestId('incoming-call');
    await expect(incoming).toHaveAttribute('data-video', 'true');
    await expect(incoming).toContainText('Incoming video call');
    await incoming.getByRole('button', { name: 'Answer with video' }).click();
    await expectCallState(a, 'connected');
    await expectCallState(b, 'connected');

    await expectVideoReceived(a);
    await expectVideoReceived(b);
    await expectMediaFlowing(a);
    for (const p of [a, b]) {
      await expect(p.page.getByTestId('call-video')).toHaveAttribute('data-remote-video', 'on');
      await expect
        .poll(() => p.page.getByTestId('remote-video').evaluate((el) => (el as HTMLVideoElement).videoWidth))
        .toBeGreaterThan(0);
      expect(await activeCall(p)).toMatchObject({ hasVideo: true, cameraOn: true, remoteVideo: true });
    }

    // Camera off on 1001: no re-INVITE, the sender stops, 1002 stops receiving video.
    const camera = a.page.getByRole('button', { name: 'Camera', exact: true });
    await camera.click();
    await expect(camera).toHaveAttribute('aria-pressed', 'false');
    await expect(a.page.getByTestId('local-video')).toHaveCount(0);
    await expect.poll(() => videoReceivedDuring(b!, 2_000), { timeout: 15_000 }).toBeLessThan(1_500);
    // 1002's core notices the stalled stream through the quality monitor.
    await expect.poll(async () => (await activeCall(b!))?.remoteVideo).toBe(false);
    await expect(b.page.getByTestId('remote-video-placeholder')).toContainText('Camera off');
    // Audio is unaffected.
    await expectMediaFlowing(b);

    await camera.click();
    await expect(camera).toHaveAttribute('aria-pressed', 'true');
    await expectVideoReceived(b);
    await expect.poll(async () => (await activeCall(b!))?.remoteVideo).toBe(true);

    // Hold / resume keep the video call intact.
    await a.page.getByRole('button', { name: 'Hold' }).click();
    await expectCallState(a, 'held');
    await a.page.getByRole('button', { name: 'Resume' }).click();
    await expectCallState(a, 'connected');
    await expectVideoReceived(b);
    await expectVideoReceived(a);

    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
  });

  test('audio-only call still works with video enabled (no video stream)', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await a.page.getByLabel('Number to dial').fill('1002');
    await a.page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(b.page.getByTestId('incoming-call')).not.toHaveAttribute('data-video', 'true');
    await answerIncoming(b);
    await expectCallState(a, 'connected');
    await expectMediaFlowing(a);
    await expectMediaFlowing(b);
    expect(await videoBytes(a)).toEqual({ received: 0, sent: 0 });
    await expect(a.page.getByTestId('call-video')).toHaveCount(0);
    expect((await activeCall(a))?.hasVideo).toBeUndefined();
    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
  });

  test('camera on during an audio-only call adds video by re-INVITE', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await a.page.getByLabel('Number to dial').fill('1002');
    await a.page.getByRole('button', { name: 'Call', exact: true }).click();
    await answerIncoming(b);
    await expectCallState(a, 'connected');
    await expectMediaFlowing(a);

    await a.page.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect(a.page.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(a.page.getByTestId('local-video')).toBeVisible();
    // Asterisk relays the new video stream to 1002, which starts receiving our video.
    await expectVideoReceived(b, 20_000);
    await expect(b.page.getByTestId('call-video')).toHaveAttribute('data-remote-video', 'on');
    await expectMediaFlowing(b);
  });

  test('answering a video call audio-only declines the video stream', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await videoDial(a, '1002');
    await b.page.getByTestId('incoming-call').getByRole('button', { name: 'Answer audio only' }).click();
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
    expect(await videoReceivedDuring(b, 2_000)).toBe(0);
    await expect(b.page.getByTestId('call-video')).toHaveCount(0);
    expect((await activeCall(b))?.hasVideo).toBe(false);
  });

  test('video call to the echo test (600) receives our video back', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    await videoDial(a, '600');
    await expectCallState(a, 'connected');
    // Echo() starts after the demo-echotest prompt and asks the browser for a keyframe.
    await expectVideoReceived(a, 40_000);
    await expect(a.page.getByTestId('call-video')).toHaveAttribute('data-remote-video', 'on', { timeout: 15_000 });
    await expect.poll(async () => (await activeCall(a!))?.quality?.video?.codec).toMatch(/^(vp8|h264)$/);
  });
});
