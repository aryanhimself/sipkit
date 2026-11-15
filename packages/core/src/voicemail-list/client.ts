import type { Logger, Unsubscribe } from '../types';
import type { VoicemailListState, VoicemailMessage, VoicemailTokenProvider } from './types';

export const EMPTY_VOICEMAIL_LIST: VoicemailListState = Object.freeze({
  status: 'disabled',
  messages: [],
  counts: { new: 0, old: 0 },
  pending: [],
}) as unknown as VoicemailListState;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VoicemailClientOptions {
  /** voicemail-api base URL (with or without a trailing slash). */
  baseUrl: string;
  /** "1001" or "1001@context". */
  mailbox: string;
  /** Static bearer token. */
  token?: string;
  /** Token provider (CRM-minted short-lived tokens). Takes precedence over `token`. */
  getToken?: VoicemailTokenProvider;
  /** Request timeout in ms (default 15 s). */
  timeout?: number;
  /** Custom fetch (tests, the mock backend, proxies). Default: global fetch. */
  fetch?: FetchLike;
  logger?: Logger;
}

/** HTTP / network failure of a voicemail-api request. `code` is stable for translations. */
export class VoicemailApiError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'not_found' | 'network' | 'timeout' | 'http',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VoicemailApiError';
  }
}

function countsOf(messages: VoicemailMessage[]): VoicemailListState['counts'] {
  let n = 0;
  for (const m of messages) if (m.folder === 'new') n++;
  return { new: n, old: messages.length - n };
}

/**
 * Framework-free client for `services/voicemail-api` (V2-VM-02): list, stream,
 * mark read, delete, with an observable {@link VoicemailListState}
 * (`getSnapshot()` / `subscribe()`, `useSyncExternalStore`-compatible).
 *
 * The Softphone owns one when `voicemail.api.baseUrl` is set and mirrors its
 * state into `snapshot.voicemailList` (event `voicemail:list`), but it works
 * standalone too:
 *
 *   const vm = new VoicemailClient({ baseUrl, mailbox: '1001', getToken });
 *   await vm.list();
 */
export class VoicemailClient {
  private state: VoicemailListState = { ...EMPTY_VOICEMAIL_LIST, status: 'idle' };
  private readonly listeners = new Set<(s: VoicemailListState) => void>();
  private cachedToken: string | undefined;
  private listSeq = 0;
  private disposed = false;

  constructor(private readonly opts: VoicemailClientOptions) {}

  get mailbox(): string {
    return this.opts.mailbox;
  }

  getSnapshot = (): VoicemailListState => this.state;

  subscribe = (listener: (s: VoicemailListState) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stop notifying listeners (pending requests still settle). */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<VoicemailListState>): void {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (patch.messages) next.counts = countsOf(patch.messages);
    this.state = next;
    for (const l of [...this.listeners]) l(next);
  }

  // ---------------------------------------------------------------- URLs

  private messagesUrl(id?: string, action?: 'audio' | 'read'): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    let url = `${base}/v1/mailboxes/${encodeURIComponent(this.opts.mailbox)}/messages`;
    if (id) url += `/${encodeURIComponent(id)}`;
    if (action) url += `/${action}`;
    return url;
  }

  /**
   * Direct URL of a recording. Plain (`withToken: false`) for hosts that put
   * the API behind a cookie-authenticated proxy; with `withToken` it carries
   * `?access_token=` (only use short-lived tokens: URLs end up in logs and
   * history). {@link fetchAudio} avoids tokens in URLs altogether.
   */
  async audioUrl(id: string, options: { withToken?: boolean } = {}): Promise<string> {
    const url = this.messagesUrl(id, 'audio');
    if (!options.withToken) return url;
    const token = await this.token();
    return token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
  }

  // ---------------------------------------------------------------- requests

  private async token(force = false): Promise<string | undefined> {
    if (this.opts.getToken) {
      if (!force && this.cachedToken) return this.cachedToken;
      this.cachedToken = (await this.opts.getToken()) || undefined;
      return this.cachedToken;
    }
    return this.opts.token || undefined;
  }

  private async request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const doFetch: FetchLike = this.opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    const token = await this.token();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeout ?? 15_000);
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      if (ctrl.signal.aborted) throw new VoicemailApiError('timeout', 'Voicemail request timed out');
      throw new VoicemailApiError('network', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    // Short-lived token expired: fetch a fresh one once and retry.
    if (res.status === 401 && this.opts.getToken && !retried) {
      await this.token(true);
      return this.request(url, init, true);
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        /* not JSON */
      }
      const code = res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : 'http';
      throw new VoicemailApiError(code, message, res.status);
    }
    return res;
  }

  private fail(error: unknown): never {
    const code = error instanceof VoicemailApiError ? error.code : 'network';
    this.opts.logger?.warn('voicemail-api request failed', { code, error: String(error) });
    throw error;
  }

  /** Reload the list. Concurrent calls coalesce to the latest response. */
  async list(): Promise<VoicemailMessage[]> {
    const seq = ++this.listSeq;
    this.set({ status: 'loading' });
    try {
      const res = await this.request(this.messagesUrl());
      const body = (await res.json()) as { messages?: VoicemailMessage[] };
      const messages = [...(body.messages ?? [])].sort((a, b) => b.timestamp - a.timestamp);
      if (seq === this.listSeq) this.set({ status: 'ready', messages, error: undefined, updatedAt: Date.now() });
      return messages;
    } catch (error) {
      if (seq === this.listSeq)
        this.set({ status: 'error', error: error instanceof VoicemailApiError ? error.code : 'network' });
      return this.fail(error);
    }
  }

  private async mutate<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.set({ pending: [...this.state.pending.filter((p) => p !== id), id] });
    try {
      return await run();
    } finally {
      this.set({ pending: this.state.pending.filter((p) => p !== id) });
    }
  }

  /** Move a message to Old (heard). The PBX then publishes the new MWI counts. */
  async markRead(id: string): Promise<VoicemailMessage | undefined> {
    return this.mutate(id, async () => {
      try {
        const res = await this.request(this.messagesUrl(id, 'read'), { method: 'POST' });
        const updated = (await res.json()) as VoicemailMessage;
        this.set({ messages: this.state.messages.map((m) => (m.id === id ? { ...m, ...updated } : m)), error: undefined });
        return updated;
      } catch (error) {
        if (error instanceof VoicemailApiError && error.code === 'not_found')
          this.set({ messages: this.state.messages.filter((m) => m.id !== id) });
        return this.fail(error);
      }
    });
  }

  /** Delete a message (all recordings). Already-gone messages count as deleted. */
  async delete(id: string): Promise<void> {
    return this.mutate(id, async () => {
      try {
        await this.request(this.messagesUrl(id), { method: 'DELETE' });
      } catch (error) {
        if (!(error instanceof VoicemailApiError && error.code === 'not_found')) return this.fail(error);
      }
      this.set({ messages: this.state.messages.filter((m) => m.id !== id), error: undefined });
    });
  }

  /** Download a recording (bearer auth, no token in the URL). Use `URL.createObjectURL` to play it. */
  async fetchAudio(id: string): Promise<Blob> {
    try {
      const res = await this.request(this.messagesUrl(id, 'audio'));
      return await res.blob();
    } catch (error) {
      return this.fail(error);
    }
  }
}
