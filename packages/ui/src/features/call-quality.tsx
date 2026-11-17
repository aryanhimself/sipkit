import type { Call, CallQuality, QualityLevel } from 'sipkit-core';
import { useCallQuality } from 'sipkit-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, useT, type I18n } from '@/i18n/context';
import type { MessageKey } from '@/i18n/en';
import { cn } from '@/lib/utils';

const LEVEL_TEXT: Record<QualityLevel, MessageKey> = { good: 'quality.good', fair: 'quality.fair', poor: 'quality.poor' };
const LEVEL_BARS: Record<QualityLevel, number> = { good: 3, fair: 2, poor: 1 };
const LEVEL_COLOR: Record<QualityLevel, string> = {
  good: 'text-success',
  fair: 'text-warning-foreground dark:text-warning',
  poor: 'text-destructive',
};

type UnitKey = 'unit.ms' | 'unit.kbps' | 'unit.percent';

const fmt = (i18n: I18n, value: number | undefined, unit: UnitKey, digits = 0) =>
  value === undefined
    ? '—'
    : i18n.t(unit, { value: i18n.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits }) });

function pair(a: string, b: string) {
  return a === b ? a : `${a} / ${b}`;
}

/** The numbers behind the indicator (tooltip body). */
export function CallQualityDetails({ quality }: { quality: CallQuality }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rows: [string, string][] = [
    [t('quality.mos'), i18n.number(quality.mos, { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
    [t('quality.loss'), pair(fmt(i18n, quality.inbound.packetLossPct, 'unit.percent', 1), fmt(i18n, quality.outbound.packetLossPct, 'unit.percent', 1))],
    [t('quality.jitter'), pair(fmt(i18n, quality.inbound.jitterMs, 'unit.ms'), fmt(i18n, quality.outbound.jitterMs, 'unit.ms'))],
    [t('quality.roundTrip'), fmt(i18n, quality.rttMs, 'unit.ms')],
    [t('quality.bitrate'), pair(fmt(i18n, quality.inbound.bitrateKbps, 'unit.kbps'), fmt(i18n, quality.outbound.bitrateKbps, 'unit.kbps'))],
  ];
  if (quality.codec) rows.push([t('quality.codec'), quality.codec.toUpperCase()]);
  return (
    <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-start tabular-nums" data-testid="call-quality-details">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="opacity-70">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface CallQualityIndicatorProps {
  call: Call;
  className?: string;
}

/**
 * Signal-bars indicator of the call's media quality (good / fair / poor) with
 * the measured numbers in a tooltip. Renders nothing until the first sample
 * or while the call is not connected.
 */
export function CallQualityIndicator({ call, className }: CallQualityIndicatorProps) {
  const quality = useCallQuality(call.id);
  const t = useT();
  if (!quality || call.state !== 'connected') return null;
  const { level } = quality;
  const bars = quality.noAudio ? 0 : LEVEL_BARS[level];
  const label = quality.noAudio ? t('quality.noAudio') : t(LEVEL_TEXT[level]);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('quality.ariaLabel', { level: label })}
            data-testid="call-quality"
            data-level={level}
            data-no-audio={quality.noAudio}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium outline-none',
              'hover:bg-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring',
              LEVEL_COLOR[level],
              className,
            )}
          >
            <svg viewBox="0 0 14 12" className="size-3.5" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <rect
                  key={i}
                  x={i * 5}
                  y={8 - i * 4}
                  width="3.5"
                  height={4 + i * 4}
                  rx="1"
                  fill="currentColor"
                  opacity={i < bars ? 1 : 0.25}
                />
              ))}
            </svg>
            <span>{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <CallQualityDetails quality={quality} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
