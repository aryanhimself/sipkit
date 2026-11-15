import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { DeleteIcon, PhoneIcon, VideoIcon } from 'lucide-react';
import { useActiveCall, useRegistration, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useSoftphoneUI } from '@/context';
import { useT } from '@/i18n/context';
import { playDtmfTone } from '@/lib/dtmf-tones';
import { sanitizeDialInput, sanitizePastedNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useVideoAvailable } from './video';

const KEYS: { digit: string; letters?: string }[] = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*' },
  { digit: '0', letters: '+' },
  { digit: '#' },
];

const LONG_PRESS_MS = 550;

export interface DialpadProps {
  /**
   * 'dial': number entry + call button (default).
   * 'dtmf': every key press is sent as DTMF to the active call.
   */
  mode?: 'dial' | 'dtmf';
  /** Controlled value (dial mode). Defaults to the shared Softphone dial value. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Called when the user presses Call / Enter. Default: `api.call(value)`. */
  onCall?: (number: string) => void;
  /** Called by the Video call button (shown with config `video.enabled`). Default: `api.call(value, { video: true })`. */
  onVideoCall?: (number: string) => void;
  /** Play local DTMF feedback tones. Default true. */
  tones?: boolean;
  className?: string;
  autoFocus?: boolean;
}

/**
 * Phone keypad.
 * - type, paste (formatting is stripped), Backspace, Enter to call
 * - long-press 0 for "+"
 * - in 'dtmf' mode sends tones to the active call and plays local feedback
 */
