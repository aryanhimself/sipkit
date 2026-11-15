import { MockSoftphone } from 'sipkit-react/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCommand, IncomingCallInfo } from '../shared/ipc';
import type { TrayStatus } from '../shared/status';
import { executeCommand, findHangupTarget, findRingingCall } from './commands';
import { toSoftphoneConfig } from './create-softphone';
import { attachDesktopIntegration, isMissedCall } from './desktop-integration';

const phones: MockSoftphone[] = [];
async function registeredPhone(): Promise<MockSoftphone> {
  const phone = new MockSoftphone({ username: '1001', password: 'pw', domain: 'pbx.test' }, { registerDelayMs: 5, ringDelayMs: 10, connectDelayMs: 20 });
  phones.push(phone);
  await phone.start();
  await vi.waitFor(() => expect(phone.getSnapshot().registration.state).toBe('registered'));
  return phone;
}
afterEach(async () => {
  for (const p of phones.splice(0)) await p.stop();
});

describe('executeCommand', () => {
  it('answer picks the ringing call (or the given id) and is a no-op otherwise', async () => {
    const phone = await registeredPhone();
    expect(await executeCommand(phone, { type: 'answer' })).toEqual({ done: false, reason: 'nothing-to-do' });
    const call = phone.simulateIncomingCall('5550100')!;
    expect(await executeCommand(phone, { type: 'answer', callId: 'other' })).toEqual({ done: false, reason: 'nothing-to-do' });
    expect(await executeCommand(phone, { type: 'answer', callId: call.id })).toEqual({ done: true, action: 'answer', callId: call.id });
    await vi.waitFor(() => expect(phone.getSnapshot().calls[0]?.state).toBe('connected'));
  });

  it('hangup ends the established call, or declines a ringing one', async () => {
    const phone = await registeredPhone();
    const ringing = phone.simulateIncomingCall('5550100')!;
    expect(await executeCommand(phone, { type: 'hangup' })).toEqual({ done: true, action: 'reject', callId: ringing.id });
    await vi.waitFor(() => expect(phone.getSnapshot().calls.filter((c) => c.state !== 'disconnected')).toHaveLength(0));

    const second = phone.simulateIncomingCall('5550101')!;
    await phone.answer(second.id);
    await vi.waitFor(() => expect(findHangupTarget(phone.getSnapshot())?.id).toBe(second.id));
    expect(await executeCommand(phone, { type: 'hangup' })).toEqual({ done: true, action: 'hangup', callId: second.id });
    expect(await executeCommand(phone, { type: 'hangup' })).toEqual({ done: false, reason: 'nothing-to-do' });
  });

  it('decline rejects only a ringing call', async () => {
    const phone = await registeredPhone();
    expect(await executeCommand(phone, { type: 'decline', callId: 'x' })).toEqual({ done: false, reason: 'nothing-to-do' });
    const call = phone.simulateIncomingCall('5550100')!;
    expect(findRingingCall(phone.getSnapshot(), call.id)?.id).toBe(call.id);
    expect(await executeCommand(phone, { type: 'decline', callId: call.id })).toMatchObject({ done: true, action: 'reject' });
  });

  it('toggles mute and DND', async () => {
    const phone = await registeredPhone();
    expect(await executeCommand(phone, { type: 'toggleMute' })).toEqual({ done: false, reason: 'nothing-to-do' });
    const call = phone.simulateIncomingCall('5550100')!;
    await phone.answer(call.id);
    await vi.waitFor(() => expect(phone.getSnapshot().calls[0]?.state).toBe('connected'));
    await executeCommand(phone, { type: 'toggleMute' });
    expect(phone.getSnapshot().calls[0]?.muted).toBe(true);
    await executeCommand(phone, { type: 'toggleDnd' });
    expect(phone.getSnapshot().dnd).toBe(true);
  });

  it('dial waits for registration', async () => {
    const phone = new MockSoftphone({ username: '1001', password: 'pw', autoRegister: false });
    phones.push(phone);
    await phone.start();
    const pending = executeCommand(phone, { type: 'dial', target: '1002', source: 'url' }, { registrationTimeoutMs: 2000 });
    await phone.register();
    const outcome = await pending;
    expect(outcome).toMatchObject({ done: true, action: 'dial' });
    expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('1002');
    const never = new MockSoftphone({ username: '1001', autoRegister: false });
    phones.push(never);
    await never.start();
    expect(await executeCommand(never, { type: 'dial', target: '1', source: 'url' }, { registrationTimeoutMs: 20 })).toEqual({
      done: false,
      reason: 'not-registered',
    });
  });
});

