import type { EngineIncomingMessage, EngineListener, EnginePresenceUpdate, EngineVideoState, MessageSummary, RegistrationState, RegistrationStatus, SoftphoneEvents } from '../types';
import type { CallControl } from './call-control';
import type { CallRegistry } from './call-registry';
import type { ServiceCalls } from './service-call';

export interface EngineListenerDeps {
  isActive: () => boolean;
  isStarted: () => boolean;
  registrationState: () => RegistrationState;
  setRegistration: (status: RegistrationStatus) => void;
  emit: <K extends keyof SoftphoneEvents>(event: K, payload: SoftphoneEvents[K]) => void;
  control: CallControl;
  calls: CallRegistry;
  onMessageSummary?: (summary: MessageSummary) => void;
  /** Silent feature-code calls: their progress never reaches call control. */
  serviceCalls?: ServiceCalls;
  onPresence?: (update: EnginePresenceUpdate) => void;
  /** Incoming MESSAGE; returns the SIP status to answer with. */
  onMessage?: (message: EngineIncomingMessage) => number;
  onCallVideo?: (engineCallId: string, state: EngineVideoState) => void;
}

/** Translate engine facts into Softphone state. Callbacks after destroy() are ignored. */
export function createEngineListener(d: EngineListenerDeps): EngineListener {
  return {
    onTransportState: (state, reason) => {
      if (!d.isActive()) return;
      const current = d.registrationState();
      if (state === 'connecting') d.setRegistration({ state: 'connecting' });
      else if (state === 'disconnected' && ['registered', 'registering', 'connecting'].includes(current)) {
        d.setRegistration({ state: 'unregistered', reason: reason ?? 'Transport disconnected' });
      }
    },
    onRegistration: (status) => {
      if (!d.isActive()) return;
      d.setRegistration(status);
      if (status.state === 'failed') {
        d.emit('notification', {
          level: 'error',
          title: 'Registration failed',
          message: status.reason ?? (status.code ? `SIP ${status.code}` : undefined),
          code: 'registrationFailed',
          params: { ...(status.reason ? { reason: status.reason } : {}), ...(status.code ? { code: status.code } : {}) },
        });
      }
    },
    onIncomingCall: (engineCallId, info) => {
      if (d.isActive()) d.control.handleIncoming(engineCallId, info, d.isStarted());
    },
    onCallProgress: (engineCallId, progress) => {
      if (!d.isActive() || d.serviceCalls?.handleProgress(engineCallId, progress)) return;
      d.control.handleProgress(engineCallId, progress);
    },
    onDtmf: (engineCallId, digit) => {
      const record = d.calls.byEngineId(engineCallId);
      if (record && d.isActive()) d.emit('call:dtmf-received', { callId: record.call.id, digit });
    },
    onMessageSummary: (summary) => {
      if (d.isActive()) d.onMessageSummary?.(summary);
    },
    onPresence: (update) => {
      if (d.isActive()) d.onPresence?.(update);
    },
    onMessage: (message) => (d.isActive() && d.onMessage ? d.onMessage(message) : 480),
    onCallVideo: (engineCallId, state) => {
      if (d.isActive()) d.onCallVideo?.(engineCallId, state);
    },
  };
}
