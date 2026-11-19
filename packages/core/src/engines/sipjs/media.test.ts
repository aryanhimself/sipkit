import { afterEach, describe, expect, it, vi } from 'vitest';
import { SipJsEngine } from './engine';
import { resolveConfig } from '../../config';

class FakeStream {
  constructor(private tracks: { kind: string; stop: () => void }[] = []) {}
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getTracks() {
    return this.tracks;
  }
}

type Internals = {
  audioSettings: unknown;
  inputDeviceId: string | undefined;
  processMicrophone: unknown;
  audioConstraints(): MediaTrackConstraints & { voiceIsolation?: boolean };
  captureMedia(c: MediaStreamConstraints, sdh: object): Promise<FakeStream>;
  mediaCleanups: WeakMap<object, () => void>;
};

function engine(audioProcessing = {}) {
  const e = new SipJsEngine() as unknown as Internals;
  e.audioSettings = resolveConfig({ username: '1', websocketUrls: ['wss://x'], domain: 'x', audioProcessing }).audioProcessing;
  return e;
}

afterEach(() => vi.unstubAllGlobals());

describe('SipJsEngine microphone capture', () => {
  it('asks the browser for its voice processing, with voice isolation only when wanted', () => {
    const e = engine({ noiseSuppression: false });
    e.inputDeviceId = 'usb';
    expect(e.audioConstraints()).toEqual({
      deviceId: { exact: 'usb' },
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    });
    expect(engine({ voiceIsolation: true }).audioConstraints().voiceIsolation).toBe(true);
  });

  it('sends the processed mic and stops the raw mic and processing when released', async () => {
    const rawStop = vi.fn();
    const video = { kind: 'video', stop: vi.fn() };
    vi.stubGlobal('MediaStream', FakeStream);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => new FakeStream([{ kind: 'audio', stop: rawStop }, video])) },
    });
    const processedTrack = { kind: 'audio', stop: vi.fn() };
    const dispose = vi.fn();
    const e = engine();
    e.processMicrophone = vi.fn(async () => ({ stream: new FakeStream([processedTrack]), dispose }));
    const sdh = {};
    const out = await e.captureMedia({ audio: {}, video: true }, sdh);
    expect(out.getTracks()).toEqual([processedTrack, video]);
    expect(rawStop).not.toHaveBeenCalled();

    // Capturing again (device switch) releases the previous capture.
    await e.captureMedia({ audio: {}, video: false }, sdh);
    expect(rawStop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    e.mediaCleanups.get(sdh)?.();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('returns the raw stream untouched when no plugin processes the mic', async () => {
    const raw = new FakeStream([{ kind: 'audio', stop: vi.fn() }]);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => raw) } });
    vi.stubGlobal('MediaStream', FakeStream);
    const e = engine();
    const input: FakeStream[] = [];
    e.processMicrophone = vi.fn(async (s: FakeStream) => {
      input.push(s);
      return { stream: s, dispose: vi.fn() };
    });
    expect(await e.captureMedia({ audio: {} }, {})).toBe(raw);
  });
});
