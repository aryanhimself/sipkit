# Dialing

How sipkit turns what the user types into the number the PBX receives, and how the
dialer helps them type it.

## Rules applied to every outgoing call

In order:

| Step | Config | Example |
|---|---|---|
| Strip formatting | `normalizeNumbers` (default `true`) | `+1 (555) 123-4567` → `+15551234567` |
| Plugin hook | `beforeDial` | `+977…` → `00977…` |
| Dial prefix | `techPrefix`, `techPrefixMinDigits` | `9842477272` → `99842477272` |
| Post-dial DTMF | `"123,456"` | dials `123`, sends `456` once connected |

SIP URIs (`sip:alice@example.com`) skip normalisation and the prefix.

## Dial prefix

```ts
createSoftphone({
  techPrefix: '9',          // outside-line prefix
  techPrefixMinDigits: 7,   // 1001 stays 1001; 9842477272 → 99842477272
});
```

- The prefix is always added, even when the number already starts with the same digit
  (with prefix `9`, `98…` mobile numbers still become `998…`).
- `techPrefixMinDigits: 0` (default) adds it to every number, internal extensions included.
- The call, the call screen and call history keep the number **without** the prefix, so
  redialling from history never doubles it.
- Server conference rooms and feature codes built by sipkit (DND, pickup, resume) bypass it.

Users can change it at runtime in **Settings → Dialing** (sipkit-ui). That choice is saved per
account in `localStorage` (`sipkit:dial-prefs:<username>`) and wins over the host's default on
the next start. While typing, the dialer shows "Dials as 99842477272" under the number.

## Autocomplete in the dialer

The sipkit-ui dialer suggests numbers from call history and contacts as you type:

- Matching uses digits only, so `984 247` finds `9842477272`. From 3 digits on, it also matches
  in the middle of a number. Letters match contact names.
- Ranking: numbers that start with what you typed first, then more calls, then most recent.
  Contacts show their name. Your own extension and an exact match are left out.
- Keyboard: <kbd>↓</kbd>/<kbd>↑</kbd> move through suggestions, <kbd>Enter</kbd> picks one (a
  second <kbd>Enter</kbd> calls), <kbd>Esc</kbd> closes the list.
- When dialling with the on-screen keypad, the best match appears as a chip under the number,
  so the list never covers the keys.
- Accessibility: the field is an ARIA 1.2 combobox (`aria-expanded`, `aria-controls`,
  `aria-activedescendant`), and the number of suggestions is announced politely.

Turn it off with `<Dialpad suggestions={false} />`.
