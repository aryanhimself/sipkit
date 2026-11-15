/**
 * Executes {@link DesktopCommand}s from the main process (hotkeys, tray,
 * notification buttons, tel: links) against the softphone. Commands are
 * idempotent: "answer" with nothing ringing does nothing. Unit tested.
 */
import type { Call, SoftphoneApi, SoftphoneSnapshot } from 'sipkit-core';
import type { DesktopCommand } from '../shared/ipc';

const LIVE_STATES = new Set(['setup', 'ringing', 'early', 'connected', 'held']);

export function isRingingIncoming(call: Call): boolean {
  return call.direction === 'incoming' && (call.state === 'ringing' || call.state === 'setup' || call.state === 'early');
}

/** The ringing incoming call a hotkey / notification refers to. */
export function findRingingCall(snapshot: SoftphoneSnapshot, callId?: string): Call | undefined {
  const ringing = snapshot.calls.filter(isRingingIncoming);
  return callId ? ringing.find((c) => c.id === callId) : ringing[0];
}

/** The call "hang up" ends: the active established/outgoing call, else any live one. */
export function findHangupTarget(snapshot: SoftphoneSnapshot): Call | undefined {
  const live = snapshot.calls.filter((c) => LIVE_STATES.has(c.state) && !isRingingIncoming(c));
  return live.find((c) => c.id === snapshot.activeCallId) ?? live[0];
}

export type CommandOutcome =
  | { done: true; action: 'answer' | 'reject' | 'hangup' | 'mute' | 'dnd' | 'dial'; callId?: string }
  | { done: false; reason: 'nothing-to-do' | 'not-registered' | 'ui' };

export interface CommandOptions {
  /** How long a dial waits for registration (tel: link right after launch). */
  registrationTimeoutMs?: number;
}

export function waitForRegistration(phone: SoftphoneApi, timeoutMs: number): Promise<boolean> {
  if (phone.getSnapshot().registration.state === 'registered') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = phone.subscribe((s) => {
      if (s.registration.state === 'registered') {
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });
}

export async function executeCommand(
  phone: SoftphoneApi,
  command: DesktopCommand,
  { registrationTimeoutMs = 30_000 }: CommandOptions = {},
): Promise<CommandOutcome> {
  const snapshot = phone.getSnapshot();
  switch (command.type) {
    case 'answer': {
      const call = findRingingCall(snapshot, command.callId);
      if (!call) return { done: false, reason: 'nothing-to-do' };
      await phone.answer(call.id);
      return { done: true, action: 'answer', callId: call.id };
    }
    case 'decline': {
      const call = findRingingCall(snapshot, command.callId);
      if (!call) return { done: false, reason: 'nothing-to-do' };
      await phone.reject(call.id);
      return { done: true, action: 'reject', callId: call.id };
    }
    case 'hangup': {
      const call = findHangupTarget(snapshot);
      if (call) {
        await phone.hangup(call.id);
        return { done: true, action: 'hangup', callId: call.id };
      }
      // Nothing established: "hang up" declines a ringing call.
      const ringing = findRingingCall(snapshot);
      if (!ringing) return { done: false, reason: 'nothing-to-do' };
      await phone.reject(ringing.id);
      return { done: true, action: 'reject', callId: ringing.id };
    }
    case 'toggleMute': {
      const call = findHangupTarget(snapshot);
      if (!call || call.state !== 'connected') return { done: false, reason: 'nothing-to-do' };
      phone.mute(!call.muted, call.id);
      return { done: true, action: 'mute', callId: call.id };
    }
    case 'toggleDnd': {
      if (snapshot.registration.state !== 'registered') return { done: false, reason: 'not-registered' };
      await phone.setDnd(!snapshot.dnd);
      return { done: true, action: 'dnd' };
    }
    case 'dial': {
      const registered = await waitForRegistration(phone, registrationTimeoutMs);
      if (!registered) return { done: false, reason: 'not-registered' };
      const call = await phone.call(command.target);
      return { done: true, action: 'dial', callId: call.id };
    }
    case 'openSettings':
      return { done: false, reason: 'ui' };
  }
}
