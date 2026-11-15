import { describe, expect, it } from 'vitest';
import { createTestSoftphone, FakeEngine } from '../testing';
import { CallRegistry } from '../internal/call-registry';
import { VideoController } from '../internal/video';
import { resolveConfig } from '../config';
import { QualityTracker } from '../quality';
import { declineVideoModifier, inactivateVideo, sdpOffersVideo } from '../engines/sipjs/video';
import type { CallQuality, SoftphoneEvents } from '../types';
import { flush } from './helpers';

const VIDEO = { video: { enabled: true } };

describe('video calls (V2-VID-01)', () => {
  it('is opt-in: video calls fail while video.enabled is false', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await expect(softphone.call('1002', { video: true })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(engine.commandsFor('call')).toEqual([]);
  });

  it('places a video call and folds engine facts into the call', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const events: SoftphoneEvents['call:video'][] = [];
    softphone.on('call:video', (e) => events.push(e));
    const call = await softphone.call('1002', { video: true });
    expect(engine.lastCommand('call')?.args).toEqual([call.id, '1002', { video: true }]);
    expect(call).toMatchObject({ hasVideo: true, cameraOn: true, remoteVideo: false });

    engine.simulateRemoteAnswer(call.id);
    expect(softphone.getCall(call.id)).toMatchObject({ state: 'connected', hasVideo: true, cameraOn: true, remoteVideo: true });
    expect(events.at(-1)).toEqual({ callId: call.id, hasVideo: true, cameraOn: true, remoteVideo: true });

    engine.simulateCallVideo(call.id, { remoteVideo: false });
    expect(softphone.getCall(call.id)?.remoteVideo).toBe(false);
    // MediaStreams never enter the snapshot.
    expect(JSON.parse(JSON.stringify(softphone.getSnapshot()))).toEqual(softphone.getSnapshot());
  });

  it('keeps audio-only calls unchanged (no video fields, no video option)', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const call = await softphone.call('1002');
    expect(engine.lastCommand('call')?.args).toEqual([call.id, '1002', undefined]);
    expect('hasVideo' in call).toBe(false);
  });

  it('uses video by default with video.defaultOn', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { video: { enabled: true, defaultOn: true } } });
    const call = await softphone.call('1002');
    expect(engine.lastCommand('call')?.args[2]).toEqual({ video: true });
    await softphone.hangup(call.id);
    await softphone.call('1003', { video: false });
    expect(engine.lastCommand('call')?.args[2]).toBeUndefined();
  });

  it('answers a video offer audio-only by default and with video on request', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const first = engine.simulateIncomingCall({ video: true });
    const ringing = softphone.getSnapshot().calls[0]!;
    expect(ringing).toMatchObject({ hasVideo: true, cameraOn: false });
    await softphone.answer(ringing.id);
    expect(engine.lastCommand('answer')?.args).toEqual([first]);
    expect(softphone.getCall(ringing.id)).toMatchObject({ hasVideo: false, cameraOn: false });
    await softphone.hangup(ringing.id);

    const second = engine.simulateIncomingCall({ video: true });
    const call = softphone.getSnapshot().calls[0]!;
    await softphone.answer(call.id, { video: true });
    expect(engine.lastCommand('answer')?.args).toEqual([second, { video: true }]);
    expect(softphone.getCall(call.id)).toMatchObject({ hasVideo: true, cameraOn: true, remoteVideo: true });
  });

  it('ignores video offers when video is disabled', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.simulateIncomingCall({ video: true });
    const call = softphone.getSnapshot().calls[0]!;
    expect(call.hasVideo).toBeUndefined();
    await softphone.answer(call.id, { video: true });
    expect(engine.lastCommand('answer')?.args).toHaveLength(1);
  });

  it('turns the camera off and on mid-call', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const call = await softphone.call('1002', { video: true });
    await expect(softphone.setVideo(false, call.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    engine.simulateRemoteAnswer(call.id);
    await softphone.setVideo(false, call.id);
    expect(softphone.getCall(call.id)).toMatchObject({ cameraOn: false, hasVideo: true });
    await softphone.setVideo(true);
    expect(engine.commandsFor('setVideo')).toEqual([
      [call.id, false],
      [call.id, true],
    ]);
    expect(softphone.getCall(call.id)?.cameraOn).toBe(true);
    // Idempotent.
    await softphone.setVideo(true);
    expect(engine.commandsFor('setVideo')).toHaveLength(2);
  });

  it('upgrades an audio-only call to video', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const call = await softphone.call('1002');
    engine.simulateRemoteAnswer(call.id);
    await softphone.setVideo(true, call.id);
    expect(softphone.getCall(call.id)).toMatchObject({ hasVideo: true, cameraOn: true });
  });

  it('surfaces engine failures and missing engine support', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const call = await softphone.call('1002');
    engine.simulateRemoteAnswer(call.id);
    engine.failNext('setVideo' as never, new Error('NotAllowedError: camera blocked'));
    await expect(softphone.setVideo(true)).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getCall(call.id)?.cameraOn).toBeUndefined();

    const noVideo = await createTestSoftphone({ config: VIDEO, engineOptions: { supportsVideo: false } });
    await expect(noVideo.softphone.call('1002', { video: true })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('keeps conferences audio-only: cameras go off when merging', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: VIDEO });
    const a = await softphone.call('1002', { video: true });
    engine.simulateRemoteAnswer(a.id);
    const b = await softphone.call('1003');
    engine.simulateRemoteAnswer(b.id);
    await softphone.conference();
    expect(engine.commandsFor('setVideo')).toEqual([[a.id, false]]);
    expect(softphone.getCall(a.id)).toMatchObject({ inConference: true, cameraOn: false });
    await expect(softphone.setVideo(true, a.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('exposes the engine video streams outside the snapshot', async () => {
    const engine = new FakeEngine();
    const { softphone } = await createTestSoftphone({ config: VIDEO, engine });
    const call = await softphone.call('1002', { video: true });
    const streams = { local: {} as MediaStream, remote: {} as MediaStream };
    engine.videoStreams.set(call.id, streams);
    expect(softphone.getVideoStreams(call.id)).toBe(streams);
    expect(softphone.getVideoStreams()).toBe(streams); // active call
    await softphone.hangup(call.id);
    await flush();
    expect(softphone.getVideoStreams(call.id)).toEqual({});
  });
});

