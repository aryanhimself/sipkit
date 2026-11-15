# 0008. Electron (not Tauri) for the desktop shell

- Status: Accepted
- Date: 2026-11-09

## Context

Roadmap V2-DESK-01 asks for a desktop app that embeds `sipkit-ui`, with a tray,
auto-update and signed Windows/macOS installers. V2-DESK-03 adds global hotkeys, OS
notifications and a `tel:`/`sip:` handler. V2-DESK-02 will add a native SIP engine (plain
SIP/UDP/TLS, no gateway) behind IPC. The roadmap preferred Tauri, for its small binaries and
memory use.

Constraints:

- The team writes TypeScript only. Nobody maintains Rust, and the build machines have no
  Rust toolchain. A Tauri shell means Rust code for tray, hotkeys, notifications, the
  protocol handler and the updater, plus Rust in CI.
- The widget relies on WebRTC (`getUserMedia`, DTLS-SRTP, `getStats`). Tauri uses the OS
  web view (WKWebView, WebView2, WebKitGTK), so WebRTC behaviour, codecs and permission
  prompts differ per platform. Electron ships one Chromium, the same engine the web
  softphone is tested on (Playwright Chromium).
- V2-DESK-02 needs a process that can own a native SIP stack (a sidecar or Node addon).
  Electron's main process is Node, so the engine host can be TypeScript.

## Decision

Build `apps/desktop` on **Electron** with electron-vite, electron-builder and
electron-updater. See [desktop.md](../desktop.md).

- The renderer is sandboxed (`sandbox`, `contextIsolation`, no `nodeIntegration`) under a
  strict CSP. It talks to the main process only through a typed preload bridge
  (`window.sipkitDesktop`).
- The SIP.js engine runs in the renderer, as in the browser. The bridge already defines
  an `EngineBridge` (`invoke` + `onEvent`) and the main process exposes a
  `registerNativeEngineHost()` hook. V2-DESK-02 plugs in there without changing the shell.
- Main and preload are bundled into single files, so the packaged app ships no
  `node_modules`.

## Consequences

- Larger downloads (about 100 MB installed vs 10–20 MB for Tauri) and higher idle memory.
  Agents keep the softphone open all day, so this is acceptable. We will measure it during
  the pilot.
- One browser engine everywhere: the existing Chromium e2e coverage applies, and the
  desktop e2e uses Playwright's `_electron` API.
- We take on Electron's security upkeep: keep up with Electron majors (Chromium CVEs),
  keep the renderer sandboxed and the IPC surface small and validated.
- Signing and notarization use the standard electron-builder flow (Developer ID +
  notarytool, Authenticode). Credentials come from CI secrets.

## Alternatives considered

- **Tauri 2** (roadmap preference): smaller and faster, but needs Rust skills and tooling
  we do not have, and WebRTC runs on three different web views. We can revisit it if
  binary size becomes a real problem and the team gains Rust capacity. The IPC contract in
  `shared/ipc.ts` is framework-neutral.
- **Neutralino / Wails**: smaller ecosystems, the same web view problem, and Wails needs Go.
- **No desktop app (PWA)**: no global hotkeys, no reliable tray, and no native SIP engine
  (V2-DESK-02).
