import { describe, expect, it, vi } from 'vitest';
import { createFakeMediaDevices, createTestSoftphone, FakeEngine } from '../testing';
import { definePlugin, type SoftphonePlugin } from '../plugin';
import { createMemoryStorage } from '../storage';
import { callByEngineIncoming, flush } from './helpers';

describe('plugin lifecycle', () => {
  it('sets up in dependsOn order, exposes APIs and disposes in reverse', async () => {
    const order: string[] = [];
    const mk = (id: string, dependsOn?: string[]): SoftphonePlugin<unknown> => ({
      id,
      dependsOn,
      setup: async () => {
        order.push(`setup:${id}`);
        return { api: { id }, dispose: () => void order.push(`dispose:${id}`) };
      },
    });
    const { softphone } = await createTestSoftphone({
      plugins: [mk('c', ['b']), mk('b', ['a']), mk('a')],
    });
    expect(order).toEqual(['setup:a', 'setup:b', 'setup:c']);
    expect(softphone.plugin<{ id: string }>('b')?.id).toBe('b');
    expect(softphone.plugin('missing')).toBeUndefined();
    await softphone.destroy();
    expect(order.slice(3)).toEqual(['dispose:c', 'dispose:b', 'dispose:a']);
  });

  it('a failing plugin puts the app in error state and start() throws NOT_READY', async () => {
    const disposed = vi.fn();
    const { softphone } = await createTestSoftphone({
      start: false,
      plugins: [
        { id: 'ok', setup: () => ({ dispose: disposed }) },
        { id: 'bad', setup: () => Promise.reject(new Error('nope')) },
      ],
    });
    expect(softphone.getSnapshot().app).toBe('error');
    expect(disposed).toHaveBeenCalled();
    await expect(softphone.start()).rejects.toMatchObject({ code: 'NOT_READY' });
  });

  it('rejects missing dependencies and cycles', async () => {
    const a = await createTestSoftphone({ start: false, plugins: [{ id: 'x', dependsOn: ['y'], setup: () => ({}) }] });
    expect(a.softphone.getSnapshot().app).toBe('error');
    const b = await createTestSoftphone({
      start: false,
      plugins: [
        { id: 'x', dependsOn: ['y'], setup: () => ({}) },
        { id: 'y', dependsOn: ['x'], setup: () => ({}) },
      ],
    });
    expect(b.softphone.getSnapshot().app).toBe('error');
  });

  it('gives each plugin namespaced persistent storage', async () => {
    const storage = createMemoryStorage();
    const plugin = definePlugin<{ get(): number | undefined }>({
      id: 'counter',
      setup: ({ storage: s }) => {
        s.set('n', (s.get<number>('n') ?? 0) + 1);
        return { api: { get: () => s.get<number>('n') } };
      },
    });
    await createTestSoftphone({ storage, plugins: [plugin] });
    const { softphone } = await createTestSoftphone({ storage, plugins: [plugin] });
    expect(softphone.plugin<{ get(): number }>('counter')?.get()).toBe(2);
    expect(storage.getItem('sipkit:counter:n')).toBe('2');
  });

  it('isolates throwing event handlers', async () => {
    const { softphone } = await createTestSoftphone();
    const good = vi.fn();
    softphone.on('call:created', () => {
      throw new Error('handler bug');
    });
    softphone.on('call:created', good);
    await softphone.call('1002');
    expect(good).toHaveBeenCalled();
  });
});

describe('plugin hooks', () => {
  it('beforeDial hooks chain in order and a throwing hook is skipped', async () => {
    const { softphone, engine } = await createTestSoftphone({
      plugins: [
        { id: 'a', setup: () => ({ hooks: { beforeDial: (n: string) => `${n}1` } }) },
        { id: 'b', setup: () => ({ hooks: { beforeDial: () => { throw new Error('x'); } } }) },
        { id: 'c', setup: () => ({ hooks: { beforeDial: async (n: string) => `${n}2` } }) },
      ],
    });
    await softphone.call('0');
    expect(engine.lastCommand('call')?.args[1]).toBe('012');
  });

  it.each([
    [{ action: 'answer' as const }, 'answer'],
    [{ action: 'reject' as const, statusCode: 603 }, 'reject'],
    [{ action: 'forward' as const, target: '2000' }, 'forward'],
  ])('onIncomingCall decision %j', async (decision, method) => {
    const { engine } = await createTestSoftphone({
      plugins: [{ id: 'policy', setup: () => ({ hooks: { onIncomingCall: async () => decision } }) }],
    });
    const id = engine.simulateIncomingCall();
    await flush();
    expect(engine.commandsFor(method)[0]?.[0]).toBe(id);
    if (method === 'reject') expect(engine.commandsFor('reject')[0]?.[1]).toBe(603);
  });

  it('first non-undefined decision wins, ring falls through to config', async () => {
    const second = vi.fn(() => ({ action: 'answer' as const }));
    const { softphone, engine } = await createTestSoftphone({
      config: { autoAnswer: false },
      plugins: [
        { id: 'skip', setup: () => ({ hooks: { onIncomingCall: () => undefined } }) },
        { id: 'ring', setup: () => ({ hooks: { onIncomingCall: () => ({ action: 'ring' as const }) } }) },
        { id: 'never', setup: () => ({ hooks: { onIncomingCall: second } }) },
      ],
    });
    const id = engine.simulateIncomingCall();
    await flush();
    expect(second).not.toHaveBeenCalled();
    expect(callByEngineIncoming(softphone, id).state).toBe('ringing');
  });

  it('ignores a decision for a call that was cancelled meanwhile', async () => {
    let release: () => void = () => undefined;
    const { engine } = await createTestSoftphone({
      plugins: [
        {
          id: 'slow',
          setup: () => ({
            hooks: {
              onIncomingCall: () =>
                new Promise((r) => {
                  release = () => r({ action: 'answer' });
                }),
            },
          }),
        },
      ],
    });
    const id = engine.simulateIncomingCall();
    engine.simulateCallEnded(id, 'cancelled');
    release();
    await flush();
    expect(engine.commandsFor('answer')).toHaveLength(0);
  });
});

