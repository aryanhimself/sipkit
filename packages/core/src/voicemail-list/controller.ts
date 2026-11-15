import type { ResolvedConfig } from '../config';
import { SoftphoneError } from '../errors';
import type { Logger, MessageSummary, RegistrationState } from '../types';
import { EMPTY_VOICEMAIL_LIST, VoicemailClient, type FetchLike } from './client';
import type { VoicemailListState, VoicemailMessage } from './types';

export interface VoicemailListControllerDeps {
  config: () => ResolvedConfig;
  logger: Logger;
  /** Custom fetch (the React MockSoftphone passes an in-memory backend). */
  fetch?: FetchLike;
  get: () => VoicemailListState;
  /** Publish new state (snapshot `voicemailList` + `voicemail:list`). */
  set: (next: VoicemailListState) => void;
  /** Debounce for MWI-triggered reloads (ms). */
  refreshDelayMs?: number;
}

/** Mailbox used for the list: `voicemail.api.mailbox`, else the SIP username. */
export function voicemailApiMailbox(cfg: ResolvedConfig): string {
  return cfg.voicemail.api.mailbox.trim() || cfg.username.trim();
}

/** `voicemail.enabled`, an API base URL and a mailbox. */
export function isVoicemailListEnabled(cfg: ResolvedConfig): boolean {
  return cfg.voicemail.enabled && Boolean(cfg.voicemail.api.baseUrl.trim()) && Boolean(voicemailApiMailbox(cfg));
}

/**
 * Voicemail list (V2-VM-02). Owns a {@link VoicemailClient} while enabled,
 * mirrors its state into the snapshot, and reloads it after registering and
 * whenever the MWI counts (`snapshot.voicemail`) change, so a new message
 * appears without polling. Engine-agnostic: shared by the Softphone and the
 * React MockSoftphone.
 */
export class VoicemailListController {
  private client: VoicemailClient | null = null;
  private key = '';
  private getToken: unknown;
  private off?: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private registered = false;

  constructor(private readonly d: VoicemailListControllerDeps) {}

  private get cfg(): ResolvedConfig {
    return this.d.config();
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** (Re)create or drop the client after a config change. */
  reconcile(): void {
    const cfg = this.cfg;
    if (!isVoicemailListEnabled(cfg)) {
      this.drop();
      if (this.d.get().status !== 'disabled') this.d.set(EMPTY_VOICEMAIL_LIST);
      return;
    }
    const api = cfg.voicemail.api;
    const key = [api.baseUrl.trim(), voicemailApiMailbox(cfg), api.token, api.timeout].join('|');
    if (this.client && key === this.key && api.getToken === this.getToken) return;
    this.drop();
    this.key = key;
    this.getToken = api.getToken;
    const client = new VoicemailClient({
      baseUrl: api.baseUrl.trim(),
      mailbox: voicemailApiMailbox(cfg),
      token: api.token || undefined,
      getToken: api.getToken,
      timeout: api.timeout,
      fetch: this.d.fetch,
      logger: this.d.logger,
    });
    this.client = client;
    this.off = client.subscribe((state) => this.d.set(state));
    this.d.set(client.getSnapshot());
    if (this.registered && api.autoRefresh) this.refreshQuietly();
  }

  onRegistration(state: RegistrationState): void {
    const was = this.registered;
    this.registered = state === 'registered';
    if (this.registered && !was && this.cfg.voicemail.api.autoRefresh) this.refreshQuietly();
  }

  /** MWI changed (`voicemail:updated`): a message arrived or was handled elsewhere (phone, *97). */
  onSummary(next: MessageSummary, previous: MessageSummary): void {
    if (!this.client || !this.cfg.voicemail.api.autoRefresh) return;
    if (next.new === previous.new && next.old === previous.old) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshQuietly(), this.d.refreshDelayMs ?? 300);
  }

  private refreshQuietly(): void {
    this.client?.list().catch(() => undefined);
  }

  private require(): VoicemailClient {
    if (!this.client)
      throw new SoftphoneError('NOT_SUPPORTED', 'Voicemail list is disabled (config voicemail.enabled + voicemail.api.baseUrl)');
    return this.client;
  }

  async refresh(): Promise<VoicemailMessage[]> {
    return this.require().list();
  }

  async markRead(id: string): Promise<void> {
    await this.require().markRead(id);
  }

  async delete(id: string): Promise<void> {
    return this.require().delete(id);
  }

  async fetchAudio(id: string): Promise<Blob> {
    return this.require().fetchAudio(id);
  }

  /** The underlying client (direct URLs, standalone use), null while disabled. */
  getClient(): VoicemailClient | null {
    return this.client;
  }

  private drop(): void {
    clearTimeout(this.timer);
    this.off?.();
    this.off = undefined;
    this.client?.dispose();
    this.client = null;
    this.key = '';
    this.getToken = undefined;
  }

  dispose(): void {
    this.drop();
    this.registered = false;
  }
}
