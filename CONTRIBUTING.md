# Contributing

## Setup

```bash
corepack enable          # uses the pnpm version pinned in package.json
pnpm i
pnpm check               # lint + typecheck + test + build, same as CI
```

Node ≥ 22. For real-SIP work, start the dev PBX in [`infra/asterisk`](infra/asterisk/README.md).

## Conventions

| Topic | Rule |
|---|---|
| Language | TypeScript **strict** (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). No `any` without a comment explaining why. Use `import type` for types (lint enforces this) |
| Formatting | Prettier (`pnpm format`), `.editorconfig`. Do not hand-format |
| Lint | ESLint flat config at the root. Unused vars must be prefixed `_` |
| Layering | `ui → react → core`. Core must not import React or touch the DOM UI. UI must not import `sip.js`. Only the web component entry (`sipkit-ui/embed`, `sipkit.iife.js`) may create globals |
| Public API | `packages/core/src/types.ts`, `config.ts` and `plugin.ts` are the contract for every package. Changing them needs a changeset and, if it breaks things, a major bump (or an ADR before 1.0) |
| Config | New options go in `configSchema` with a safe default and a doc comment. |
| Secrets | Never log credentials or put them in URLs or DOM attributes. Use the injected logger, not `console.*`, in library code |
| Dependencies | Add them to the package that uses them, never to the root (except dev tooling). Prefer small, maintained, MIT/Apache/BSD-licensed deps. Packages that need install scripts must be added to `allowBuilds` in `pnpm-workspace.yaml` with a reason in the PR |
| Third-party code | Do not paste code from other projects unless its licence is MIT-compatible. Keep the original copyright notice and say so in the PR |

## Commits and PRs

- **Conventional Commits**: `feat(core): add attended transfer`, `fix(ui): stop ringtone on cancel`, `docs: …`, `chore(infra): …`, `test: …`. Scopes: `core`, `react`, `ui`, `engine-native`, `playground`, `desktop`, `extension`, `push`, `voicemail-api`, `infra`, `ci`, `docs`.
- Add a **changeset** (`pnpm changeset`) for any user-visible change to a published package (`sipkit-core`, `sipkit-react`, `sipkit-ui`, `sipkit-engine-native`). See [Releasing](#releasing).
- Keep PRs small. Link the roadmap ID (e.g. `V1-CORE-05`) or an issue.
- CI must be green: lint, typecheck, unit tests, build, Playwright mock e2e.
- Touching the SIP.js engine (`packages/core/src/engines/sipjs`)? Run the real-call suite locally as well. It needs Docker and takes about 1.5 min: boot `infra/asterisk` with the `gateway` profile, then run `pnpm --filter sipkit-playground test:e2e:sip`. See infra/asterisk/README.md.

## Tests are required

| Change | Required tests |
|---|---|
| Core logic / plugin | Vitest unit tests with `createTestSoftphone()` + `FakeEngine` (`sipkit-core/testing`) |
| React hook | Testing Library tests (`renderHook`) with the fake softphone |
| UI component | Testing Library interaction tests. Playwright test in `apps/playground` for user flows |
| Engine | Must pass the shared engine contract suite (roadmap V1-TEST-02) |
| Bug fix | A test that fails without the fix |
| Infra | `docker compose config` passes. Boot it and run `scripts/wss-register-smoke.py` |

## Adding a package

1. Create `packages/<name>` (or `apps/<name>`) with `package.json` named `sipkit-<name>`, `"type": "module"`, `exports`, `files: ["dist"]`, and scripts `build`, `test`, `typecheck` (the root `pnpm -r` scripts pick them up).
2. Add `tsconfig.json` extending `../../tsconfig.base.json`, plus a `vitest.config.ts`.
3. Depend on siblings with `"workspace:*"`.
4. Add a README (purpose, install, minimal example) and a row in the root README package table.
5. If it changes the architecture, add an ADR in `docs/adr/`.

## Adding a plugin or engine

Follow [docs/adding-a-feature.md](docs/adding-a-feature.md). In short: plugins live in
`packages/core/src/plugins/` (built in) or in the host app. They use `definePlugin()`, clean up in
`dispose()`, and must not block call handling. Engines implement `SoftphoneEngine`, report facts
only, and pass the contract suite.

## Docs

Docs live in `docs/` and are written for skimming: short sections, tables, no marketing.
Mark anything uncertain as such. Update docs in the same PR as the code.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets) and are published from CI.

1. Every PR that changes a published package adds a changeset: `pnpm changeset`, pick the
   packages and the bump (patch / minor / major), write a one-line summary for the changelog.
2. On `main`, `.github/workflows/release.yml` opens (or updates) a **Version Packages** PR that
   bumps versions and writes `CHANGELOG.md` files (`pnpm version-packages`).
3. Merging that PR runs the workflow again: install, build, test, then `pnpm release`
   (`changeset publish`), which publishes the new versions to npm with
   [provenance](https://docs.npmjs.com/generating-provenance-statements) and pushes git tags.

Publish with **pnpm, not npm**: internal dependencies are declared as `workspace:*`, and only
`pnpm publish` (which `changeset publish` uses in a pnpm workspace) rewrites them to real
version ranges. The workflow needs an `NPM_TOKEN` repository secret (an npm automation token)
and `id-token: write` permission for provenance.

**First release.** The packages start at `0.1.0` with no pending changeset. Publish that version
either by hand (`pnpm -r --filter "./packages/*" publish --access public` after `npm login`) or
by adding the `NPM_TOKEN` secret and re-running the release workflow on `main`. `changeset
publish` skips versions that already exist on npm, so doing both is harmless.

To check a package locally without publishing: `pnpm --filter sipkit-core pack` and inspect the
tarball, or `pnpm --filter sipkit-core publish --dry-run --no-git-checks`.
