import { useEffect, useId, useState, type ReactNode } from 'react';
import { LogOutIcon } from 'lucide-react';
import type { AudioDevice, AudioDeviceKind } from 'sipkit-core';
import { useDevices, useRegistration, useSoftphone, useSoftphoneSnapshot } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NativeSelect } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useSoftphoneUI, type SoftphoneTheme } from '@/context';
import { useI18n, useT } from '@/i18n/context';
import { getLocaleDefinition, registeredLocales } from '@/i18n/locales';
import { SHORT_EXTENSION_DIGITS, VALID_PREFIX, saveDialPrefs } from '@/lib/dial-prefs';
import { isFeatureEnabled } from '@/lib/features';
import { cn } from '@/lib/utils';
import { PushSettings } from '@/features/push';
import { MicrophoneAccess, VoiceProcessingSettings } from '@/features/audio-settings';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function DeviceSelect({
  kind,
  label,
  devices,
  value,
  onChange,
}: {
  kind: AudioDeviceKind;
  label: string;
  devices: AudioDevice[];
  value: string | undefined;
  onChange: (kind: AudioDeviceKind, id: string) => void;
}) {
  const id = useId();
  const t = useT();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value ?? ''}
        disabled={devices.length === 0}
        onChange={(e) => onChange(kind, e.target.value)}
      >
        {devices.length === 0 && <option value="">{t('settings.noDevices')}</option>}
        {!value && devices.length > 0 && <option value="">{t('settings.systemDefault')}</option>}
        {devices.map((d) => (
          <option key={`${d.kind}-${d.id}`} value={d.id}>
            {d.label || t('settings.unnamedDevice')}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function VolumeRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  const i18n = useI18n();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {i18n.t('unit.percent', { value: Math.round(value * 100) })}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-2 w-full cursor-pointer accent-primary"
      />
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** Dial prefix (e.g. 9 for an outside line), saved per account. */
function DialingSection({ patch }: { patch: (p: { techPrefix?: string; techPrefixMinDigits?: number }) => void }) {
  const api = useSoftphone();
  useSoftphoneSnapshot(); // follow config changes
  const t = useT();
  const cfg = api.config;
  const [draft, setDraft] = useState(cfg.techPrefix);
  useEffect(() => setDraft(cfg.techPrefix), [cfg.techPrefix]);
  const id = useId();
  const descId = useId();
  const errorId = useId();
  const valid = VALID_PREFIX.test(draft);
  const skipShort = cfg.techPrefixMinDigits > 0;

  const commit = (next: { techPrefix?: string; techPrefixMinDigits?: number }) => {
    const prefs = {
      techPrefix: next.techPrefix ?? cfg.techPrefix,
      techPrefixMinDigits: next.techPrefixMinDigits ?? cfg.techPrefixMinDigits,
    };
    saveDialPrefs(cfg.username, prefs);
    patch(prefs);
  };
  const commitDraft = () => {
    if (valid && draft !== cfg.techPrefix) commit({ techPrefix: draft });
  };
  const exampleFrom = '9842477272';

  return (
    <Section title={t('settings.dialing')}>
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{t('settings.dialPrefix')}</Label>
        <Input
          id={id}
          value={draft}
          inputMode="tel"
          dir="ltr"
          autoComplete="off"
          maxLength={8}
          placeholder="9"
          aria-invalid={!valid || undefined}
          aria-describedby={`${descId}${valid ? '' : ` ${errorId}`}`}
          onChange={(e) => setDraft(e.target.value.trim())}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          className="w-32"
        />
        <p id={descId} className="text-xs text-muted-foreground">
          {t('settings.dialPrefixDescription')}
          {cfg.techPrefix && (
            <>
              {' '}
              <span dir="ltr">
                {t('settings.dialPrefixExample', { from: exampleFrom, to: cfg.techPrefix + exampleFrom })}
              </span>
            </>
          )}
        </p>
        {!valid && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {t('settings.dialPrefixInvalid')}
          </p>
        )}
      </div>
      {cfg.techPrefix && (
        <ToggleRow
          label={t('settings.dialPrefixSkipShort')}
          description={t('settings.dialPrefixSkipShortDescription')}
          checked={skipShort}
          onCheckedChange={(v) => commit({ techPrefixMinDigits: v ? SHORT_EXTENSION_DIGITS : 0 })}
        />
      )}
    </Section>
  );
}

/** Audio devices, call behaviour and appearance. */
export function Settings({ className }: { className?: string }) {
  const api = useSoftphone();
  const reg = useRegistration();
  const engine = useSoftphoneSnapshot((s) => s.engine);
  const dnd = useSoftphoneSnapshot((s) => s.dnd);
  useSoftphoneSnapshot(); // re-render when config changes
  const devices = useDevices();
  const { theme, setTheme, locale, setLocale } = useSoftphoneUI();
  const i18n = useI18n();
  const { t } = i18n;
  const [error, setError] = useState<string | null>(null);
  const cfg = api.config;
  const themeId = useId();
  const languageId = useId();
  const languages = registeredLocales();

  const setDevice = (kind: AudioDeviceKind, id: string) => {
    setError(null);
    devices.setDevice(kind, id).catch((e: unknown) => setError(i18n.error(e)));
  };
  const patch = (p: Parameters<typeof api.updateConfig>[0]) => {
    setError(null);
    api.updateConfig(p).catch((e: unknown) => setError(i18n.error(e)));
  };

  return (
    <ScrollArea className={cn('min-h-0 flex-1', className)}>
      <div className="grid gap-6 p-4">
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <Section title={t('settings.audio')}>
          <MicrophoneAccess />
          <DeviceSelect
            kind="microphone"
            label={t('settings.microphone')}
            devices={devices.microphones}
            value={devices.selected.microphone}
            onChange={setDevice}
          />
          <DeviceSelect
            kind="speaker"
            label={t('settings.speaker')}
            devices={devices.speakers}
            value={devices.selected.speaker}
            onChange={setDevice}
          />
          <DeviceSelect
            kind="ringer"
            label={t('settings.ringer')}
            devices={devices.ringers}
            value={devices.selected.ringer}
            onChange={setDevice}
          />
          <VolumeRow label={t('settings.speakerVolume')} value={devices.volume.speaker ?? 1} onChange={(v) => devices.setVolume('speaker', v)} />
          <VolumeRow label={t('settings.ringerVolume')} value={devices.volume.ringer ?? 1} onChange={(v) => devices.setVolume('ringer', v)} />
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void devices.refresh().catch(() => undefined)}>
            {t('settings.refreshDevices')}
          </Button>
          <VoiceProcessingSettings onError={(e) => setError(i18n.error(e))} />
        </Section>
        {cfg.video?.enabled && isFeatureEnabled(cfg, 'video') && (
          <>
            <Separator />
            <Section title={t('settings.video')}>
              <DeviceSelect
                kind="camera"
                label={t('settings.camera')}
                devices={devices.cameras}
                value={devices.selected.camera}
                onChange={setDevice}
              />
            </Section>
          </>
        )}
        <Separator />
        <Section title={t('settings.calls')}>
          <ToggleRow
            label={t('settings.autoAnswer')}
            description={t('settings.autoAnswerDescription')}
            checked={cfg.autoAnswer}
            onCheckedChange={(v) => patch({ autoAnswer: v })}
          />
          <ToggleRow
            label={t('settings.rejectOnBusy')}
            description={t('settings.rejectOnBusyDescription')}
            checked={cfg.rejectOnBusy}
            onCheckedChange={(v) => patch({ rejectOnBusy: v })}
          />
          {isFeatureEnabled(cfg, 'dnd') && (
            <ToggleRow
              label={t('settings.dnd')}
              description={
                cfg.dnd.mode === 'local' ? t('settings.dndDescription') : t('settings.dndServerDescription')
              }
              checked={dnd}
              onCheckedChange={(v) => void Promise.resolve(api.setDnd(v)).catch(() => undefined)}
            />
          )}
          <PushSettings />
        </Section>
        <Separator />
        <DialingSection patch={patch} />
        <Separator />
        <Section title={t('settings.appearance')}>
          <div className="grid gap-1.5">
            <Label htmlFor={themeId}>{t('settings.theme')}</Label>
            <NativeSelect id={themeId} value={theme} onChange={(e) => setTheme(e.target.value as SoftphoneTheme)}>
              <option value="system">{t('theme.system')}</option>
              <option value="light">{t('theme.light')}</option>
              <option value="dark">{t('theme.dark')}</option>
            </NativeSelect>
          </div>
          {languages.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={languageId}>{t('settings.language')}</Label>
              <NativeSelect
                id={languageId}
                value={languages.find((c) => c.toLowerCase() === i18n.code.toLowerCase()) ?? locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                {languages.map((code) => (
                  <option key={code} value={code} lang={code}>
                    {getLocaleDefinition(code)?.messages['meta.languageName'] ?? code}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </Section>
        <Separator />
        <Section title={t('settings.account')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('settings.user')}</dt>
            <dd className="truncate">{cfg.username || '—'}</dd>
            <dt className="text-muted-foreground">{t('settings.domain')}</dt>
            <dd className="truncate">{cfg.domain || '—'}</dd>
            <dt className="text-muted-foreground">{t('settings.engine')}</dt>
            <dd className="truncate">{engine}</dd>
          </dl>
          {reg.state !== 'idle' && reg.state !== 'unregistered' && (
            <Button
              variant="outline"
              className="justify-self-start text-destructive hover:text-destructive"
              onClick={() => void api.unregister().catch(() => undefined)}
            >
              <LogOutIcon /> {t('settings.signOut')}
            </Button>
          )}
        </Section>
      </div>
    </ScrollArea>
  );
}
