# 0003. React + Tailwind + shadcn/ui, also shipped as a web component

- Status: Accepted
- Date: 2026-11-08

## Context

The UI must (a) embed in host applications (CRMs, help desks, plain pages) whose framework we
don't control, (b) be accessible and themeable, and (c) be easy for contributors to extend.

## Decision

- Build the widget in **React** with **Tailwind CSS v4** and **shadcn/ui** components (Radix primitives, copied into `packages/ui`, not a runtime dependency on a design system).
- Expose it three ways: as a React component, as a **`<sipkit-phone>` custom element** (bundles React, renders into Shadow DOM, styles scoped there), and headless through `sipkit-react` hooks.
- Theme with CSS variables (`--sipkit-*`) that a host can set from outside the Shadow DOM.

## Consequences

- Radix gives accessible primitives (focus management, ARIA) out of the box.
- The web component works in any host (plain HTML, Angular, legacy pages) without CSS leakage either way.
- The web component bundle includes React (about 45 KB gzipped). That is acceptable for a softphone, and React hosts can use the npm packages instead to share their React copy.
- Contributors need React/Tailwind skills. That is a common skill set.

## Alternatives considered

| Option | Why not |
|---|---|
| Lit / vanilla web components only | Smaller, but fewer ready-made accessible components and less familiarity among contributors |
| Vue / Svelte | Viable, but React has the largest ecosystem, and the hooks package doubles as the headless API |
