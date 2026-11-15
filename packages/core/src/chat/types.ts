/**
 * Chat (1:1 instant messages over SIP MESSAGE, RFC 3428) domain model
 * (roadmap V2-CHAT-01). Re-exported from `types.ts`.
 */

export type ChatMessageDirection = 'incoming' | 'outgoing';

/**
 * Outgoing: `sending` until the server answers, then `sent` (2xx) or `failed`
 * (4xx-6xx, timeout, transport error, or a PBX delivery report). Incoming: `received`.
 */
export type ChatMessageStatus = 'sending' | 'sent' | 'failed' | 'received';

export interface ChatMessage {
  /** Client-generated id (also sent as `X-Sipkit-Message-Id` on outgoing MESSAGEs). */
  id: string;
  /** Conversation key: the remote user ("1002"), or a full SIP URI for foreign domains. */
  peer: string;
  direction: ChatMessageDirection;
  body: string;
  /** MIME type of `body`; only `text/plain` is sent or shown. */
  contentType: string;
  /** Epoch ms (sent / received). */
  at: number;
  status: ChatMessageStatus;
  /** SIP status of the final response (outgoing), e.g. 200, 202, 404, 408. */
  code?: number;
  /** Failure reason (outgoing `failed`), e.g. "Not Found". */
  reason?: string;
}

export interface ChatConversation {
  /** Conversation key, see {@link ChatMessage.peer}. */
  peer: string;
  /** Remote display name from the last incoming MESSAGE, when known. */
  displayName?: string;
  /** Oldest first. Capped at `chat.historyLimit`. */
  messages: ChatMessage[];
  /** Incoming messages not yet marked read. */
  unread: number;
  /** Epoch ms of the latest message (conversations are sorted by it, newest first). */
  updatedAt: number;
}

/** Chat state on the snapshot. Empty while chat is disabled. */
export interface ChatState {
  /** Newest activity first. */
  conversations: ChatConversation[];
  /** Sum of `unread` over all conversations. */
  unread: number;
}

/** An incoming MESSAGE as reported by an engine. */
export interface EngineIncomingMessage {
  /** Sender user part ("1001"), or the full URI when it has no user part. */
  from: string;
  /** Sender host (domain), when known; foreign domains become full-URI peers. */
  fromHost?: string;
  fromDisplayName?: string;
  body: string;
  /** Content-Type without parameters, lower case (e.g. "text/plain"). */
  contentType: string;
  /**
   * Set when the MESSAGE is a delivery report from the PBX (header
   * `X-Sipkit-Delivery: failed;to=<user>;id=<message id>`), not a chat message.
   */
  deliveryReport?: { status: 'failed'; messageId?: string; to?: string };
}

/** Final outcome of an outgoing MESSAGE: the SIP response (or a synthesized 408/503). */
export interface EngineMessageResult {
  code: number;
  reason?: string;
}

/**
 * Pluggable chat history store. `load` / `save` may be sync or async.
 * `account` identifies the signed-in user ("1001@pbx.example.com").
 */
export interface ChatHistoryStorage {
  load(account: string): ChatConversation[] | undefined | Promise<ChatConversation[] | undefined>;
  save(account: string, conversations: ChatConversation[]): void | Promise<void>;
  clear?(account: string): void | Promise<void>;
}