describe('devices', () => {
  const md = () =>
    createFakeMediaDevices([
      { deviceId: 'mic1', kind: 'audioinput', label: 'USB Mic' },
      { deviceId: 'spk1', kind: 'audiooutput', label: 'Headset' },
      { deviceId: 'cam', kind: 'videoinput' },
    ]);

  it('lists audio devices including ringer outputs (and cameras)', async () => {
    const { softphone } = await createTestSoftphone({ mediaDevices: md() });
    const list = await softphone.listDevices();
    expect(list).toEqual([
      { id: 'mic1', label: 'USB Mic', kind: 'microphone' },
      { id: 'spk1', label: 'Headset', kind: 'speaker' },
      { id: 'spk1', label: 'Headset', kind: 'ringer' },
      { id: 'cam', label: 'Camera 1', kind: 'camera' },
    ]);
    expect(softphone.getSnapshot().devices.available).toEqual(list);
  });

  it('selects devices, applies them to the engine and persists the choice', async () => {
    const storage = createMemoryStorage();
    const { softphone, engine } = await createTestSoftphone({ mediaDevices: md(), storage });
    await softphone.listDevices();
    await softphone.setDevice('microphone', 'mic1');
    await softphone.setDevice('speaker', 'spk1');
    await softphone.setDevice('ringer', 'spk1');
    expect(engine.commandsFor('setInputDevice')).toEqual([['mic1']]);
    expect(engine.commandsFor('setOutputDevice')).toEqual([['spk1']]);
    expect(softphone.getSnapshot().devices.selected).toEqual({ microphone: 'mic1', speaker: 'spk1', ringer: 'spk1' });
    await expect(softphone.setDevice('microphone', 'ghost')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    await expect(softphone.setDevice('scanner' as never, 'x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(softphone.setDevice('camera', 'x')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    await softphone.setDevice('camera', 'cam');
    expect(engine.commandsFor('setVideoDevice')).toEqual([['cam']]);

    const engine2 = new FakeEngine();
    const second = await createTestSoftphone({ mediaDevices: md(), storage, engine: engine2 });
    expect(second.softphone.getSnapshot().devices.selected.microphone).toBe('mic1');
    expect(engine2.commandsFor('setInputDevice')).toEqual([['mic1']]);
  });

  it('refreshes on devicechange', async () => {
    const devices = md();
    const { softphone } = await createTestSoftphone({ mediaDevices: devices });
    await softphone.listDevices();
    devices.devices.push({ deviceId: 'mic2', kind: 'audioinput' });
    devices.emitDeviceChange();
    await flush();
    expect(softphone.getSnapshot().devices.available.some((d) => d.id === 'mic2' && d.label === 'Microphone 2')).toBe(true);
  });

  it('returns no devices when mediaDevices is unavailable', async () => {
    const { softphone } = await createTestSoftphone();
    expect(await softphone.listDevices()).toEqual([]);
  });
});

describe('volume', () => {
  it('stores volumes, applies speaker volume to the engine and validates input', async () => {
    const storage = createMemoryStorage();
    const { softphone, engine } = await createTestSoftphone({ storage });
    softphone.setVolume('speaker', 0);
    softphone.setVolume('ringer', 0.3);
    expect(engine.commandsFor('setOutputVolume')).toEqual([[0]]);
    expect(softphone.getSnapshot().devices.volume).toEqual({ speaker: 0, ringer: 0.3 });
    expect(() => softphone.setVolume('speaker', 2)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    const engine2 = new FakeEngine();
    await createTestSoftphone({ storage, engine: engine2 });
    expect(engine2.commandsFor('setOutputVolume')).toEqual([[0]]);
  });
});

describe('reject with status code', () => {
  it('passes the status code to the engine and validates it', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const id = engine.simulateIncomingCall();
    await expect(softphone.reject(undefined, 42)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await softphone.reject(undefined, 603);
    expect(engine.commandsFor('reject')).toEqual([[id, 603]]);
  });
});
