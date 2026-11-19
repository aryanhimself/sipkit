# sipkit-noise

## 0.3.0

### Minor Changes

- 13e9b61: New package `sipkit-noise`: AI noise removal for the outgoing microphone in the browser. `noiseSuppression()` is a plugin that routes the microphone through RNNoise (or Speex) in an AudioWorklet via the `processMicrophone` hook, with a live on/off switch for calls in progress (`softphone.plugin('noise-suppression').setEnabled()`), lazy loading of the model on the first call, and automatic fallback to the raw microphone when the browser cannot run it.
