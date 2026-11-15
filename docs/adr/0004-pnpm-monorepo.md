# 0004. pnpm workspace monorepo

- Status: Accepted
- Date: 2026-11-08

## Context

We ship several packages that change together (core, react, ui, engine-native) plus a
playground, infra and docs.

## Decision

A single repository using **pnpm workspaces** (`packages/*`, `apps/*`), Node ≥ 22, TypeScript
strict with a shared `tsconfig.base.json`, ESLint flat config, Vitest, tsup/Vite builds.
Internal dependencies use `workspace:*`. Packages are published as `sipkit-*`, versioned
with Changesets (roadmap V1-PKG-01).

## Consequences

- Atomic changes across packages, one CI pipeline, one lockfile.
- pnpm's strict `node_modules` catches undeclared dependencies. `allowBuilds` limits install scripts (supply-chain hygiene).
- No task runner (Turborepo/Nx) for now: `pnpm -r` is enough at this size. Revisit if CI gets slow.

## Alternatives considered

npm/yarn workspaces (looser dependency isolation), multiple repositories (coordination
overhead), Nx/Turborepo (unnecessary at current scale).
