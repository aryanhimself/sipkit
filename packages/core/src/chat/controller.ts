import type { ResolvedConfig } from '../config';
import { SoftphoneError } from '../errors';
import type { Logger, SoftphoneEvents } from '../types';
import { baseContentType, chatPeerKey, incomingPeerKey } from './peer';
import type {
  ChatConversation,
  ChatHistoryStorage,
  ChatMessage,
  ChatMessageStatus,
  ChatState,
  EngineIncomingMessage,
  EngineMessageResult,
} from './types';

export const EMPTY_CHAT_STATE: ChatState = Object.freeze({ conversations: [], unread: 0 }) as ChatState;

/** The only content type sent and displayed. */
export const CHAT_CONTENT_TYPE = 'text/plain';
/** RFC 3994 typing indicator: accepted and ignored. */
const IS_COMPOSING = 'application/im-iscomposing+xml';

type ChatEvent = 'message:received' | 'message:status' | 'conversation:read';

/** Sends one MESSAGE; resolves with the final response (never rejects for a SIP failure). */
export type ChatSender = (
  target: string,
  body: string,
  options: { contentType: string; messageId: string },
) => Promise<EngineMessageResult>;

export interface ChatControllerDeps {
  config: () => ResolvedConfig;
  logger: Logger;
  storage: ChatHistoryStorage;
  /** Undefined when the engine has no MESSAGE support. */
  send?: ChatSender;
  get: () => ChatState;
  set: (next: ChatState) => void;
  emit: <K extends ChatEvent>(event: K, payload: SoftphoneEvents[K]) => void;
  now?: () => number;
}

