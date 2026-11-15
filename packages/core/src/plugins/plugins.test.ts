import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from '../testing';
import { createMemoryStorage } from '../storage';
import { callHistoryPlugin, type CallHistoryApi } from './call-history';
import { contactsPlugin, type ContactsApi } from './contacts';
import { ringtonePlugin, type RingtoneApi } from './ringtone';
import { browserNotificationsPlugin, type BrowserNotificationsApi } from './browser-notifications';
import { ToneLoopPlayer, UrlLoopPlayer, type LoopPlayer } from './tone-player';
import { callByEngineIncoming } from '../__tests__/helpers';

describe('callHistoryPlugin', () => {
  it('persists CDRs newest-first, capped, and survives restarts', async () => {
    const storage = createMemoryStorage();
    const { softphone, engine } = await createTestSoftphone({ storage, plugins: [callHistoryPlugin({ max: 2 })] });
    const history = softphone.plugin<CallHistoryApi>('call-history')!;
    const onChange = vi.fn();
    history.onChange(onChange);
    for (const n of ['1', '2', '3']) {
      const c = await softphone.call(n);
      engine.simulateRemoteHangup(c.id);
    }
    expect(history.list().map((r) => r.called)).toEqual(['3', '2']);
    expect(onChange).toHaveBeenCalledTimes(3);
    await softphone.destroy();

    const again = await createTestSoftphone({ storage, plugins: [callHistoryPlugin({ max: 2 })] });
    const h2 = again.softphone.plugin<CallHistoryApi>('call-history')!;
    expect(h2.list()).toHaveLength(2);
    h2.remove(h2.list()[0]!.callId);
    expect(h2.list()).toHaveLength(1);
    h2.clear();
    expect(h2.list()).toEqual([]);
  });

  it('records busy rejections', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { rejectOnBusy: true },
      plugins: [callHistoryPlugin()],
    });
    await softphone.call('1');
    engine.simulateIncomingCall({ remoteNumber: '777' });
    expect(softphone.plugin<CallHistoryApi>('call-history')!.list()[0]).toMatchObject({ caller: '777', reason: 'busy' });
  });
});

describe('contactsPlugin', () => {
  it('supports CRUD, search and number lookup with persistence', async () => {
    const storage = createMemoryStorage();
    const { softphone } = await createTestSoftphone({
      storage,
      plugins: [contactsPlugin({ initial: [{ name: 'Zed', number: '1009' }] })],
    });
    const contacts = softphone.plugin<ContactsApi>('contacts')!;
    const onChange = vi.fn();
    contacts.onChange(onChange);
    const alice = contacts.add({ name: ' Alice ', number: '+1 (555) 010-0001', email: 'alice@x.com' });
    contacts.add({ name: 'Bob', number: '1002', notes: 'support desk' });
    expect(contacts.list().map((c) => c.name)).toEqual(['Alice', 'Bob', 'Zed']);
    expect(contacts.search('ali').map((c) => c.name)).toEqual(['Alice']);
    expect(contacts.search('555-010').map((c) => c.name)).toEqual(['Alice']);
    expect(contacts.search('desk').map((c) => c.name)).toEqual(['Bob']);
    expect(contacts.search('').length).toBe(3);
    expect(contacts.findByNumber('+15550100001')?.id).toBe(alice.id);
    expect(contacts.update(alice.id, { favorite: true }).favorite).toBe(true);
    expect(() => contacts.update('nope', {})).toThrow(RangeError);
    expect(() => contacts.add({ name: '', number: '1' })).toThrow(TypeError);
    expect(() => contacts.add({ name: 'x', number: '--' })).toThrow(TypeError);
    contacts.remove(alice.id);
    expect(contacts.get(alice.id)).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(4);

    const again = await createTestSoftphone({ storage, plugins: [contactsPlugin({ initial: [{ name: 'Q', number: '1' }] })] });
    expect(again.softphone.plugin<ContactsApi>('contacts')!.list().map((c) => c.name)).toEqual(['Bob', 'Zed']);
  });
});