describe('attachDesktopIntegration', () => {
  function fakeBridge() {
    let handler: ((c: DesktopCommand) => void) | null = null;
    const bridge = {
      statuses: [] as TrayStatus[],
      incoming: [] as IncomingCallInfo[],
      ended: [] as string[],
      missed: [] as IncomingCallInfo[],
      readyCalls: 0,
      reportStatus(s: TrayStatus) {
        this.statuses.push(s);
      },
      notifyIncomingCall(c: IncomingCallInfo) {
        this.incoming.push(c);
      },
      notifyIncomingCallEnded(id: string) {
        this.ended.push(id);
      },
      notifyMissedCall(c: IncomingCallInfo) {
        this.missed.push(c);
      },
      onCommand(h: (c: DesktopCommand) => void) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      ready() {
        this.readyCalls++;
      },
      send(c: DesktopCommand) {
        handler?.(c);
      },
    };
    return bridge;
  }

  it('reports status changes, incoming / ended / missed calls and runs commands', async () => {
    const phone = await registeredPhone();
    const bridge = fakeBridge();
    const results: unknown[] = [];
    const ui = vi.fn();
    const detach = attachDesktopIntegration(phone, bridge, { onUiCommand: ui, onCommandResult: (_c, o) => results.push(o) });
    expect(bridge.readyCalls).toBe(1);
    expect(bridge.statuses).toEqual(['registered']);

    const call = phone.simulateIncomingCall('5550100', 'Jane')!;
    expect(bridge.incoming).toEqual([{ callId: call.id, number: '5550100', displayName: 'Jane' }]);
    expect(bridge.statuses.at(-1)).toBe('ringing');

    bridge.send({ type: 'answer' });
    await vi.waitFor(() => expect(bridge.statuses.at(-1)).toBe('in-call'));
    expect(bridge.ended).toEqual([call.id]);
    bridge.send({ type: 'hangup' });
    await vi.waitFor(() => expect(bridge.statuses.at(-1)).toBe('registered'));
    expect(bridge.missed).toEqual([]);

    const missed = phone.simulateIncomingCall('5550199')!;
    phone.simulateRemoteHangup(missed.id);
    await vi.waitFor(() => expect(bridge.missed).toEqual([{ callId: missed.id, number: '5550199' }]));

    bridge.send({ type: 'openSettings' });
    expect(ui).toHaveBeenCalledOnce();

    // Statuses are only sent on change.
    const count = bridge.statuses.length;
    phone.simulateVoicemail({ new: 1 });
    expect(bridge.statuses).toHaveLength(count);

    detach();
    bridge.send({ type: 'answer' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('counts DND rejections as missed', async () => {
    const phone = await registeredPhone();
    const bridge = fakeBridge();
    attachDesktopIntegration(phone, bridge);
    await phone.setDnd(true);
    expect(bridge.statuses.at(-1)).toBe('dnd');
    phone.simulateIncomingCall('5550111');
    expect(bridge.missed.map((m) => m.number)).toEqual(['5550111']);
    expect(bridge.incoming).toEqual([]);
  });
});

describe('helpers', () => {
  it('isMissedCall', () => {
    const base = { callId: 'a', line: 1, caller: '1', called: '2', startedAt: 0, endedAt: 1, durationMs: 0 };
    expect(isMissedCall({ ...base, direction: 'incoming', reason: 'cancelled' })).toBe(true);
    expect(isMissedCall({ ...base, direction: 'incoming', reason: 'rejected' })).toBe(false);
    expect(isMissedCall({ ...base, direction: 'incoming', reason: 'remote-hangup', connectedAt: 1 })).toBe(false);
    expect(isMissedCall({ ...base, direction: 'outgoing', reason: 'no-answer' })).toBe(false);
  });

  it('toSoftphoneConfig maps the account', () => {
    expect(
      toSoftphoneConfig({ server: 'wss://ws.pbx.test:8089/ws', domain: '', extension: '1001', authUsername: 'auth1001', displayName: '' }, 'pw', 'ne'),
    ).toEqual({
      websocketUrls: ['wss://ws.pbx.test:8089/ws'],
      domain: 'ws.pbx.test',
      username: '1001',
      password: 'pw',
      authUsername: 'auth1001',
      brandName: 'SipKit',
      language: 'ne',
    });
  });
});
