import type { ReactNode } from 'react';
import { LogOutIcon, MoonIcon, MoreVerticalIcon, RefreshCwIcon, SunIcon, MonitorIcon } from 'lucide-react';
import type { RegistrationState } from 'sipkit-core';
import { useRegistration, useSoftphone, useSoftphoneSnapshot } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSoftphoneUI } from '@/context';
import { DndToggle, VoicemailBadge } from '@/features/voicemail';
import { useI18n, useT } from '@/i18n/context';
import type { MessageKey } from '@/i18n/en';
import { cn } from '@/lib/utils';

const PILL: Record<RegistrationState, { label: MessageKey; dot: string; text: string }> = {
  idle: { label: 'registration.idle', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  connecting: { label: 'registration.connecting', dot: 'bg-warning animate-pulse', text: 'text-foreground' },
  registering: { label: 'registration.registering', dot: 'bg-warning animate-pulse', text: 'text-foreground' },
  registered: { label: 'registration.registered', dot: 'bg-success', text: 'text-foreground' },
  unregistered: { label: 'registration.unregistered', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  failed: { label: 'registration.failed', dot: 'bg-destructive', text: 'text-destructive' },
};

const RESUMING_PILL: { label: MessageKey; dot: string; text: string } = {
  label: 'registration.resuming',
  dot: 'bg-warning animate-pulse',
  text: 'text-foreground',
};

/** Registration status pill with the engine name in a tooltip. */
export function RegistrationPill({ className }: { className?: string }) {
  const reg = useRegistration();
  const engine = useSoftphoneSnapshot((s) => s.engine);
  const i18n = useI18n();
  const { t } = i18n;
  // Reload-safe softphone (docs/resume.md): "Reconnecting…" instead of Offline/Connecting after a reload.
  const resumeActive = useSoftphoneSnapshot((s) => s.resume?.state === 'resuming');
  const resuming = resumeActive && reg.state !== 'registered' && reg.state !== 'failed';
  const pill = resuming ? RESUMING_PILL : PILL[reg.state];
  const label = t(pill.label);
  const detail = reg.state === 'failed' && reg.reason ? i18n.registrationFailure(reg.reason, reg.code) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-live="polite"
          aria-label={
            detail
              ? t('registration.ariaLabelDetail', { status: label, detail })
              : t('registration.ariaLabel', { status: label })
          }
          data-state={reg.state}
          data-resuming={resuming ? 'true' : undefined}
          data-testid="registration-pill"
          tabIndex={0}
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-full border bg-background/70 px-2.5 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
            pill.text,
            className,
          )}
        >
          <span className={cn('size-2 rounded-full', pill.dot)} aria-hidden />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {detail ? `${detail} · ` : ''}
        {t('registration.engine', { engine })}
      </TooltipContent>
    </Tooltip>
  );
}

export interface StatusBarProps {
  className?: string;
  /** Extra content rendered before the menu. */
  actions?: ReactNode;
}

/** Top bar: brand, registration pill, account menu. */
export function StatusBar({ className, actions }: StatusBarProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  // re-render on config changes (brand name, username)
  useSoftphoneSnapshot();
  const { theme, setTheme } = useSoftphoneUI();
  const t = useT();
  const { brandName, username, domain } = api.config;
  const signedIn = reg.state !== 'idle' && reg.state !== 'unregistered';

  return (
    <header
      className={cn(
        'flex h-14 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/70',
        className,
      )}
    >
      <div
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground shadow-sm"
      >
        {brandName.trim().charAt(0).toUpperCase() || 'E'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm leading-tight font-semibold" data-testid="brand-name">
          {brandName}
        </div>
        {username ? (
          <div className="truncate text-xs leading-tight text-muted-foreground">
            <bdi dir="ltr">
              {username}
              {domain ? `@${domain}` : ''}
            </bdi>
          </div>
        ) : null}
      </div>
      <RegistrationPill />
      <VoicemailBadge />
      <DndToggle />
      {actions}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('menu.account')}>
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>{t('menu.theme')}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setTheme('light')} aria-checked={theme === 'light'}>
            <SunIcon /> {t('theme.light')} {theme === 'light' && <span className="ms-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('dark')} aria-checked={theme === 'dark'}>
            <MoonIcon /> {t('theme.dark')} {theme === 'dark' && <span className="ms-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('system')} aria-checked={theme === 'system'}>
            <MonitorIcon /> {t('theme.system')} {theme === 'system' && <span className="ms-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!username}
            onSelect={() => {
              void api.register().catch(() => undefined);
            }}
          >
            <RefreshCwIcon /> {t('menu.reconnect')}
          </DropdownMenuItem>
          {signedIn && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                void api.unregister().catch(() => undefined);
              }}
            >
              <LogOutIcon className="text-destructive" /> {t('menu.signOut')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
