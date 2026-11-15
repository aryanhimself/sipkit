import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from '../testing';
import { combinePresence, parseDialogInfo, parsePidf, userFromUri } from '../internal/presence-parse';
import type { SoftphoneEvents } from '../types';
import { flush } from './helpers';

// Bodies as sent by Asterisk 20 (res_pjsip_dialog_info_body_generator / res_pjsip_pidf_body_generator).
const dialogInfo = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="3" state="full" entity="sip:1001@172.28.0.10">${inner}</dialog-info>`;

const IDLE = dialogInfo('<dialog id="1001"><state>terminated</state></dialog>');
const RINGING = dialogInfo(`
 <dialog id="1001" direction="recipient">
  <state>early</state>
  <remote><identity display="Alice &amp; Co">sip:1002@172.28.0.10</identity><target uri="sip:1002@172.28.0.10"/></remote>
  <local><identity display="1001">sip:1001@172.28.0.10</identity><target uri="sip:1001@172.28.0.10"/></local>
 </dialog>`);
const BUSY = dialogInfo('<dialog id="1001" direction="initiator"><state>confirmed</state></dialog>');
const HELD = dialogInfo(`
 <dialog id="1001"><state>confirmed</state>
  <local><target uri="sip:1001@pbx"><param pname="+sip.rendering" pvalue="no"/></target></local>
 </dialog>`);

const pidf = (basic: string, note: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<presence entity="sip:1001@pbx" xmlns="urn:ietf:params:xml:ns:pidf" xmlns:dm="urn:ietf:params:xml:ns:pidf:data-model" xmlns:rpid="urn:ietf:params:xml:ns:pidf:rpid">
 <note>${note}</note>
 <tuple id="1001"><status><basic>${basic}</basic></status><contact priority="1">sip:1001@pbx</contact></tuple>
 <dm:person>${extra}</dm:person>
</presence>`;

