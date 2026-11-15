import {
  PhoneOffIcon,
  SplitIcon,
  UserMinusIcon,
  UsersIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import type { Call, ConferenceCapabilities, ConferencePartyView } from 'sipkit-core';
import { useCallTimer, useCalls, useConference, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useI18n, useT, type Translate } from '@/i18n/context';
import { callTitle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from './contacts';

/** Conference members (calls in the local mix that are still live). */
export function useConferenceCalls(): Call[] {
  return useCalls().filter((c) => c.inConference && c.state !== 'disconnected');
}

function partyStatus(call: Call, timer: string, t: Translate): string {
  if (call.state === 'held') return t('call.onHold', { timer });
  if (call.state === 'connected')
    return call.hold === 'remote' ? t('call.heldByRemote', { timer }) : timer;
  return call.direction === 'outgoing' ? t('call.calling') : t('call.ringing');
}

const swallow = (fn: () => Promise<unknown> | void) => () => {
  void Promise.resolve()
    .then(fn)
    .catch(() => undefined);
};

/**
 * Conference roster (roadmap V2-CONF-01): every party with its state and
 * timer, per-party mute / remove / hang up, and Split / End conference.
 * Works for the local mix and for a server (ConfBridge) room alike: controls
 * follow the conference's `capabilities`. Renders nothing without a conference.
 */
export function ConferencePanel({ className }: { className?: string }) {
  const api = useSoftphone();
  const conference = useConference();
  const t = useT();
  if (!conference) return null;
  const { capabilities, parties } = conference;
  const members = conference.calls;
  return (
    <section
      aria-label={t('conference.region')}
      data-testid="conference-panel"
      className={cn('mx-3 mb-2 shrink-0 rounded-lg border bg-card text-card-foreground', className)}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <UsersIcon className="size-4" aria-hidden />
        <span className="flex-1">{t('conference.header', { count: parties.length })}</span>
        {conference.room && (
          <span data-testid="conference-room" className="tabular-nums">
            {t('conference.room', { room: conference.room })}
          </span>
        )}
      </header>
      <ul aria-label={t('conference.parties')} className="divide-y">
        {parties.map((party) =>
          party.call ? (
            <ConferenceParty key={party.id} call={party.call} capabilities={capabilities} />
          ) : (
            <RoomParty key={party.id} party={party} />
          ),
        )}
      </ul>
      <div className="flex gap-2 border-t px-3 py-2">
        {capabilities.split && (
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            data-testid="conference-split"
            onClick={swallow(() => api.splitConference())}
          >
            <SplitIcon aria-hidden /> {t('conference.split')}
          </Button>
        )}
        <Button
          size="sm"
          variant="call-end"
          className="flex-1"
          data-testid="conference-end"
          title={capabilities.survivesLeave ? t('conference.leaveTitle') : undefined}
          onClick={swallow(() => Promise.all(members.map((c) => api.hangup(c.id))))}
        >
          <PhoneOffIcon aria-hidden />{' '}
          {capabilities.survivesLeave ? t('conference.leave') : t('conference.end')}
        </Button>
      </div>
    </section>
  );
}

/** A party in a server room: known from the transfer, no per-party control from the client. */
function RoomParty({ party }: { party: ConferencePartyView }) {
  const lookup = useContactLookup();
  const timer = useCallTimer({ connectedAt: party.since, state: 'connected' });
  const i18n = useI18n();
  const name = party.remoteDisplayName || lookup(party.remoteNumber)?.name || party.remoteNumber;
  return (
    <li
      data-testid="conference-party"
      data-party-id={party.id}
      className="flex items-center gap-2 px-3 py-1.5 text-sm"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span
          className="block text-xs text-muted-foreground tabular-nums"
          data-testid="conference-party-status"
        >
          {i18n.t('conference.inRoom', { timer: i18n.duration(timer.elapsedMs) })}
        </span>
      </span>
    </li>
  );
}

function ConferenceParty({
  call,
  capabilities,
}: {
  call: Call;
  capabilities: ConferenceCapabilities;
}) {
  const api = useSoftphone();
  const lookup = useContactLookup();
  const timer = useCallTimer(call);
  const i18n = useI18n();
  const { t } = i18n;
  const name = callTitle(call, lookup(call.remoteNumber)?.name);
  const muted = call.partyMuted === true;
  return (
    <li
      data-testid="conference-party"
      data-call-id={call.id}
      data-line={call.line}
      data-state={call.state}
      className="flex items-center gap-2 px-3 py-1.5 text-sm"
    >
      <span className="w-6 shrink-0 text-xs font-semibold text-muted-foreground">
        {t('call.lineShort', { line: call.line })}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate font-medium',
            muted && 'text-muted-foreground line-through',
          )}
        >
          {name}
        </span>
        <span
          className="block text-xs text-muted-foreground tabular-nums"
          data-testid="conference-party-status"
        >
          {partyStatus(call, i18n.duration(timer.elapsedMs), t)}
        </span>
      </span>
      {capabilities.partyMute && (
        <Button
          size="icon-sm"
          variant={muted ? 'secondary' : 'ghost'}
          className="size-7"
          aria-label={muted ? t('conference.unmute', { name }) : t('conference.mute', { name })}
          aria-pressed={muted}
          title={muted ? t('conference.unmuteTitle') : t('conference.muteTitle')}
          onClick={() => {
            try {
              api.setPartyMuted(call.id, !muted);
            } catch {
              /* party left meanwhile */
            }
          }}
        >
          {muted ? <VolumeXIcon aria-hidden /> : <Volume2Icon aria-hidden />}
        </Button>
      )}
      {capabilities.removeParty && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-7"
          aria-label={t('conference.remove', { name })}
          title={t('conference.removeTitle')}
          onClick={swallow(() => api.removeFromConference(call.id))}
        >
          <UserMinusIcon aria-hidden />
        </Button>
      )}
      {capabilities.hangupParty && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-7 text-destructive hover:text-destructive"
          aria-label={t('conference.hangUp', { name })}
          title={t('conference.hangUpTitle')}
          onClick={swallow(() => api.hangup(call.id))}
        >
          <PhoneOffIcon aria-hidden />
        </Button>
      )}
    </li>
  );
}