describe('VideoController remote video activity', () => {
  it('marks remote video inactive while no video RTP arrives (remote camera off)', () => {
    const calls = new CallRegistry(
      { created: () => undefined, updated: () => undefined, ended: () => undefined, cdr: () => undefined, listChanged: () => undefined },
      () => '1001',
    );
    const engine = new FakeEngine();
    const cfg = resolveConfig(VIDEO);
    const events: unknown[] = [];
    const video = new VideoController({
      engine,
      calls,
      config: () => cfg,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined as never },
      getActive: () => null,
      emit: (e) => events.push(e),
    });
    const record = calls.create({ direction: 'outgoing', state: 'connected', line: 1, remoteNumber: '1002', hasVideo: true });
    video.handleEngine(record.engineId, { hasVideo: true, cameraOn: true, remoteVideo: true });
    expect(calls.get(record.call.id)?.call.remoteVideo).toBe(true);
    const sample = (rate: number) => ({ video: { inbound: { bitrateKbps: rate }, outbound: {} } }) as unknown as CallQuality;
    video.handleQuality(record.call.id, sample(0));
    expect(calls.get(record.call.id)?.call.remoteVideo).toBe(false);
    video.handleQuality(record.call.id, sample(450));
    expect(calls.get(record.call.id)?.call.remoteVideo).toBe(true);
    expect(events).toHaveLength(3);
  });
});

describe('video quality + SDP helpers', () => {
  it('derives video bitrate, loss and frame figures without touching MOS', () => {
    const tracker = new QualityTracker();
    const base = { inbound: { packetsReceived: 0, packetsLost: 0, bytesReceived: 0 }, outbound: { packetsSent: 0, bytesSent: 0 } };
    tracker.push({ timestamp: 0, ...base, video: { inbound: { packetsReceived: 0, packetsLost: 0, bytesReceived: 0 }, outbound: { packetsSent: 0, bytesSent: 0 } } });
    const q = tracker.push({
      timestamp: 2000,
      inbound: { packetsReceived: 100, packetsLost: 0, bytesReceived: 16_000 },
      outbound: { packetsSent: 100, bytesSent: 16_000 },
      video: {
        inbound: { packetsReceived: 190, packetsLost: 10, bytesReceived: 125_000, framesPerSecond: 29.97, frameWidth: 640, frameHeight: 480, codec: 'vp8' },
        outbound: { packetsSent: 200, bytesSent: 250_000, framesPerSecond: 30 },
      },
    });
    expect(q.video).toEqual({
      codec: 'vp8',
      inbound: { bitrateKbps: 500, packetLossPct: 5, framesPerSecond: 30, frameWidth: 640, frameHeight: 480 },
      outbound: { bitrateKbps: 1000, framesPerSecond: 30 },
    });
    expect(q.level).toBe('good');
  });

  it('detects video offers in SDP', () => {
    expect(sdpOffersVideo('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n')).toBe(true);
    expect(sdpOffersVideo('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\n')).toBe(false);
    expect(sdpOffersVideo('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toBe(false);
    expect(sdpOffersVideo(undefined)).toBe(false);
  });

  it('declines offered video by marking the remote offer inactive', async () => {
    const offer =
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendrecv\r\n';
    expect(inactivateVideo(offer)).toBe(
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=inactive\r\n',
    );
    expect(await declineVideoModifier({ type: 'offer', sdp: offer })).toEqual({ type: 'offer', sdp: inactivateVideo(offer) });
    expect(await declineVideoModifier({ type: 'answer', sdp: offer })).toEqual({ type: 'answer', sdp: offer });
  });
});