describe('ringtonePlugin', () => {
  function recorder() {
    const log: string[] = [];
    const createPlayer = (kind: 'ringtone' | 'ringback', url: string | undefined): LoopPlayer => ({
      start: (sink, gain) => log.push(`start:${kind}:${url ?? 'tone'}:${sink ?? '-'}:${gain ?? 1}`),
      stop: () => log.push(`stop:${kind}`),
    });
    return { log, createPlayer };
  }

  it('plays ringtone on incoming, stops on answer, plays ringback on outgoing ringing', async () => {
    const { log, createPlayer } = recorder();
    const { softphone, engine } = await createTestSoftphone({
      config: { ringtoneUrl: 'ring.mp3' },
      plugins: [ringtonePlugin({ createPlayer })],
    });
    const ringtone = softphone.plugin<RingtoneApi>('ringtone')!;
    const id = engine.simulateIncomingCall();
    expect(ringtone.playing).toBe('ringtone');
    await softphone.answer(callByEngineIncoming(softphone, id).id);
    expect(ringtone.playing).toBeNull();
    await softphone.hangup();
    const out = await softphone.call('1002');
    engine.simulateRinging(out.id);
    expect(ringtone.playing).toBe('ringback');
    engine.simulateEarlyMedia(out.id);
    expect(ringtone.playing).toBeNull();
    expect(log).toEqual(['start:ringtone:ring.mp3:-:1', 'stop:ringtone', 'start:ringback:tone:-:1', 'stop:ringback']);
  });

  it('uses the ringer device and volume, supports silence, stops on dispose', async () => {
    const { log, createPlayer } = recorder();
    const { softphone, engine } = await createTestSoftphone({ plugins: [ringtonePlugin({ createPlayer })] });
    await softphone.setDevice('ringer', 'usb-ring');
    softphone.setVolume('ringer', 0.5);
    const id = engine.simulateIncomingCall();
    expect(log.at(-1)).toBe('start:ringtone:tone:usb-ring:0.5');
    softphone.plugin<RingtoneApi>('ringtone')!.silence();
    expect(log.at(-1)).toBe('stop:ringtone');
    engine.simulateIncomingCall({ remoteNumber: '3' }); // a new call rings again
    expect(log.at(-1)).toMatch(/^start:ringtone/);
    engine.simulateCallEnded(id, 'cancelled');
    await softphone.destroy();
    expect(log.at(-1)).toBe('stop:ringtone');
  });

  it('UrlLoopPlayer loops the URL and ToneLoopPlayer schedules a cadence', async () => {
    const el = { src: '', loop: false, volume: 1, play: vi.fn(async () => undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const url = new UrlLoopPlayer('a.mp3', 0.5, () => el as unknown as HTMLAudioElement);
    url.start(undefined, 0.5);
    await Promise.resolve();
    await Promise.resolve();
    expect(el).toMatchObject({ src: 'a.mp3', loop: true, volume: 0.25 });
    expect(el.play).toHaveBeenCalled();
    url.stop();
    expect(el.pause).toHaveBeenCalled();

    vi.useFakeTimers();
    const setValueAtTime = vi.fn();
    const node = () => ({ connect: vi.fn(), start: vi.fn(), frequency: { value: 0 }, gain: { value: 0, setValueAtTime } });
    const ctx = {
      currentTime: 0,
      state: 'running',
      close: vi.fn(async () => undefined),
      createGain: node,
      createOscillator: node,
      createMediaStreamDestination: () => ({ stream: {} }),
    };
    const audio = { srcObject: null as unknown, play: vi.fn(async () => undefined), pause: vi.fn() };
    const tone = new ToneLoopPlayer(
      { frequencies: [400, 450], cadence: [1, 2] },
      1,
      () => ctx as unknown as AudioContext,
      () => audio as unknown as HTMLAudioElement,
    );
    tone.start(undefined);
    expect(setValueAtTime).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000);
    expect(setValueAtTime).toHaveBeenCalledTimes(4);
    tone.stop();
    expect(ctx.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('browserNotificationsPlugin', () => {
  function fakeNotification(permission: NotificationPermission) {
    const instances: Array<{ title: string; options?: NotificationOptions; close: () => void; closed: boolean; onclick: null | (() => void) }> = [];
    class FakeNotification {
      static permission = permission;
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      closed = false;
      onclick: null | (() => void) = null;
      constructor(public title: string, public options?: NotificationOptions) {
        instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    return { Impl: FakeNotification as unknown as typeof Notification, instances };
  }

  it('notifies for incoming calls while hidden and closes on answer', async () => {
    const { Impl, instances } = fakeNotification('granted');
    const { softphone, engine } = await createTestSoftphone({
      plugins: [browserNotificationsPlugin({ NotificationImpl: Impl, isPageHidden: () => true })],
    });
    const id = engine.simulateIncomingCall({ remoteNumber: '2000', remoteDisplayName: 'Bob' });
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ title: 'Incoming call', options: { body: 'Bob (2000)' } });
    await softphone.answer(callByEngineIncoming(softphone, id).id);
    expect(instances[0]!.closed).toBe(true);
  });

  it('skips when visible, not granted, or outgoing; exposes permission API', async () => {
    const granted = fakeNotification('granted');
    let hidden = false;
    const a = await createTestSoftphone({
      plugins: [browserNotificationsPlugin({ NotificationImpl: granted.Impl, isPageHidden: () => hidden })],
    });
    a.engine.simulateIncomingCall();
    await a.softphone.call('1');
    hidden = true;
    await a.softphone.call('2').catch(() => undefined);
    expect(granted.instances).toHaveLength(0);

    const denied = fakeNotification('default');
    const b = await createTestSoftphone({
      plugins: [browserNotificationsPlugin({ NotificationImpl: denied.Impl, isPageHidden: () => true })],
    });
    b.engine.simulateIncomingCall();
    expect(denied.instances).toHaveLength(0);
    const api = b.softphone.plugin<BrowserNotificationsApi>('browser-notifications')!;
    expect(api.supported).toBe(true);
    expect(api.permission).toBe('default');
    expect(await api.requestPermission()).toBe('granted');
  });
});
