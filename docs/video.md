# Video calls (V2-VID-01)

1:1 video between two browsers (or a browser and a video-capable SIP phone) through
Asterisk, using VP8 or H.264. Conferences stay audio-only.

## Enable it

Video is **off by default**. With `video.enabled: false` the softphone is audio-only and
any video an INVITE offers is declined (answered `a=inactive`).

```ts
createSoftphone({
  config: {
    // ...
    video: {
      enabled: true,
      defaultOn: false, // call()/answer() without options use audio only
      constraints: { width: 640, height: 360, frameRate: 15 }, // getUserMedia video constraints
    },
  },
});
```

| Key | Default | Meaning |
|---|---|---|
| `video.enabled` | `false` | Allow video calls, answering with video, the camera toggle and the camera picker |
| `video.defaultOn` | `false` | `call()` / `answer()` use video unless told `{ video: false }` |
| `video.constraints` | none | `MediaTrackConstraints` for the camera. The selected camera is added as `deviceId: { exact }` |

The bundled UI also honours `disabledFeatures: ['video']`.

## API (core)

```ts
await softphone.call('1002', { video: true });       // video call
await softphone.answer(callId, { video: true });     // answer with camera
await softphone.answer(callId, { video: false });    // answer a video call audio-only
await softphone.setVideo(false, callId);              // camera off (on: true)
const { local, remote } = softphone.getVideoStreams(callId); // MediaStreams, video tracks only
softphone.on('call:video', ({ callId, hasVideo, cameraOn, remoteVideo }) => { /* re-read streams */ });
await softphone.setDevice('camera', deviceId);        // pick the camera (also switches live calls)
```

| Snapshot field (`Call`) | Meaning |
|---|---|
| `hasVideo` | The call carries a video stream. While an incoming call rings: the caller offers video. Absent on audio-only calls |
| `cameraOn` | Our camera is being sent |
| `remoteVideo` | The far end is sending video: negotiated, the remote track is live/unmuted and, when call quality monitoring is on, video RTP arrived in the last sample |

MediaStreams are **not** in the snapshot (they are not serialisable). `getVideoStreams()`
returns the same two stream objects for the life of a call; their tracks change, and every
change emits `call:video`. Audio keeps playing through the engine, so render the streams in
`<video muted>` elements.

`call.quality.video` (when `callQualityInterval > 0`) adds `codec`, per-direction
`bitrateKbps`, inbound `packetLossPct`, `framesPerSecond` and `frameWidth`/`frameHeight`.
Video figures never change the MOS or the quality level, which stay audio-based.

Cameras are listed by `listDevices()` as kind `'camera'` (`useDevices().cameras`) and the
choice is persisted like the audio devices.

## React and UI

- `useCallVideo(callId?)` returns `{ supported, hasVideo, cameraOn, remoteVideo, localStream, remoteStream, setVideo, toggleCamera }`.
- `<CallVideoView call={call} />` (used by the call screen): remote video large, our camera as a
  mirrored picture-in-picture in the bottom end corner (RTL-aware), a "Camera off" / "Waiting for
  video…" placeholder, `aspect-video` so it fits the compact widget and the full-width layout.
- Call screen: a **Camera** toggle button (`aria-pressed` = camera on) next to Keypad. It also
  upgrades an audio-only call to video.
- Dialpad: a **Video call** button next to Call (`onVideoCall` prop to override).
- Incoming card: "Incoming video call" with **Answer with video** and **Answer audio only**.
- Settings: a Video section with the camera picker.
- Strings: `video.*`, `settings.video`, `settings.camera` (English and Nepali).

## How it works (SIP.js engine)

| Action | What happens on the wire |
|---|---|
| Video call | `getUserMedia({ audio, video })`, the INVITE offers `m=audio` + `m=video` (BUNDLE) |
| Answer with video | Same constraints on `accept()` |
| Answer audio-only | An SDP modifier marks the offered video `a=inactive` before the offer is applied, so the browser answers video as inactive and the PBX sends none. The video transceiver is then stopped, so later re-INVITEs (hold) reject video (`m=video 0`) |
| Camera off | `replaceTrack(null)` on the video sender and stop the camera (camera light off). **No re-INVITE** |
| Camera on (video negotiated) | New camera track, `replaceTrack(track)`. **No re-INVITE** |
| Camera on (audio-only call) | Add a video track and send **one re-INVITE** with the new `m=video`. Asterisk passes the stream change to the other leg |
| Hold / resume | Unchanged re-INVITE (`sendonly` / `sendrecv`); the camera track is disabled while held. Mute only affects audio |

Why track swapping instead of a re-INVITE per toggle: it cannot fail on glare or on a PBX that
mishandles direction changes, it is instant, and it really releases the camera. The trade-off
is that the far end gets no SDP signal that the camera is off. The far end's core spots the
stall from the video RTP counters (call quality monitor) and clears `remoteVideo`, so the UI
shows "Camera off". With `callQualityInterval: 0` the far end keeps the last frame instead.

### Conferences

Conferences are audio-only. `conference()` switches every member's camera off before mixing,
`setVideo(true)` is refused (`INVALID_STATE`) while a call is in the conference, and the call
screen shows "Video is off during conferences" instead of the video area. Remote video that a
party may still send is not shown. Splitting the conference does not turn cameras back on.

## Asterisk

`infra/asterisk/config/pbx/pjsip.conf.tmpl`, WebRTC endpoint template:

```ini
allow=opus,ulaw,alaw,vp8,h264
webrtc=yes
bundle=yes
max_audio_streams=1
max_video_streams=1
```

Asterisk does not transcode video, so both ends must share a codec (Chrome, Firefox and Safari
all do VP8 and H.264). The echo test `600` echoes video too: `Echo()` passes video frames
back and requests a keyframe. For a desk phone, add `vp8` or `h264` to its endpoint's `allow`.

## Testing

| Layer | Where |
|---|---|
| Core unit | `packages/core/src/__tests__/softphone.video.test.ts` (FakeEngine `simulateIncomingCall({ video: true })`, `simulateCallVideo()`, `videoStreams`) |
| React | `packages/react/src/hooks/use-call-video.test.tsx` |
| UI | `packages/ui/src/features/video/video.test.tsx` |
| Mock e2e | `apps/playground/e2e/video.spec.ts`. `MockSoftphone` draws synthetic video on a canvas (`createSyntheticVideo()` from `sipkit-core/testing`, `captureStream()`), with `simulateIncomingCall(n, name, { video: true })` and `simulateRemoteVideo(on)`. Playground buttons: Incoming video call, Remote camera off/on |
| Real SIP | `apps/playground/e2e/sip/video.spec.ts` (Chromium fake camera): 1001 video-calls 1002 with inbound video RTP on both sides, camera off/on, hold/resume, audio-only calls unaffected, audio-only answer declines video, echo `600` returns video |

## Limitations

- Video cannot be removed from a call once negotiated; "camera off" stops sending only.
- No screen sharing, no simulcast, no bandwidth adaptation beyond what the browser does.
- Remote "camera off" detection needs call quality monitoring (`callQualityInterval > 0`).
- Only the SIP.js engine and the mock implement video. Other engines simply lack
  `setVideo` / `getVideoStreams` and video calls fail with `NOT_SUPPORTED`.