let idSeq = 0;
function newMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${(++idSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortConversations(list: ChatConversation[]): ChatConversation[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

function stateOf(conversations: ChatConversation[]): ChatState {
  const sorted = sortConversations(conversations);
  return { conversations: sorted, unread: sorted.reduce((n, c) => n + c.unread, 0) };
}

/**
 * 1:1 chat over SIP MESSAGE (V2-CHAT-01): conversations keyed by peer, unread
 * counts, delivery status and pluggable history storage. Engine-agnostic: the
 * Softphone wires `send` to the engine, the React MockSoftphone to a simulator.
 */
export class ChatController {
  private account = '';
  private loadSeq = 0;

  constructor(private readonly d: ChatControllerDeps) {}

  private get cfg(): ResolvedConfig['chat'] {
    return this.d.config().chat;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Conversation key for a target as the user typed it. */
  peerKey(target: string): string {
    return chatPeerKey(target, this.d.config().domain);
  }

  /** (Re)load history after start / a config change (account switch, chat toggled). */
  reconcile(): void {
    const cfg = this.d.config();
    if (!cfg.chat.enabled) {
      this.account = '';
      this.loadSeq++;
      if (this.d.get().conversations.length > 0) this.d.set(EMPTY_CHAT_STATE);
      return;
    }
    const account = `${cfg.username}@${cfg.domain}`;
    if (account === this.account) return;
    this.account = account;
    const seq = ++this.loadSeq;
    if (this.d.get().conversations.length > 0) this.d.set(EMPTY_CHAT_STATE);
    if (!cfg.username) return;
    let loaded: ReturnType<ChatHistoryStorage['load']>;
    try {
      loaded = this.d.storage.load(account);
    } catch (error) {
      this.d.logger.warn('Loading chat history failed', error);
      return;
    }
    const apply = (list: ChatConversation[] | undefined) => {
      if (seq !== this.loadSeq || !list?.length) return;
      this.mergeLoaded(list);
    };
    if (loaded instanceof Promise) {
      loaded.then(apply, (error: unknown) => this.d.logger.warn('Loading chat history failed', error));
    } else apply(loaded);
  }

  /** Send a text message. Resolves with the final message (`sent` or `failed`). */
  async send(to: string, body: string): Promise<ChatMessage> {
    if (!this.cfg.enabled) throw new SoftphoneError('NOT_SUPPORTED', 'Chat is disabled (config chat.enabled)');
    const send = this.d.send;
    if (!send) throw new SoftphoneError('NOT_SUPPORTED', 'The engine does not support SIP MESSAGE');
    const peer = this.peerKey(to);
    if (!peer) throw new SoftphoneError('INVALID_NUMBER', 'Empty chat recipient');
    const text = body.trim();
    if (!text) throw new SoftphoneError('INVALID_ARGUMENT', 'Empty message');
    if (text.length > this.cfg.maxLength) {
      throw new SoftphoneError('INVALID_ARGUMENT', `Message longer than ${this.cfg.maxLength} characters`);
    }
    const message: ChatMessage = {
      id: newMessageId(),
      peer,
      direction: 'outgoing',
      body: text,
      contentType: CHAT_CONTENT_TYPE,
      at: this.now(),
      status: 'sending',
    };
    this.upsert(peer, (conv) => ({ ...conv, messages: [...conv.messages, message], updatedAt: message.at }));
    this.d.emit('message:status', { message, previous: undefined });

    let result: EngineMessageResult;
    try {
      result = await send(peer, text, { contentType: CHAT_CONTENT_TYPE, messageId: message.id });
    } catch (error) {
      this.d.logger.warn(`MESSAGE to ${peer} failed`, error);
      result = { code: 503, reason: error instanceof Error ? error.message : 'Send failed' };
    }
    const ok = result.code >= 200 && result.code < 300;
    return (
      this.setStatus(message.id, peer, ok ? 'sent' : 'failed', result.code, ok ? undefined : result.reason) ?? {
        ...message,
        status: ok ? 'sent' : 'failed',
        code: result.code,
      }
    );
  }

  /**
   * Handle an incoming MESSAGE. Returns the SIP status to answer with:
   * 200 handled (or ignored typing indicator), 480 chat disabled, 415 unsupported type.
   */
  receive(incoming: EngineIncomingMessage): number {
    if (!this.cfg.enabled) {
      this.d.logger.debug('Rejecting MESSAGE: chat is disabled');
      return 480;
    }
    const domain = this.d.config().domain;
    if (incoming.deliveryReport) {
      if (this.cfg.deliveryReports) this.applyDeliveryReport(incoming.deliveryReport);
      return 200;
    }
    const type = baseContentType(incoming.contentType) || CHAT_CONTENT_TYPE;
    if (type === IS_COMPOSING) return 200;
    if (type !== CHAT_CONTENT_TYPE) {
      this.d.logger.info(`Rejecting MESSAGE with unsupported Content-Type ${type}`);
      return 415;
    }
    const peer = incomingPeerKey(incoming.from, incoming.fromHost, domain);
    if (!peer || !incoming.body) return 200;
    const message: ChatMessage = {
      id: newMessageId(),
      peer,
      direction: 'incoming',
      body: incoming.body.slice(0, Math.max(this.cfg.maxLength, 1) * 4),
      contentType: type,
      at: this.now(),
      status: 'received',
    };
    const conversation = this.upsert(peer, (conv) => ({
      ...conv,
      displayName: incoming.fromDisplayName || conv.displayName,
      messages: [...conv.messages, message],
      unread: conv.unread + 1,
      updatedAt: message.at,
    }));
    this.d.emit('message:received', { message, conversation });
    return 200;
  }

  /** Clear the unread count of a conversation. */
  markRead(peerOrTarget: string): void {
    const peer = this.resolvePeer(peerOrTarget);
    const conv = this.d.get().conversations.find((c) => c.peer === peer);
    if (!conv || conv.unread === 0) return;
    this.upsert(peer, (c) => ({ ...c, unread: 0 }));
    this.d.emit('conversation:read', { peer });
  }

  deleteConversation(peerOrTarget: string): void {
    const peer = this.resolvePeer(peerOrTarget);
    const list = this.d.get().conversations;
    if (!list.some((c) => c.peer === peer)) return;
    this.commit(list.filter((c) => c.peer !== peer));
  }

  getConversation(peerOrTarget: string): ChatConversation | undefined {
    const peer = this.resolvePeer(peerOrTarget);
    return this.d.get().conversations.find((c) => c.peer === peer);
  }

  // ------------------------------------------------------------------ internals

  private resolvePeer(peerOrTarget: string): string {
    const list = this.d.get().conversations;
    return list.some((c) => c.peer === peerOrTarget) ? peerOrTarget : this.peerKey(peerOrTarget);
  }

  private applyDeliveryReport(report: NonNullable<EngineIncomingMessage['deliveryReport']>): void {
    const list = this.d.get().conversations;
    let target: ChatMessage | undefined;
    if (report.messageId) {
      for (const c of list) {
        target = c.messages.find((m) => m.id === report.messageId);
        if (target) break;
      }
    }
    if (!target && report.to) {
      // No id (e.g. a PBX that drops custom headers): the latest outgoing message to that peer.
      const conv = list.find((c) => c.peer === this.peerKey(report.to!));
      target = conv?.messages.filter((m) => m.direction === 'outgoing' && m.status !== 'failed').at(-1);
    }
    if (!target || target.direction !== 'outgoing') {
      this.d.logger.debug('Delivery report for an unknown message', report);
      return;
    }
    this.d.logger.info(`Message to ${target.peer} was not delivered (PBX delivery report)`);
    this.setStatus(target.id, target.peer, 'failed', target.code, 'Not delivered');
  }

  private setStatus(
    id: string,
    peer: string,
    status: ChatMessageStatus,
    code: number | undefined,
    reason: string | undefined,
  ): ChatMessage | undefined {
    const conv = this.d.get().conversations.find((c) => c.peer === peer);
    const current = conv?.messages.find((m) => m.id === id);
    if (!conv || !current) return undefined;
    if (current.status === status && current.code === code) return current;
    const next: ChatMessage = { ...current, status, code };
    if (reason) next.reason = reason;
    else delete next.reason;
    this.upsert(peer, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? next : m)) }));
    this.d.emit('message:status', { message: next, previous: current.status });
    return next;
  }

  /** Create or update one conversation, enforce limits, publish + persist. */
  private upsert(peer: string, update: (conv: ChatConversation) => ChatConversation): ChatConversation {
    const list = this.d.get().conversations;
    const existing = list.find((c) => c.peer === peer) ?? { peer, messages: [], unread: 0, updatedAt: this.now() };
    let next = update(existing);
    const limit = this.cfg.historyLimit;
    if (next.messages.length > limit) {
      const kept = next.messages.slice(-limit);
      const keptIncoming = kept.filter((m) => m.direction === 'incoming').length;
      next = { ...next, messages: kept, unread: Math.min(next.unread, keptIncoming) };
    }
    let others = list.filter((c) => c.peer !== peer);
    const max = this.cfg.maxConversations;
    if (others.length + 1 > max) others = sortConversations(others).slice(0, max - 1);
    this.commit([next, ...others]);
    return next;
  }

  private commit(conversations: ChatConversation[]): void {
    this.d.set(stateOf(conversations));
    this.persist();
  }

  private persist(): void {
    if (!this.account) return;
    try {
      const result = this.d.storage.save(this.account, this.d.get().conversations);
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.d.logger.warn('Saving chat history failed', error));
      }
    } catch (error) {
      this.d.logger.warn('Saving chat history failed', error);
    }
  }

  /** Merge stored history under anything that arrived while it was loading. */
  private mergeLoaded(loaded: ChatConversation[]): void {
    const current = new Map(this.d.get().conversations.map((c) => [c.peer, c]));
    const merged: ChatConversation[] = [];
    for (const stored of loaded) {
      if (!stored || typeof stored.peer !== 'string' || !Array.isArray(stored.messages)) continue;
      // A message still "sending" when the page went away never got its answer.
      const messages = stored.messages.map((m) =>
        m.status === 'sending' ? { ...m, status: 'failed' as const, reason: m.reason ?? 'Interrupted' } : m,
      );
      const live = current.get(stored.peer);
      current.delete(stored.peer);
      if (!live) {
        merged.push({ ...stored, messages: messages.slice(-this.cfg.historyLimit), unread: stored.unread || 0 });
        continue;
      }
      const ids = new Set(live.messages.map((m) => m.id));
      merged.push({
        ...live,
        displayName: live.displayName ?? stored.displayName,
        messages: [...messages.filter((m) => !ids.has(m.id)), ...live.messages].slice(-this.cfg.historyLimit),
        unread: live.unread + (stored.unread || 0),
      });
    }
    merged.push(...current.values());
    this.commit(sortConversations(merged).slice(0, this.cfg.maxConversations));
  }
}
