import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { DeleteIcon, HistoryIcon, PhoneIcon, UserIcon, VideoIcon } from 'lucide-react';
import { useActiveCall, useRegistration, useSoftphone, useSoftphoneSnapshot } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useSoftphoneUI } from '@/context';
import { useT } from '@/i18n/context';
import { playDtmfTone } from '@/lib/dtmf-tones';
import { formatNumber, sanitizeDialInput, sanitizePastedNumber } from '@/lib/format';
import { buildDialSuggestions, type DialSuggestion } from '@/lib/suggestions';
import { cn } from '@/lib/utils';
import { useCallHistory } from './call-history';
import { useContacts } from './contacts';
import { useVideoAvailable } from './video';

/** The number the PBX will receive once the configured dial prefix is applied, or null when none applies. */
export function prefixedNumber(value: string, prefix: string, minDigits: number): string | null {
  const v = value.trim();
  if (!prefix || !v || /^sips?:/i.test(v) || v.includes('@')) return null;
  if (minDigits > 0 && v.replace(/\D/g, '').length < minDigits) return null;
  return prefix + v;
}

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
  /** Suggest numbers from call history and contacts while typing (dial mode). Default true. */
  suggestions?: boolean;
  className?: string;
  /**
   * Focus the number field on mount. `true` always takes focus (e.g. a keypad the user just
   * opened); `'if-idle'` only when nothing else has focus, so switching tabs with the keyboard
   * doesn't pull focus out of the tab bar.
   */
  autoFocus?: boolean | 'if-idle';
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
  suggestions: suggestionsEnabled = true,
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
  const listId = useId();
  const hintId = useId();
  const statusId = useId();
  useSoftphoneSnapshot(); // re-render when config (dial prefix) changes
  const { items: history } = useCallHistory();
  const contacts = useContacts();
  // Autocomplete: open after the value changes, closed by Escape, a pick, a call or blur.
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(false);

  const value = mode === 'dtmf' ? dtmfSent : (controlled ?? ui.dialValue);
  const setValue = useCallback(
    (next: string) => {
      if (mode === 'dtmf') return setDtmfSent(next);
      if (onValueChange) onValueChange(next);
      else ui.setDialValue(next);
      setListOpen(next.trim().length > 0);
      setActiveIndex(-1);
    },
    [mode, onValueChange, ui],
  );

  const suggestions = useMemo(
    () =>
      mode === 'dial' && suggestionsEnabled
        ? buildDialSuggestions(value, history, contacts, { self: api.config.username })
        : [],
    [api.config.username, contacts, history, mode, suggestionsEnabled, value],
  );
  // The full list drops down only while typing in the field; keypad users get the top match as a chip.
  const open = listOpen && inputFocused && suggestions.length > 0;
  const topMatch = !open && listOpen && suggestions.length > 0 ? suggestions[0] : undefined;
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const prefixed =
    mode === 'dial' ? prefixedNumber(value, api.config.techPrefix, api.config.techPrefixMinDigits) : null;

  const pick = useCallback(
    (s: DialSuggestion) => {
      setValue(s.number);
      setListOpen(false);
      inputRef.current?.focus({ preventScroll: true });
    },
    [setValue],
  );

  useEffect(() => {
    if (!autoFocus) return;
    if (autoFocus === 'if-idle') {
      const current = document.activeElement;
      if (current && current !== document.body && current !== document.documentElement) return;
    }
    inputRef.current?.focus({ preventScroll: true });
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
    setListOpen(false);
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
    if (mode === 'dial' && suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (!open) {
        setListOpen(true);
        setActiveIndex(e.key === 'ArrowDown' ? 0 : suggestions.length - 1);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Cycle options, passing through -1 (back to the text field) at either end.
      setActiveIndex((i) => {
        const next = i + step;
        if (next >= suggestions.length) return -1;
        if (next < -1) return suggestions.length - 1;
        return next;
      });
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setListOpen(false);
      return;
    }
    if (e.key === 'Enter' && open && activeIndex >= 0 && suggestions[activeIndex]) {
      e.preventDefault();
      e.stopPropagation();
      pick(suggestions[activeIndex]);
      return;
    }
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
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          {...(mode === 'dial' && suggestionsEnabled
            ? {
                role: 'combobox',
                'aria-autocomplete': 'list' as const,
                'aria-expanded': open,
                'aria-controls': listId,
                'aria-activedescendant': open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
              }
            : {})}
          aria-describedby={prefixed ? hintId : undefined}
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
        {mode === 'dial' && suggestionsEnabled && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t('dialpad.suggestions')}
            hidden={!open}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {open &&
              suggestions.map((s, i) => (
                <SuggestionRow
                  key={s.number}
                  id={optionId(i)}
                  suggestion={s}
                  query={value}
                  active={i === activeIndex}
                  onPick={() => pick(s)}
                  onHover={() => setActiveIndex(i)}
                />
              ))}
          </ul>
        )}
      </div>

      {mode === 'dial' && (
        // Fixed-height row so the keypad doesn't jump while typing.
        <div className="-mt-2 flex h-7 w-full items-center justify-center gap-2 px-2 text-xs text-muted-foreground">
          {topMatch && (
            <button
              type="button"
              onClick={() => pick(topMatch)}
              aria-label={t('dialpad.useSuggestion', { label: suggestionLabel(topMatch) })}
              className="inline-flex min-h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-muted px-3 text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring"
            >
              {topMatch.source === 'contact' ? <UserIcon aria-hidden className="size-3.5 shrink-0" /> : <HistoryIcon aria-hidden className="size-3.5 shrink-0" />}
              <span className="truncate">{suggestionLabel(topMatch)}</span>
            </button>
          )}
          {prefixed && !topMatch && (
            <span id={hintId} dir="ltr">
              {t('dialpad.prefixHint', { number: prefixed })}
            </span>
          )}
          {prefixed && topMatch && (
            <span id={hintId} className="sr-only">
              {t('dialpad.prefixHint', { number: prefixed })}
            </span>
          )}
        </div>
      )}
      {mode === 'dial' && suggestionsEnabled && (
        <span id={statusId} role="status" aria-live="polite" className="sr-only">
          {open ? t('dialpad.suggestionsCount', { count: suggestions.length }) : ''}
        </span>
      )}

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

function suggestionLabel(s: DialSuggestion): string {
  return s.name ? `${s.name} · ${formatNumber(s.number)}` : formatNumber(s.number);
}

/** Bold the digits that match what was typed. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.replace(/\D/g, '');
  if (!q) return <>{text}</>;
  // Map digit positions back to characters in the (possibly formatted) text.
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (/\d/.test(text[i]!)) positions.push(i);
  const digitsText = positions.map((i) => text[i]).join('');
  const at = digitsText.indexOf(q);
  if (at < 0) return <>{text}</>;
  const start = positions[at]!;
  const end = positions[at + q.length - 1]! + 1;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-foreground">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function SuggestionRow({
  id,
  suggestion: s,
  query,
  active,
  onPick,
  onHover,
}: {
  id: string;
  suggestion: DialSuggestion;
  query: string;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const t = useT();
  const number = formatNumber(s.number);
  const meta = s.source === 'contact' ? (s.description ?? t('dialpad.suggestionContact')) : t('dialpad.suggestionRecent', { count: s.calls });
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      // Keep focus in the text field so typing can continue after a click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-start',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {s.source === 'contact' ? <UserIcon className="size-4" /> : <HistoryIcon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" dir="auto">
          {s.name ?? (
            <span dir="ltr">
              <Highlighted text={number} query={query} />
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {s.name && (
            <>
              <span dir="ltr">
                <Highlighted text={number} query={query} />
              </span>
              {' · '}
            </>
          )}
          {meta}
        </span>
      </span>
    </li>
  );
}
