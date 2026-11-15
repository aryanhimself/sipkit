import { useCallback, useMemo } from 'react';
import {
  chatPeerKey,
  isFeatureEnabled,
  type ChatConversation,
  type ChatMessage,
} from 'sipkit-core';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseChatResult {
  /** `chat.enabled` and "chat" not in `disabledFeatures`. */
  enabled: boolean;
  /** Newest activity first. */
  conversations: ChatConversation[];
  /** Unread incoming messages across all conversations. */
  unread: number;
  /** Send a text message (SIP MESSAGE). Resolves with the final `sent` / `failed` message. */
  send: (to: string, body: string) => Promise<ChatMessage>;
  markRead: (peer: string) => void;
  deleteConversation: (peer: string) => void;
}

/** Chat conversations, unread total and actions (V2-CHAT-01). */
export function useChat(): UseChatResult {
  const api = useSoftphone();
  const chat = useSoftphoneSnapshot((s) => s.chat);
  const cfg = api.config;
  const send = useCallback((to: string, body: string) => api.sendMessage(to, body), [api]);
  const markRead = useCallback((peer: string) => api.markConversationRead(peer), [api]);
  const deleteConversation = useCallback((peer: string) => api.deleteConversation(peer), [api]);
  return {
    enabled: cfg.chat.enabled && isFeatureEnabled(cfg, 'chat'),
    conversations: chat.conversations,
    unread: chat.unread,
    send,
    markRead,
    deleteConversation,
  };
}

export interface UseConversationResult {
  /** Conversation key ("1002", or a full SIP URI for foreign domains); '' without a peer. */
  peer: string;
  /** Undefined until the first message is sent or received. */
  conversation: ChatConversation | undefined;
  /** Oldest first. */
  messages: ChatMessage[];
  unread: number;
  /** Send to this peer. */
  send: (body: string) => Promise<ChatMessage>;
  markRead: () => void;
}

const NO_MESSAGES: ChatMessage[] = [];

/** One conversation by peer key or target ("1002", "sip:1002@pbx"). */
export function useConversation(peerOrTarget: string | null | undefined): UseConversationResult {
  const api = useSoftphone();
  const domain = api.config.domain;
  const peer = useMemo(() => (peerOrTarget ? chatPeerKey(peerOrTarget, domain) : ''), [peerOrTarget, domain]);
  const conversation = useSoftphoneSnapshot((s) =>
    peer ? s.chat.conversations.find((c) => c.peer === peer || c.peer === peerOrTarget) : undefined,
  );
  const key = conversation?.peer ?? peer;
  const send = useCallback((body: string) => api.sendMessage(key, body), [api, key]);
  const markRead = useCallback(() => {
    if (key) api.markConversationRead(key);
  }, [api, key]);
  return {
    peer: key,
    conversation,
    messages: conversation?.messages ?? NO_MESSAGES,
    unread: conversation?.unread ?? 0,
    send,
    markRead,
  };
}
