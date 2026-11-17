---
'sipkit-core': patch
'sipkit-ui': patch
---

Detect calls that carry no audio. Quality samples with no RTP packets now report `noAudio`, `mos: 1` and level `poor` (they previously looked "good, MOS 4.4"), the softphone warns once per call with notification `callNoAudio`, and the UI quality indicator shows "No audio".