export function Dialpad({
  mode = 'dial',
  value: controlled,
  onValueChange,
  onCall,
  onVideoCall,
  tones = true,
  className,
  autoFocus,
}: DialpadProps) {
  const api = useSoftphone();
  const ui = useSoftphoneUI();
  const active = useActiveCall();
  const reg = useRegistration();
  const t = useT();
  const [dtmfSent, setDtmfSent] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const value = mode === 'dtmf' ? dtmfSent : (controlled ?? ui.dialValue);
  const setValue = useCallback(
    (next: string) => {
      if (mode === 'dtmf') return setDtmfSent(next);
      if (onValueChange) onValueChange(next);
      else ui.setDialValue(next);
    },
    [mode, onValueChange, ui],
  );

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const press = useCallback(
    (key: string) => {
      if (tones) playDtmfTone(key);
      if (mode === 'dtmf') {
        setDtmfSent((v) => (v + key).slice(-24));
        if (active) void api.sendDtmf(key, active.id).catch(() => undefined);
        return;
      }
      const input = inputRef.current;
      // Insert at caret when the input is focused, else append.
      if (input && document.activeElement === input && input.selectionStart !== null) {
        const start = input.selectionStart;
        const end = input.selectionEnd ?? start;
        setValue(value.slice(0, start) + key + value.slice(end));
        requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
      } else {
        setValue(value + key);
      }
    },
    [active, api, mode, setValue, tones, value],
  );

  const call = useCallback(() => {
    const number = value.trim();
    if (!number) return;
    if (onCall) onCall(number);
    else void api.call(number).catch(() => undefined);
    setValue('');
  }, [api, onCall, setValue, value]);

  // Video call button (V2-VID-01, config `video.enabled`).
  const videoAvailable = useVideoAvailable();
  const videoCall = useCallback(() => {
    const number = value.trim();
    if (!number) return;
    if (onVideoCall) onVideoCall(number);
    else void api.call(number, { video: true }).catch(() => undefined);
    setValue('');
  }, [api, onVideoCall, setValue, value]);

  const backspace = () => setValue(value.slice(0, -1));

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'dial') call();
      return;
    }
    if (mode === 'dtmf' && /^[0-9*#A-Da-d]$/.test(e.key)) {
      e.preventDefault();
      press(e.key.toUpperCase());
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    if (mode === 'dtmf') {
      e.preventDefault();
      const tonesText = e.clipboardData.getData('text').replace(/[^0-9*#A-D]/gi, '');
      for (const t of tonesText) press(t.toUpperCase());
      return;
    }
    e.preventDefault();
    const pasted = sanitizePastedNumber(e.clipboardData.getData('text'));
    const input = e.currentTarget;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    setValue(value.slice(0, start) + pasted + value.slice(end));
  }

  const canCall = reg.isRegistered && value.trim().length > 0;

  return (
    <div className={cn('flex flex-col items-center gap-3', className)} data-testid={`dialpad-${mode}`}>
      <div className="relative flex w-full items-center">
        <input
          ref={inputRef}
          value={value}
          readOnly={mode === 'dtmf'}
          onChange={(e) => setValue(sanitizeDialInput(e.target.value))}
          onKeyDown={onInputKeyDown}
          onPaste={onPaste}
          inputMode="tel"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          aria-label={mode === 'dtmf' ? t('dialpad.sentTones') : t('dialpad.numberToDial')}
          placeholder={mode === 'dtmf' ? t('dialpad.keypadPlaceholder') : t('dialpad.placeholder')}
          className={cn(
            'h-12 w-full rounded-lg bg-transparent px-10 text-center font-medium tracking-wide outline-none placeholder:text-base placeholder:font-normal placeholder:tracking-normal',
            'focus-visible:bg-muted/50',
            value.length > 14 ? 'text-xl' : 'text-2xl',
          )}
        />
        {mode === 'dial' && value && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute end-1 text-muted-foreground"
            aria-label={t('dialpad.deleteDigit')}
            onClick={backspace}
            onDoubleClick={() => setValue('')}
          >
            <DeleteIcon />
          </Button>
        )}
      </div>

      {/* Keypads keep the 1-2-3 order in RTL locales too. */}
      <div role="group" aria-label={t('dialpad.keypad')} dir="ltr" className="grid w-full max-w-[17rem] grid-cols-3 gap-x-4 gap-y-2.5">
        {KEYS.map((k) => (
          <DialKey key={k.digit} digit={k.digit} letters={k.letters} onPress={press} />
        ))}
      </div>

      {mode === 'dial' &&
        (videoAvailable ? (
          <div className="mt-1 flex items-center justify-center gap-6">
            <Button
              variant="call-accept"
              className="size-14 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-6"
              aria-label={t('dialpad.call')}
              disabled={!canCall}
              onClick={call}
            >
              <PhoneIcon />
            </Button>
            <Button
              variant="call-accept"
              className="size-14 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-6"
              aria-label={t('video.call')}
              disabled={!canCall}
              onClick={videoCall}
            >
              <VideoIcon />
            </Button>
          </div>
        ) : (
          <Button
            variant="call-accept"
            className="mt-1 size-14 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-6"
            aria-label={t('dialpad.call')}
            disabled={!canCall}
            onClick={call}
          >
            <PhoneIcon />
          </Button>
        ))}
    </div>
  );
}

function DialKey({
  digit,
  letters,
  onPress,
}: {
  digit: string;
  letters?: string;
  onPress: (key: string) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const down = useRef(false);
  const t = useT();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => clear, []);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    longPressed.current = false;
    down.current = true;
    if (digit === '0') {
      timer.current = setTimeout(() => {
        longPressed.current = true;
        onPress('+');
      }, LONG_PRESS_MS);
    }
  }

  function onPointerUp() {
    const wasLong = longPressed.current;
    const wasDown = down.current;
    down.current = false;
    clear();
    if (wasDown && !wasLong) onPress(digit);
  }

  return (
    <button
      type="button"
      aria-label={digit === '0' ? t('dialpad.zeroHold') : digit}
      data-key={digit}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        down.current = false;
        clear();
      }}
      onPointerCancel={() => {
        down.current = false;
        clear();
      }}
      onContextMenu={(e) => e.preventDefault()}
      // Keyboard activation (Enter/Space) fires click with detail 0.
      onClick={(e) => {
        if (e.detail === 0) onPress(digit);
      }}
      className={cn(
        'mx-auto flex size-16 flex-col items-center justify-center rounded-full bg-secondary/80 leading-none text-secondary-foreground transition-[background-color,transform] outline-none select-none',
        'hover:bg-accent active:scale-95 active:bg-primary/15 focus-visible:ring-[3px] focus-visible:ring-ring',
      )}
    >
      <span className="text-2xl font-medium">{digit}</span>
      <span className="mt-0.5 h-3 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
        {letters}
      </span>
    </button>
  );
}
