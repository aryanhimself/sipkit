---
"sipkit-core": minor
"sipkit-react": minor
"sipkit-ui": minor
---

Noise and echo controls, and no repeated microphone prompts.

- core: `audioProcessing` config (noise suppression, echo cancellation, automatic gain, voice isolation), applied live to calls in progress and on microphone switches.
- core: `hooks.processMicrophone` plugin hook to transform the outgoing mic (used by `sipkit-noise`).
- core: microphone permission is read without prompting (`snapshot.devices.microphone`); `requestMicrophone()` asks only when the browser has not decided, and never calls getUserMedia when the mic is blocked.
- react: `useDevices()` returns `microphone` and `requestMicrophone`; `MockSoftphone` simulates permission.
- ui: Settings → Audio gets switches for each filter (saved per account), an AI noise removal switch when `sipkit-noise` is installed, a microphone status row, and a "Microphone blocked" banner with how to unblock instead of another prompt.
