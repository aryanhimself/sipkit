import type { SoftphoneConfigInput } from '../config';
import type { SoftphonePlugin } from '../plugin';
import { Softphone, type CreateSoftphoneOptions } from '../softphone';
import { createMemoryStorage, type StorageLike } from '../storage';
import type { MediaDevicesLike } from '../media/devices';
import type { ConferenceMixer } from '../media/conference-mixer';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';
import type { PushPlatform } from '../push/types';

/** Config that satisfies hasCredentials() without touching a network. */
export const TEST_CONFIG: SoftphoneConfigInput = {
  username: '1001',
  password: 'secret',
  websocketUrls: ['wss://pbx.test:8089/ws'],
  logLevel: 'debug',
};

export interface CreateTestSoftphoneOptions {
  config?: SoftphoneConfigInput;
  plugins?: SoftphonePlugin<unknown>[];
  engine?: FakeEngine;
  engineOptions?: FakeEngineOptions;
  storage?: StorageLike;
  mediaDevices?: MediaDevicesLike | null;
  createMixer?: () => ConferenceMixer | undefined;
  /** Call start() before returning (default true). */
  start?: boolean;
  /** fetch for the voicemail list (V2-VM-02), e.g. `createMockVoicemailBackend().fetch`. */
  voicemailFetch?: CreateSoftphoneOptions['voicemailFetch'];
  /** Web Push platform (default none). See {@link FakePushPlatform}. */
  pushPlatform?: PushPlatform | null;
  /** Reload-safe descriptor store (V2-RESUME-01); reuse one across instances to simulate a reload. */
  resumeStorage?: StorageLike;
}

/**
 * A Softphone wired to a FakeEngine with in-memory storage, no console
 * logging and no real devices. Started (and registered) by default.
 */
export async function createTestSoftphone(
  options: CreateTestSoftphoneOptions = {},
): Promise<{ softphone: Softphone; engine: FakeEngine; storage: StorageLike }> {
  const engine = options.engine ?? new FakeEngine(options.engineOptions);
  const storage = options.storage ?? createMemoryStorage();
  const softphone = new Softphone({
    config: { ...TEST_CONFIG, ...options.config },
    engine: () => engine,
    plugins: options.plugins,
    storage,
    mediaDevices: options.mediaDevices === undefined ? null : options.mediaDevices,
    createMixer: options.createMixer ?? (() => undefined),
    console: false,
    voicemailFetch: options.voicemailFetch,
    pushPlatform: options.pushPlatform ?? null,
    resumeStorage: options.resumeStorage ?? createMemoryStorage(),
  });
  if (options.start !== false) await softphone.start();
  else await softphone.ready;
  return { softphone, engine, storage };
}

/** A fake `navigator.mediaDevices` exposing the given devices. */
export function createFakeMediaDevices(
  devices: Array<{ deviceId: string; kind: MediaDeviceKind; label?: string }>,
): MediaDevicesLike & { emitDeviceChange(): void; devices: typeof devices } {
  const listeners = new Set<() => void>();
  return {
    devices,
    async enumerateDevices() {
      return devices.map((d) => ({
        deviceId: d.deviceId,
        kind: d.kind,
        label: d.label ?? '',
        groupId: '',
        toJSON: () => d,
      }));
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    emitDeviceChange: () => listeners.forEach((l) => l()),
  };
}
