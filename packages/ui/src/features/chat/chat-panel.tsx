import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowLeftIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  PhoneIcon,
  RotateCwIcon,
  SendHorizontalIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ChatConversation, ChatMessage } from 'sipkit-core';
import { useChat, useConversation, useRegistration, useSoftphone } from 'sipkit-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSoftphoneUI } from '@/context';
import { useI18n, type I18n } from '@/i18n/context';
import { formatNumber, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from '../contacts';
import { EmptyState } from '../empty-state';
import { UnreadCount } from './unread-badge';

export interface ChatPanelProps {
  className?: string;
  /** Open conversation (controlled). Defaults to the <Softphone /> UI state, else internal state. */
  peer?: string | null;
  onPeerChange?: (peer: string | null) => void;
  /** Dial a number (the thread header's call button). */
  onCall?: (number: string) => void;
}

/** Display name for a peer: contact name, MESSAGE display name, else the formatted number/URI. */
function usePeerName(): (peer: string, conversation?: ChatConversation) => string {
  const lookup = useContactLookup();
  return (peer, conversation) => lookup(peer)?.name ?? conversation?.displayName ?? formatNumber(peer);
}

/**
 * Chat tab (V2-CHAT-01): conversation list with a "new chat" field, and a
 * thread view with delivery status and a composer. Renders nothing unless
 * `chat.enabled`.
 */
export function ChatPanel({ className, peer: peerProp, onPeerChange, onCall }: ChatPanelProps) {
  const ui = useSoftphoneUI();
  const [localPeer, setLocalPeer] = useState<string | null>(null);
  const insideSoftphone = ui.api !== null;
  const peer = peerProp !== undefined ? peerProp : insideSoftphone ? ui.chatPeer : localPeer;
  const setPeer = (next: string | null) => {
    if (onPeerChange) onPeerChange(next);
    else if (insideSoftphone) ui.openChat(next);
    else setLocalPeer(next);
  };
  const chat = useChat();
  if (!chat.enabled) return null;
  return peer ? (
    <ChatThread className={className} peer={peer} onBack={() => setPeer(null)} onCall={onCall} />
  ) : (
    <ConversationList className={className} conversations={chat.conversations} onOpen={setPeer} />
  );
}

function ConversationList({
  className,
  conversations,
  onOpen,
}: {
  className?: string;
  conversations: ChatConversation[];
  onOpen: (peer: string) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const nameOf = usePeerName();
  const [target, setTarget] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = target.trim();
    if (!value) return;
    setTarget('');
    onOpen(value);
  };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid="chat-panel">
      <form className="flex gap-2 px-3 pt-3 pb-2" onSubmit={submit}>
        <Input
          aria-label={t('chat.newLabel')}
          placeholder={t('chat.newPlaceholder')}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          autoComplete="off"
          data-testid="chat-new-target"
        />
        <Button type="submit" size="icon" variant="outline" aria-label={t('chat.start')} disabled={!target.trim()}>
          <MessageSquarePlusIcon aria-hidden />
        </Button>
      </form>
      {conversations.length === 0 ? (
        <EmptyState icon={<MessagesSquareIcon aria-hidden />} title={t('chat.emptyTitle')} description={t('chat.emptyDescription')} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="px-2 pb-2" aria-label={t('chat.listLabel')}>
            {conversations.map((c) => {
              const name = nameOf(c.peer, c);
              const last = c.messages.at(-1);
              return (
                <li key={c.peer}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.peer)}
                    data-testid="chat-conversation"
                    data-peer={c.peer}
                    data-unread={c.unread}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start outline-none hover:bg-muted/70 focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    <Avatar className="size-9">
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">{initials(name)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm', c.unread > 0 ? 'font-semibold' : 'font-medium')}>
                        {name}
                      </span>
                      {last && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {last.direction === 'outgoing' ? `${t('chat.you')}: ` : ''}
                          {last.body}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-xs text-muted-foreground tabular-nums">{i18n.when(c.updatedAt)}</span>
                      <UnreadCount count={c.unread} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function statusLabel(m: ChatMessage, i18n: I18n): string {
  if (m.status === 'sending') return i18n.t('chat.status.sending');
  if (m.status === 'failed') return i18n.t('chat.status.failed');
  return i18n.t('chat.status.sent');
}

function useDocumentVisible(): boolean {
  const get = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const [visible, setVisible] = useState(get);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => setVisible(get());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function ChatThread({
  className,
  peer: target,
  onBack,
  onCall,
}: {
  className?: string;
  peer: string;
  onBack: () => void;
  onCall?: (number: string) => void;
}) {
  const api = useSoftphone();
  const reg = useRegistration();
  const chat = useChat();
  const i18n = useI18n();
  const { t } = i18n;
  const conv = useConversation(target);
  const name = usePeerName()(conv.peer, conv.conversation);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLLIElement>(null);
  const visible = useDocumentVisible();
  const maxLength = api.config.chat.maxLength;

  // Reading the thread clears its unread count.
  useEffect(() => {
    if (visible && conv.unread > 0) conv.markRead();
  }, [visible, conv.unread, conv.markRead]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [conv.messages.length]);

  const send = (body: string) => {
    setError(null);
    conv.send(body).catch((err: unknown) => setError(i18n.error(err)));
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || !reg.isRegistered) return;
    setDraft('');
    send(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const dial = (n: string) => (onCall ? onCall(n) : void api.call(n).catch(() => undefined));

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid="chat-thread" data-peer={conv.peer}>
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button size="icon-sm" variant="ghost" aria-label={t('chat.back')} onClick={onBack}>
          <ArrowLeftIcon className="rtl:rotate-180" aria-hidden />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="chat-thread-title">
          {name}
        </h2>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-success hover:bg-success/10 hover:text-success"
          aria-label={t('chat.call', { name })}
          disabled={!reg.isRegistered || conv.peer.startsWith('sip:')}
          onClick={() => dial(conv.peer)}
        >
          <PhoneIcon aria-hidden />
        </Button>
        {conv.conversation && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={t('chat.delete')}
            onClick={() => {
              chat.deleteConversation(conv.peer);
              onBack();
            }}
          >
            <Trash2Icon aria-hidden />
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {conv.messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t('chat.noMessages')}</p>
        ) : (
          <ol role="log" aria-live="polite" aria-label={t('chat.threadLabel', { name })} className="flex flex-col gap-2 p-3">
            {conv.messages.map((m) => {
              const out = m.direction === 'outgoing';
              return (
                <li
                  key={m.id}
                  data-testid="chat-message"
                  data-direction={m.direction}
                  data-status={m.status}
                  className={cn('flex max-w-[85%] flex-col gap-0.5', out ? 'ms-auto items-end' : 'me-auto items-start')}
                >
                  <span
                    className={cn(
                      'rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap',
                      out ? 'rounded-ee-sm bg-primary text-primary-foreground' : 'rounded-es-sm bg-muted text-foreground',
                      m.status === 'failed' && 'bg-destructive/10 text-destructive',
                    )}
                  >
                    {m.body}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <time dateTime={new Date(m.at).toISOString()}>{i18n.time(m.at)}</time>
                    {out && (
                      <span data-testid="chat-message-status" className={cn(m.status === 'failed' && 'text-destructive')}>
                        · {statusLabel(m, i18n)}
                      </span>
                    )}
                    {out && m.status === 'failed' && reg.isRegistered && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => send(m.body)}
                      >
                        <RotateCwIcon className="size-3" aria-hidden /> {t('chat.retry')}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
            <li ref={endRef} aria-hidden className="h-px" />
          </ol>
        )}
      </ScrollArea>

      {error && (
        <p role="alert" className="px-3 pb-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <form className="flex items-end gap-2 border-t p-2" onSubmit={submit}>
        <textarea
          rows={1}
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!reg.isRegistered}
          aria-label={t('chat.composerLabel', { name })}
          placeholder={reg.isRegistered ? t('chat.composerPlaceholder') : t('chat.notRegistered')}
          data-testid="chat-composer"
          className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button type="submit" size="icon" aria-label={t('chat.send')} disabled={!reg.isRegistered || !draft.trim()}>
          <SendHorizontalIcon className="rtl:rotate-180" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
