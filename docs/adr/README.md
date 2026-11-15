# Architecture Decision Records

Short records of significant decisions, in [Michael Nygard's format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Add a new file `NNNN-kebab-title.md` (next number). Never rewrite an accepted ADR: supersede it with a new one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-open-source-typescript-stack.md) | An open-source TypeScript softphone on SIP.js and React | Accepted |
| [0002](0002-sipjs-over-jssip.md) | SIP.js as the SIP/WebRTC stack (over JsSIP) | Accepted |
| [0003](0003-react-tailwind-shadcn.md) | React + Tailwind + shadcn/ui for the UI, also shipped as a web component | Accepted |
| [0004](0004-pnpm-monorepo.md) | pnpm workspace monorepo | Accepted |
| [0005](0005-plugin-architecture.md) | Plugin architecture with an engine interface | Accepted |
| [0006](0006-transport-modes.md) | Two transport modes: direct WebRTC and SIP gateway | Accepted |
| 0007 | Withdrawn (number kept so later ADR numbers stay stable) | Withdrawn |
| [0008](0008-electron-desktop-shell.md) | Electron (not Tauri) for the desktop shell | Accepted |
| [0009](0009-baresip-native-sip-stack.md) | baresip as the native SIP stack (desktop), driven over IPC | Accepted |

Template:

```md
# NNNN. Title
- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
## Context
## Decision
## Consequences
## Alternatives considered
```
