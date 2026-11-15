import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquareIcon, PhoneIcon, SearchIcon, UsersIcon } from 'lucide-react';
import { useChat, usePlugin, usePresence, useRegistration, useSoftphone } from 'sipkit-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSoftphoneUI } from '@/context';
import type { Contact, ContactsPluginApi } from '@/extensions';
import { useI18n } from '@/i18n/context';
import { formatNumber, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyState } from './empty-state';
import { PresenceLamp, presenceDescription } from './presence/presence-lamp';

/** Contacts from the `contacts` prop merged with the `contacts` plugin (if installed). */
export function useContacts(): Contact[] {
  const { contacts: fromProps } = useSoftphoneUI();
  const plugin = usePlugin<ContactsPluginApi>('contacts');
  const [fromPlugin, setFromPlugin] = useState<Contact[]>([]);

  useEffect(() => {
    if (!plugin) return;
    let alive = true;
    const load = () =>
      Promise.resolve(plugin.list())
        .then((list) => alive && setFromPlugin(list.map((c) => ({ ...c, description: c.description ?? c.email }))))
        .catch(() => undefined);
    void load();
    const subscribe = plugin.onChange ?? plugin.subscribe;
    const off = subscribe?.call(plugin, () => void load());
    return () => {
      alive = false;
      off?.();
    };
  }, [plugin]);

  return useMemo(() => {
    const seen = new Set<string>();
    return [...fromProps, ...fromPlugin].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  }, [fromProps, fromPlugin]);
}

const digitsOnly = (s: string) => s.replace(/[^\d]/g, '');

/** Returns a function that finds the contact for a phone number. */
export function useContactLookup(): (number: string) => Contact | undefined {
  const contacts = useContacts();
  return useCallback(
    (number: string) => {
      const n = digitsOnly(number);
      if (!n) return contacts.find((c) => c.number === number);
      return contacts.find((c) => {
        const cn = digitsOnly(c.number);
        return cn === n || (n.length >= 7 && cn.length >= 7 && (cn.endsWith(n) || n.endsWith(cn)));
      });
    },
    [contacts],
  );
}

export interface ContactsListProps {
  className?: string;
  onCall?: (number: string) => void;
}

/** Searchable contact list. Click to call. */
export function ContactsList({ className, onCall }: ContactsListProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  const contacts = useContacts();
  const { presence } = usePresence();
  const chat = useChat();
  const { openChat, api: uiApi } = useSoftphoneUI();
  const canChat = chat.enabled && uiApi !== null;
  const [query, setQuery] = useState('');
  const i18n = useI18n();
  const { t } = i18n;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? contacts.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.number.includes(q) ||
            c.description?.toLowerCase().includes(q),
        )
      : contacts;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, i18n.intlLocale));
  }, [contacts, query, i18n.intlLocale]);

  const dial = (n: string) => (onCall ? onCall(n) : void api.call(n).catch(() => undefined));

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="relative px-3 pt-3 pb-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 start-5.5 mt-0.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t('contacts.search')}
          placeholder={t('contacts.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ps-8"
        />
      </div>
      {contacts.length === 0 ? (
        <EmptyState icon={<UsersIcon />} title={t('contacts.emptyTitle')} description={t('contacts.emptyDescription')} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<SearchIcon />} title={t('contacts.noMatches')} description={t('contacts.noMatchesDescription', { query })} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="px-2 pb-2" aria-label={t('contacts.listLabel')}>
            {filtered.map((c) => {
              const lamp = presence[c.number];
              return (
              <li key={c.id}>
                <div className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/70">
                  <Avatar className="size-9">
                    {c.avatarUrl && <AvatarImage src={c.avatarUrl} alt="" />}
                    <AvatarFallback className="bg-primary/10 text-xs text-primary">{initials(c.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      {lamp && <PresenceLamp state={lamp.state} label={false} />}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {formatNumber(c.number)}
                      {lamp ? ` · ${presenceDescription(t, lamp)}` : ''}
                      {c.description ? ` · ${c.description}` : ''}
                    </div>
                  </div>
                  {canChat && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-primary hover:bg-primary/10 hover:text-primary"
                      aria-label={t('chat.message', { name: c.name })}
                      onClick={() => openChat(c.number)}
                    >
                      <MessageSquareIcon />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-success hover:bg-success/10 hover:text-success"
                    aria-label={t('contacts.call', { name: c.name })}
                    disabled={!reg.isRegistered}
                    onClick={() => dial(c.number)}
                  >
                    <PhoneIcon />
                  </Button>
                </div>
              </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
