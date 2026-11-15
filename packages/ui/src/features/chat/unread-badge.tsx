import { useChat } from 'sipkit-react';
import { useI18n } from '@/i18n/context';
import { cn } from '@/lib/utils';

/** Pill with an unread count; nothing when 0. Screen readers get the full "n unread messages" text. */
export function UnreadCount({ count, className, testId }: { count: number; className?: string; testId?: string }) {
  const i18n = useI18n();
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      data-count={count}
      className={cn(
        'inline-grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground',
        className,
      )}
    >
      <span aria-hidden>{count > 99 ? `${i18n.number(99)}+` : i18n.number(count)}</span>
      <span className="sr-only">{i18n.t('chat.unread', { count })}</span>
    </span>
  );
}

/** Total unread chat messages (for the Chat tab label). Nothing when chat is off or all read. */
export function ChatUnreadBadge({ className }: { className?: string }) {
  const chat = useChat();
  if (!chat.enabled) return null;
  return <UnreadCount count={chat.unread} className={className} testId="chat-unread-badge" />;
}
