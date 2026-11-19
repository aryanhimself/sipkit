import { describe, expect, it, vi } from 'vitest';
import { MicrophonePermissionWatcher } from './permission';
import { PluginHost } from '../internal/plugin-host';
import { createLogger } from '../logger';
import { definePlugin } from '../plugin';

function fakePermissions(initial: string) {
  const status = { state: initial, onchange: null as null | (() => void) };
  return {
    status,
    api: { query: vi.fn(async () => status) },
    flip(state: string) {
      status.state = state;
      status.onchange?.();
    },
  };
}

function fakeMedia(result: 'grant' | 'deny') {
  const stop = vi.fn();
  return {
    stop,
    md: {
      enumerateDevices: async () => [],
      getUserMedia: vi.fn(async () => {
        await Promise.resolve();
        if (result === 'deny') throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
        return { getTracks: () => [{ stop }] } as unknown as MediaStream;
      }),
    },
  };
}

describe('MicrophonePermissionWatcher', () => {
  it('never prompts when the mic is already allowed', async () => {
    const perms = fakePermissions('granted');
    const media = fakeMedia('grant');
    const w = new MicrophonePermissionWatcher(media.md, perms.api);
    expect(await w.request()).toBe('granted');
    expect(await w.request()).toBe('granted');
    expect(media.md.getUserMedia).not.toHaveBeenCalled();
  });

  it('never prompts when the mic is blocked: the user has to unblock it', async () => {
    const w = new MicrophonePermissionWatcher(fakeMedia('grant').md, fakePermissions('denied').api);
    expect(await w.request()).toBe('denied');
  });

  it('asks once when the browser has not decided, and shares one prompt between callers', async () => {
    const perms = fakePermissions('prompt');
    const media = fakeMedia('grant');
    const w = new MicrophonePermissionWatcher(media.md, perms.api);
    const [a, b] = await Promise.all([w.request(), w.request()]);
    expect([a, b]).toEqual(['granted', 'granted']);
    expect(media.md.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.stop).toHaveBeenCalled(); // the probe stream is released at once
    perms.status.state = 'granted';
    await w.request();
    expect(media.md.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal as denied', async () => {
    const w = new MicrophonePermissionWatcher(fakeMedia('deny').md, fakePermissions('prompt').api);
    expect(await w.request()).toBe('denied');
  });

  it('follows changes made in the site settings and notifies subscribers', async () => {
    const perms = fakePermissions('prompt');
    const w = new MicrophonePermissionWatcher(fakeMedia('grant').md, perms.api);
    const seen: string[] = [];
    w.subscribe((p) => seen.push(p));
    await w.check();
    perms.flip('denied');
    perms.flip('granted');
    expect(seen).toEqual(['prompt', 'denied', 'granted']);
    expect(perms.api.query).toHaveBeenCalledTimes(1);
    w.dispose();
    expect(perms.status.onchange).toBeNull();
  });

  it('is unknown without the Permissions API, and still asks only once', async () => {
    const media = fakeMedia('grant');
    const w = new MicrophonePermissionWatcher(media.md, null);
    expect(await w.check()).toBe('unknown');
    expect(await w.request()).toBe('granted');
    expect(await w.request()).toBe('granted');
    expect(media.md.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('PluginHost.processMicrophone', () => {
  const stream = (id: string) => ({ id, getAudioTracks: () => [{ id }] }) as unknown as MediaStream;

  it('chains hooks, skips failing ones, and disposes in reverse order once', async () => {
    const order: string[] = [];
    const host = new PluginHost(createLogger('t', { level: 'silent', console: false }));
    await host.setup(
      [
        definePlugin({
          id: 'a',
          setup: () => ({ hooks: { processMicrophone: (s) => ({ stream: stream(`${s.id}>a`), dispose: () => order.push('a') }) } }),
        }),
        definePlugin({ id: 'broken', setup: () => ({ hooks: { processMicrophone: () => Promise.reject(new Error('no wasm')) } }) }),
        definePlugin({
          id: 'b',
          setup: () => ({ hooks: { processMicrophone: (s) => ({ stream: stream(`${s.id}>b`), dispose: () => order.push('b') }) } }),
        }),
        definePlugin({ id: 'pass', setup: () => ({ hooks: { processMicrophone: () => undefined } }) }),
      ],
      () => ({}) as never,
    );
    expect(host.hasMicrophoneProcessor()).toBe(true);
    const out = await host.processMicrophone(stream('mic'));
    expect(out.stream.id).toBe('mic>a>b');
    out.dispose();
    out.dispose();
    expect(order).toEqual(['b', 'a']);
  });

  it('passes the mic through untouched without processors', async () => {
    const host = new PluginHost(createLogger('t', { level: 'silent', console: false }));
    const input = stream('mic');
    expect((await host.processMicrophone(input)).stream).toBe(input);
  });
});
