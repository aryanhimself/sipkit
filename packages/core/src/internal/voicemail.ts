import type { ResolvedConfig } from '../config';
import type {
  Logger,
  MessageSummary,
  RegistrationState,
  SoftphoneEngine,
  VoicemailState,
} from '../types';
import { EMPTY_MESSAGE_SUMMARY, sameSummary, voicemailNumberFromAccount } from './message-summary';

export interface VoicemailDeps {
  engine: SoftphoneEngine;
  config: () => ResolvedConfig;
  logger: Logger;
  get: () => VoicemailState;
  /** Publish new state (snapshot + `voicemail:updated`). */
  set: (next: VoicemailState) => void;
}

/**
 * Message waiting indication (V2-VM-01). Subscribes to message-summary each
 * time registration is (re-)established, drops the subscription when it is
 * lost, and folds NOTIFYs (subscribed or unsolicited) into snapshot state.
 */
export class VoicemailController {
  private registered = false;
  private subscribed = false;
  private warnedUnsupported = false;

  constructor(private readonly d: VoicemailDeps) {}

  private get cfg(): ResolvedConfig['voicemail'] {
    return this.d.config().voicemail;
  }

  /** Feed every registration state change. */
  onRegistration(state: RegistrationState): void {
    const was = this.registered;
    this.registered = state === 'registered';
    if (this.registered && !was) this.subscribe();
    else if (!this.registered && was) this.unsubscribe();
    // Engine stopped (sign-out, account change): the counts belong to the old session.
    if (state === 'idle') this.reset();
  }

  /** Re-evaluate after a config change. */
  reconcile(): void {
    if (!this.cfg.enabled) {
      this.unsubscribe();
      this.reset();
      return;
    }
    if (!this.cfg.subscribe) this.unsubscribe();
    else if (this.registered && !this.subscribed) this.subscribe();
  }

  handleSummary(summary: MessageSummary): void {
    if (!this.cfg.enabled) {
      this.d.logger.debug('Ignoring message-summary: voicemail is disabled');
      return;
    }
    const next: VoicemailState = { ...summary };
    if (!sameSummary(next, this.d.get())) this.d.set(next);
  }

  /** Configured voicemail number, else the user part of the server's Message-Account. */
  number(): string | undefined {
    return this.cfg.number.trim() || voicemailNumberFromAccount(this.d.get().account);
  }

  dispose(): void {
    this.unsubscribe();
    this.registered = false;
  }

  private subscribe(): void {
    if (!this.cfg.enabled || !this.cfg.subscribe || this.subscribed) return;
    const engine = this.d.engine;
    if (!engine.subscribeMessageSummary) {
      if (!this.warnedUnsupported)
        this.d.logger.info(`Engine "${engine.name}" has no MWI subscription support`);
      this.warnedUnsupported = true;
      return;
    }
    this.subscribed = true;
    engine.subscribeMessageSummary(this.cfg.mailbox.trim() || undefined).catch((error: unknown) => {
      this.subscribed = false;
      this.d.logger.warn('message-summary SUBSCRIBE failed', error);
    });
  }

  private unsubscribe(): void {
    if (!this.subscribed) return;
    this.subscribed = false;
    this.d.engine
      .unsubscribeMessageSummary?.()
      .catch((error: unknown) => this.d.logger.debug('message-summary unsubscribe failed', error));
  }

  private reset(): void {
    if (!sameSummary(this.d.get(), EMPTY_MESSAGE_SUMMARY)) this.d.set({ ...EMPTY_MESSAGE_SUMMARY });
  }
}