describe('presence parsers', () => {
  it('parses Asterisk dialog-info states', () => {
    expect(parseDialogInfo(IDLE)).toEqual({ state: 'idle' });
    expect(parseDialogInfo(dialogInfo(''))).toEqual({ state: 'idle' });
    expect(parseDialogInfo(RINGING)).toEqual({
      state: 'ringing',
      direction: 'incoming',
      remoteNumber: '1002',
      remoteDisplayName: 'Alice & Co',
    });
    expect(parseDialogInfo(BUSY)).toEqual({ state: 'busy', direction: 'outgoing' });
    expect(parseDialogInfo(HELD)).toEqual({ state: 'held' });
  });

  it('handles namespace prefixes, outgoing early dialogs and several dialogs', () => {
    const prefixed = `<d:dialog-info xmlns:d="urn:ietf:params:xml:ns:dialog-info"><d:dialog id="x" direction="initiator"><d:state>early</d:state></d:dialog></d:dialog-info>`;
    expect(parseDialogInfo(prefixed)).toEqual({ state: 'busy', direction: 'outgoing' });
    const both = dialogInfo(
      '<dialog id="a"><state>confirmed</state></dialog><dialog id="b" direction="recipient"><state>early</state></dialog>',
    );
    expect(parseDialogInfo(both)?.state).toBe('ringing');
  });

  it('rejects unusable bodies', () => {
    expect(parseDialogInfo('')).toBeUndefined();
    expect(parseDialogInfo(undefined)).toBeUndefined();
    expect(parseDialogInfo('<presence/>')).toBeUndefined();
    expect(parsePidf('Messages-Waiting: yes')).toBeUndefined();
  });

  it('parses PIDF (Asterisk notes and RPID activities)', () => {
    expect(parsePidf(pidf('open', 'Ready'))).toEqual({ state: 'idle', note: 'Ready' });
    expect(parsePidf(pidf('open', 'On the phone', '<rpid:activities><rpid:on-the-phone/></rpid:activities>'))).toEqual({
      state: 'busy',
      note: 'On the phone',
    });
    expect(parsePidf(pidf('open', 'Ringing'))?.state).toBe('ringing');
    expect(parsePidf(pidf('open', 'On hold'))?.state).toBe('held');
    expect(parsePidf(pidf('closed', 'Unavailable'))?.state).toBe('unavailable');
  });

  it('combines dialog and presence', () => {
    expect(combinePresence()).toEqual({ state: 'unknown' });
    expect(combinePresence({ state: 'busy' }, { state: 'idle', note: 'Lunch' })).toEqual({ state: 'busy', note: 'Lunch' });
    expect(combinePresence({ state: 'idle' }, { state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(combinePresence(undefined, { state: 'idle' })).toEqual({ state: 'idle' });
  });

  it('extracts the user from URIs', () => {
    expect(userFromUri('sip:1002@pbx;transport=ws')).toBe('1002');
    expect(userFromUri('<sips:alice%2B1@x>')).toBe('alice+1');
    expect(userFromUri('1003')).toBe('1003');
  });
});

const PRESENCE = { presence: { enabled: true, watch: ['1002', '1003'], subscribeIntervalMs: 0 } };

describe('Softphone presence / BLF', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default and watch() requires presence.enabled', async () => {
    const { softphone, engine } = await createTestSoftphone();
    expect(softphone.getSnapshot().presence).toEqual({});
    expect(() => softphone.watch('1002')).toThrow(/presence.enabled/);
    expect(engine.commands.filter((c) => c.method === 'subscribePresence')).toHaveLength(0);
  });

  it('subscribes to configured extensions after registering and tracks NOTIFYs', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: PRESENCE });
    const events: SoftphoneEvents['presence:changed'][] = [];
    softphone.on('presence:changed', (e) => events.push(e));
    await flush();
    expect([...engine.presenceSubscriptions].sort()).toEqual(['dialog:1002', 'dialog:1003']);
    expect(softphone.getSnapshot().presence['1002']).toMatchObject({ target: '1002', state: 'unknown' });

    engine.simulatePresence('1002', IDLE);
    expect(softphone.getSnapshot().presence['1002']?.state).toBe('idle');
    engine.simulatePresence('1002', RINGING);
    expect(softphone.getSnapshot().presence['1002']).toMatchObject({
      state: 'ringing',
      remoteNumber: '1002',
      remoteDisplayName: 'Alice & Co',
    });
    // Same state again: no event.
    engine.simulatePresence('1002', RINGING);
    expect(events.map((e) => e.presence?.state)).toEqual(['idle', 'ringing']);
    expect(events[1]?.previous?.state).toBe('idle');
  });

  it('watch()/unwatch() at runtime', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { presence: { enabled: true, subscribeIntervalMs: 0 } } });
    softphone.watch([' 2001 ', '2001', '']);
    await flush();
    expect(engine.presenceSubscriptions).toEqual(new Set(['dialog:2001']));
    expect(Object.keys(softphone.getSnapshot().presence)).toEqual(['2001']);
    softphone.unwatch('2001');
    await flush();
    expect(engine.presenceSubscriptions.size).toBe(0);
    expect(softphone.getSnapshot().presence).toEqual({});
    // Updates for unwatched targets are ignored.
    engine.simulatePresence('2001', { state: 'busy' });
    expect(softphone.getSnapshot().presence).toEqual({});
  });

  it('subscribes to both packages and merges them', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { presence: { enabled: true, watch: ['1002'], events: ['dialog', 'presence'], subscribeIntervalMs: 0 } },
    });
    await flush();
    expect([...engine.presenceSubscriptions].sort()).toEqual(['dialog:1002', 'presence:1002']);
    engine.simulatePresence('1002', IDLE);
    engine.simulatePresence('1002', pidf('closed', 'Unavailable'), 'presence');
    expect(softphone.getSnapshot().presence['1002']?.state).toBe('unavailable');
    engine.simulatePresence('1002', BUSY);
    expect(softphone.getSnapshot().presence['1002']).toMatchObject({ state: 'busy', note: 'Unavailable' });
  });

  it('throttles initial SUBSCRIBEs', async () => {
    vi.useFakeTimers();
    const watch = Array.from({ length: 50 }, (_, i) => String(3000 + i));
    const { softphone, engine } = await createTestSoftphone({
      config: { presence: { enabled: true, watch, subscribeIntervalMs: 20 } },
    });
    await flush();
    const sent = () => engine.commands.filter((c) => c.method === 'subscribePresence').length;
    expect(sent()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent()).toBeGreaterThanOrEqual(10);
    expect(sent()).toBeLessThan(15);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toBe(50);
    expect(Object.keys(softphone.getSnapshot().presence)).toHaveLength(50);
  });

  it('marks refused subscriptions unknown and backs off; 489 is not retried', async () => {
    vi.useFakeTimers();
    const { softphone, engine } = await createTestSoftphone({ config: PRESENCE });
    await flush();
    engine.simulatePresence('1002', IDLE);
    engine.simulatePresenceTerminated('1002', 404);
    expect(softphone.getSnapshot().presence['1002']).toMatchObject({ state: 'unknown', errorCode: 404 });
    const count = () => engine.commands.filter((c) => c.method === 'subscribePresence' && c.args[0] === '1002').length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(1); // hard failure: slow retry
    await vi.advanceTimersByTimeAsync(300_000);
    expect(count()).toBe(2);

    engine.simulatePresenceTerminated('1003', 489);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(engine.commands.filter((c) => c.method === 'subscribePresence' && c.args[0] === '1003')).toHaveLength(1);
  });

  it('retries quickly after a transient termination', async () => {
    vi.useFakeTimers();
    const { engine } = await createTestSoftphone({ config: PRESENCE });
    await flush();
    engine.simulatePresenceTerminated('1002');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.presenceSubscriptions.has('dialog:1002')).toBe(true);
  });

  it('drops subscriptions on registration loss and resubscribes on re-register', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: PRESENCE });
    await flush();
    engine.simulatePresence('1002', BUSY);
    engine.simulateRegistrationFailure(503, 'Service Unavailable');
    await flush();
    expect(engine.presenceSubscriptions.size).toBe(0);
    expect(softphone.getSnapshot().presence['1002']?.state).toBe('unknown');
    engine.simulateRegistered();
    await flush();
    expect(engine.presenceSubscriptions.size).toBe(2);
  });

  it('applies config changes (disable clears everything)', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: PRESENCE });
    await flush();
    await softphone.updateConfig({ presence: { enabled: true, watch: ['1003', '1004'], subscribeIntervalMs: 0 } });
    await flush();
    expect([...engine.presenceSubscriptions].sort()).toEqual(['dialog:1003', 'dialog:1004']);
    await softphone.updateConfig({ presence: { enabled: false } });
    await flush();
    expect(engine.presenceSubscriptions.size).toBe(0);
    expect(softphone.getSnapshot().presence).toEqual({});
  });

  it('works without engine support (lamps stay unknown)', async () => {
    const { softphone } = await createTestSoftphone({ config: PRESENCE, engineOptions: { supportsPresence: false } });
    await flush();
    expect(softphone.getSnapshot().presence['1002']?.state).toBe('unknown');
  });

  it('pickup() dials the pickup prefix', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { presence: { pickupPrefix: '*8' } } });
    const call = await softphone.pickup('sip:1002@pbx');
    expect(call.remoteNumber).toBe('*81002');
    expect(engine.commands.find((c) => c.method === 'call')?.args[1]).toBe('*81002');
    await expect(softphone.pickup('')).rejects.toThrow(/Invalid pickup/);
  });
});
