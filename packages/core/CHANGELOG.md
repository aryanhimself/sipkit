# sipkit-core

## 0.2.1

### Patch Changes

- d479d8b: Detect calls that carry no audio. Quality samples with no RTP packets now report `noAudio`, `mos: 1` and level `poor` (they previously looked "good, MOS 4.4"), the softphone warns once per call with notification `callNoAudio`, and the UI quality indicator shows "No audio".

## 0.2.0

### Minor Changes

- 136def4: Dial prefix, dialer autocomplete and an accessibility pass.

  - core: new `techPrefixMinDigits` to skip the dial prefix for short internal extensions.
  - core: the prefix is now added even when the number already starts with it (prefix `9` + `98…` mobiles were dialled without it).
  - core: an outgoing call that fails to get the microphone now ends with reason `media-error` instead of `failed`.
  - react: `MockSoftphone.simulateCallFailure(reason, code?)` for tests and demos.
  - ui: Settings → Dialing sets the prefix, saved per account; the dialer shows "Dials as …".
  - ui: the dialer suggests numbers from call history and contacts (ARIA combobox).
  - ui: failed calls explain why ("Number not reachable (404)", "Microphone blocked") with Call again; history rows show the reason.
  - ui: screen-reader announcements for call and registration changes, focus management for dialogs and incoming calls, keyboard patterns for tabs and radios, reduced-motion support, larger touch targets, and decorative icons hidden from assistive tech.
  - ui: toasts moved to the bottom so they no longer cover the number field.
