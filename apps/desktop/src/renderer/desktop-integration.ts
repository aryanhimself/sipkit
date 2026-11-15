/**
 * Wires a softphone instance to the desktop shell:
 * - reports the tray status whenever it changes,
 * - asks main for an incoming-call notification when a call starts ringing and
 *   withdraws it when the call is answered / ends,
 * - reports missed calls,
 * - executes commands from main (hotkeys, tray, notifications, links).
 * Unit tested with MockSoftphone and a fake bridge.
 */
import type { Cdr, SoftphoneApi } from 'sipkit-core';
import type { DesktopBridge, DesktopCommand } from '../shared/ipc';
import { deriveTrayStatus, type TrayStatus } from '../shared/status';
import { executeCommand, isRingingIncoming, type CommandOptions, type CommandOutcome } from './commands';

type Bridge = Pick<
  DesktopBridge,
  'reportStatus' | 'notifyIncomingCall' | 'notifyIncomingCallEnded' | 'notifyMissedCall' | 'onCommand' | 'ready'
>;

const MISSED_REASONS = new Set(['remote-hangup', 'cancelled', 'no-answer', 'dnd']);

/**
 * An incoming call that ended without being answered or declined by the user
 * (caller gave up, ring timeout, or rejected automatically by DND). Based on
 * the CDR because DND rejections never create a call.
 */
export function isMissedCall(cdr: Cdr): boolean {
  return cdr.direction === 'incoming' && !cdr.connectedAt && MISSED_REASONS.has(cdr.reason);
}

export interface IntegrationOptions extends CommandOptions {
  /** UI-only commands (open settings). */
  onUiCommand?: (command: DesktopCommand) => void;
  /** Observe command results (logging, tests). */
  onCommandResult?: (command: DesktopCommand, outcome: CommandOutcome | Error) => void;
}

export function attachDesktopIntegration(phone: SoftphoneApi, bridge: Bridge, options: IntegrationOptions = {}): () => void {
  let status: TrayStatus | null = null;
  const ringing = new Set<string>();

  const sync = () => {
    const snapshot = phone.getSnapshot();
    const next = deriveTrayStatus(snapshot);
    if (next !== status) {
      status = next;
      bridge.reportStatus(next);
    }
    const nowRinging = new Set<string>();
    for (const call of snapshot.calls) {
      if (!isRingingIncoming(call)) continue;
      nowRinging.add(call.id);
      if (!ringing.has(call.id)) {
        ringing.add(call.id);
        bridge.notifyIncomingCall({
          callId: call.id,
          number: call.remoteNumber,
          ...(call.remoteDisplayName ? { displayName: call.remoteDisplayName } : {}),
        });
      }
    }
    for (const id of [...ringing]) {
      if (!nowRinging.has(id)) {
        ringing.delete(id);
        bridge.notifyIncomingCallEnded(id);
      }
    }
  };

  const offs = [
    phone.subscribe(sync),
    phone.on('cdr', (cdr) => {
      if (isMissedCall(cdr)) {
        bridge.notifyMissedCall({
          callId: cdr.callId,
          number: cdr.caller,
          ...(cdr.remoteDisplayName ? { displayName: cdr.remoteDisplayName } : {}),
        });
      }
    }),
    bridge.onCommand((command) => {
      if (command.type === 'openSettings') {
        options.onUiCommand?.(command);
        return;
      }
      executeCommand(phone, command, options).then(
        (outcome) => options.onCommandResult?.(command, outcome),
        (error: unknown) => options.onCommandResult?.(command, error instanceof Error ? error : new Error(String(error))),
      );
    }),
  ];
  sync();
  bridge.ready();

  return () => {
    for (const off of offs) off();
    for (const id of ringing) bridge.notifyIncomingCallEnded(id);
    ringing.clear();
  };
}
