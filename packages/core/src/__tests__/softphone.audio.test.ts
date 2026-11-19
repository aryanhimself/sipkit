import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from '../testing';
import { definePlugin } from '../plugin';
import { FakeEngine } from '../testing/fake-engine';

describe('audio processing and microphone permission', () => {
  it('defaults to the browser voice processing being on, voice isolation off', async () => {
    const { softphone } = await createTestSoftphone();
    expect(softphone.config.audioProcessing).toEqual({
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      voiceIsolation: false,
    });
    await softphone.destroy();
  });

  it('pushes changed settings to the running engine, and only when they change', async () => {
    const engine = new FakeEngine();
    const setAudioProcessing = vi.fn(async () => undefined);
    Object.assign(engine, { setAudioProcessing });
    const { softphone } = await createTestSoftphone({ engine });
    await softphone.updateConfig({ audioProcessing: { noiseSuppression: false } });
    expect(setAudioProcessing).toHaveBeenCalledWith({
      noiseSuppression: false,
      echoCancellation: true,
      autoGainControl: true,
      voiceIsolation: false,
    });
    await softphone.updateConfig({ displayName: 'Desk' });
    expect(setAudioProcessing).toHaveBeenCalledTimes(1);
    await softphone.destroy();
  });

  it('hands plugin microphone processing to the engine', async () => {
    const engine = new FakeEngine();
    const start = vi.spyOn(engine, 'start');
    const processed = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    const { softphone } = await createTestSoftphone({
      engine,
      plugins: [definePlugin({ id: 'nr', setup: () => ({ hooks: { processMicrophone: () => ({ stream: processed }) } }) })],
    });
    const fn = start.mock.calls[0]![0].processMicrophone!;
    const out = await fn({ getAudioTracks: () => [{}] } as unknown as MediaStream);
    expect(out.stream).toBe(processed);
    await softphone.destroy();
  });

  it('requestMicrophone does not prompt when the browser already allowed the mic', async () => {
    const getUserMedia = vi.fn();
    const mediaDevices = { enumerateDevices: async () => [], getUserMedia };
    const query = vi.fn(async () => ({ state: 'granted', onchange: null }));
    vi.stubGlobal('navigator', { ...globalThis.navigator, permissions: { query } });
    try {
      const { softphone } = await createTestSoftphone({ mediaDevices });
      expect(await softphone.requestMicrophone()).toBe('granted');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(softphone.getSnapshot().devices.microphone).toBe('granted');
      await softphone.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
