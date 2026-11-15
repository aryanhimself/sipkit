import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type Politeness = 'polite' | 'assertive';
export type Announce = (message: string, politeness?: Politeness) => void;

/** No-break space. */
const NBSP = String.fromCharCode(0xa0);

const AnnouncerContext = createContext<Announce>(() => undefined);

/**
 * Screen reader announcements for one widget. Two visually hidden live regions
 * (polite and assertive) that stay mounted, so a message is read even when the
 * element that triggered it (a call screen that just closed) is gone.
 * Repeating the same message re-announces it.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState({ text: '', n: 0 });
  const [assertive, setAssertive] = useState({ text: '', n: 0 });
  const announce = useCallback<Announce>((message, politeness = 'polite') => {
    const set = politeness === 'assertive' ? setAssertive : setPolite;
    set((prev) => ({ text: message, n: prev.n + 1 }));
  }, []);
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <LiveRegion politeness="polite" message={polite} />
      <LiveRegion politeness="assertive" message={assertive} />
    </AnnouncerContext.Provider>
  );
}

function LiveRegion({ politeness, message }: { politeness: Politeness; message: { text: string; n: number } }) {
  // Clear the region a while after speaking so stale text is not re-read in browse mode.
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!message.text) return;
    // A trailing no-break space on every other message makes a repeat count as a change.
    setText(message.n % 2 ? message.text : message.text + NBSP);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), 7000);
    return () => clearTimeout(timer.current);
  }, [message]);
  return (
    <div aria-live={politeness} aria-atomic="true" className="sr-only" data-testid={`announcer-${politeness}`}>
      {text}
    </div>
  );
}

/** `announce(message, 'polite' | 'assertive')` for the surrounding <Softphone>. */
export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}
