import { createContext, useContext, useId, useState } from 'react';
import { CheckCircle2Icon, MicIcon, MicOffIcon } from 'lucide-react';
import type { MicrophonePermission } from 'sipkit-core';
import { useDevices, useSoftphone, useSoftphoneSnapshot } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/context';
import { saveAudioPrefs, type AudioPrefs } from '@/lib/audio-prefs';
import { useNoiseRemoval } from '@/lib/noise-removal';
import { cn } from '@/lib/utils';

function Toggle({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
  testId,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (v: boolean) => void;
  testId?: string;
}) {
  const id = useId();
  const descId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p id={descId} className="text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descId : undefined}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

/** See `SoftphoneProps.microphoneHelp`. */
export interface MicrophoneHelp {
  /** Replaces the "how to unblock" text shown when the mic is blocked. */
  blocked?: string;
  /** Replaces the in-page prompt behind "Allow microphone" (and adds the button to the blocked notice). */
  onAllow?: () => void;
}

export const MicrophoneHelpContext = createContext<MicrophoneHelp | undefined>(undefined);

/**
 * Microphone access, read without prompting. Offers "Allow microphone" only while the browser
 * has not decided; when blocked it explains how to unblock instead of asking again.
 */
export function MicrophoneAccess({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { microphone, requestMicrophone } = useDevices({ enumerate: false });
  const help = useContext(MicrophoneHelpContext);
  const [asking, setAsking] = useState(false);
  if (microphone === 'granted') {
    if (compact) return null;
    return (
      <p data-testid="mic-access" data-state="granted" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2Icon aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        {t('mic.allowed')}
      </p>
    );
  }
  if (microphone === 'denied') {
    return (
      <div
        role="status"
        data-testid="mic-access"
        data-state="denied"
        className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
      >
        <MicOffIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="grid gap-1.5">
          <span>
            <span className="font-medium">{t('mic.blocked')}</span> {help?.blocked ?? t('mic.blockedHelp')}
          </span>
          {help?.onAllow && (
            <button type="button" className="justify-self-start font-medium underline underline-offset-2" onClick={help.onAllow}>
              {t('mic.fix')}
            </button>
          )}
        </span>
      </div>
    );
  }
  if (compact) return null;
  const ask = async () => {
    if (help?.onAllow) {
      help.onAllow();
      return;
    }
    setAsking(true);
    try {
      await requestMicrophone();
    } finally {
      setAsking(false);
    }
  };
  return (
    <div data-testid="mic-access" data-state={microphone satisfies MicrophonePermission} className="grid gap-1">
      <Button variant="outline" size="sm" className="justify-self-start" disabled={asking} onClick={() => void ask()}>
        <MicIcon aria-hidden />
        {t('mic.allow')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('mic.allowHelp')}</p>
    </div>
  );
}

/** Voice processing switches (browser built-in) plus AI noise removal when the plugin is installed. */
export function VoiceProcessingSettings({ onError }: { onError: (e: unknown) => void }) {
  const api = useSoftphone();
  useSoftphoneSnapshot(); // follow config changes
  const t = useT();
  const noise = useNoiseRemoval();
  const ap = api.config.audioProcessing;
  if (!ap) return null;

  const set = (patch: Partial<AudioPrefs>) => {
    const next = { ...ap, ...patch };
    saveAudioPrefs(api.config.username, next);
    api.updateConfig({ audioProcessing: next }).catch(onError);
  };

  return (
    <div className={cn('grid gap-4')} data-testid="voice-processing">
      <Toggle
        testId="noise-suppression"
        label={t('settings.noiseSuppression')}
        description={t('settings.noiseSuppressionDescription')}
        checked={ap.noiseSuppression}
        onCheckedChange={(v) => set({ noiseSuppression: v })}
      />
      {noise && (
        <Toggle
          testId="ai-noise-removal"
          label={t('settings.aiNoiseRemoval')}
          description={noise.supported ? t('settings.aiNoiseRemovalDescription') : t('settings.aiNoiseRemovalUnsupported')}
          checked={noise.enabled && noise.supported}
          disabled={!noise.supported}
          onCheckedChange={(v) => noise.setEnabled(v)}
        />
      )}
      <Toggle
        testId="voice-isolation"
        label={t('settings.voiceIsolation')}
        description={t('settings.voiceIsolationDescription')}
        checked={ap.voiceIsolation}
        onCheckedChange={(v) => set({ voiceIsolation: v })}
      />
      <Toggle
        testId="echo-cancellation"
        label={t('settings.echoCancellation')}
        description={t('settings.echoCancellationDescription')}
        checked={ap.echoCancellation}
        onCheckedChange={(v) => set({ echoCancellation: v })}
      />
      <Toggle
        testId="auto-gain"
        label={t('settings.autoGain')}
        description={t('settings.autoGainDescription')}
        checked={ap.autoGainControl}
        onCheckedChange={(v) => set({ autoGainControl: v })}
      />
    </div>
  );
}
