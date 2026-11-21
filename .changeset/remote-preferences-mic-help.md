---
"sipkit-core": patch
"sipkit-ui": patch
---

Settings changes now work when the phone runs elsewhere (browser extension, shared leader tab).

- core: remote clients can change preferences (`audioProcessing`, `techPrefix`, `techPrefixMinDigits`); before, the host dropped everything except login keys, so these switches did nothing from the extension popup or a follower tab. New `pickPreferences()` and `serveSoftphone({ onPreferences })`. A partial `audioProcessing` change keeps the other switches.
- ui: `<Softphone microphoneHelp={{ blocked, onAllow }}>` for apps where mic access is granted somewhere else (the extension popup opens Options). `MicrophoneAccess` and `VoiceProcessingSettings` are exported.
