# Theming

Roadmap: V2-THEME-01. Hosts can restyle the widget at runtime without rebuilding it: pick light, dark
or system mode, and override any design token from React, from web component attributes or from plain
CSS.

| Where                                 | Source of truth                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Token names, values, contrast pairs   | `packages/ui/src/theme/tokens.ts`                                                        |
| CSS (generated block in `styles.css`) | `pnpm --filter sipkit-ui gen:tokens` rewrites it. A unit test fails if it drifts |
| Contrast checks                       | `packages/ui/src/theme/tokens.test.ts` (WCAG 2.x, both themes)                           |

## Light, dark, system

| API           | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| React         | `<Softphone theme="light" \| "dark" \| "system" />` (default `system`)                  |
| Web component | `<sipkit-phone theme="light \| dark \| system">`. Unknown values fall back to `system` |

`system` follows `prefers-color-scheme` live (a `matchMedia` change listener). Users can still switch
the theme from the header menu or Settings; a new `theme` prop or attribute value wins over that.

## Tokens

Use them in Tailwind classes as `bg-<token>`, `text-<token>`, `border-<token>` (for example
`bg-call-accept`). Feature code must not use palette classes (`bg-red-500`), hex values or inline
colours.

| Token                                   | CSS var                             | Used for                                                                                              | Light                                         | Dark                                         |
| --------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `background`                            | `--background`                      | Widget surface                                                                                        | `oklch(1 0 0)`                                | `oklch(0.17 0.02 265)`                       |
| `foreground`                            | `--foreground`                      | Body text                                                                                             | `oklch(0.21 0.03 264.7)`                      | `oklch(0.96 0.006 264.5)`                    |
| `card` / `cardForeground`               | `--card`, `--card-foreground`       | Panels, incoming banner, bottom tab bar                                                               | white / foreground                            | `oklch(0.205 0.022 265)` / foreground        |
| `popover` / `popoverForeground`         | `--popover`, `--popover-foreground` | Menus, dialogs, tooltips, toasts                                                                      | white / foreground                            | `oklch(0.225 0.024 265)` / foreground        |
| `primary` / `primaryForeground`         | `--primary`, `--primary-foreground` | Brand: primary buttons, active tab, links, focus ring                                                 | `oklch(0.53 0.2 262)` / near-white            | `oklch(0.68 0.16 262)` / near-black          |
| `secondary` / `secondaryForeground`     | `--secondary`, …                    | Secondary buttons, round in-call buttons                                                              | `oklch(0.967 0.007 264.5)`                    | `oklch(0.27 0.025 265)`                      |
| `muted` / `mutedForeground`             | `--muted`, `--muted-foreground`     | Subtle fills / secondary text (hints, timestamps)                                                     | `oklch(0.967 …)` / `oklch(0.5 0.025 264.4)`   | `oklch(0.26 …)` / `oklch(0.72 0.02 264.4)`   |
| `accent` / `accentForeground`           | `--accent`, …                       | Hover / selected fills in menus and lists                                                             | `oklch(0.955 0.014 262)`                      | `oklch(0.29 0.04 262)`                       |
| `destructive` / `destructiveForeground` | `--destructive`, …                  | Errors, missed calls, poor quality, sign out                                                          | `oklch(0.55 0.21 26)` / white                 | `oklch(0.68 0.19 22)` / near-black           |
| `success` / `successForeground`         | `--success`, …                      | Online dot, good quality, incoming-call accent                                                        | `oklch(0.49 0.13 152)` / white                | `oklch(0.72 0.15 152)` / near-black          |
| `warning` / `warningForeground`         | `--warning`, …                      | Connecting dot, fair quality, warning badges. In light mode warning **text** uses `warningForeground` | `oklch(0.77 0.16 70)` / `oklch(0.38 0.09 50)` | `oklch(0.8 0.15 75)` / `oklch(0.25 0.06 46)` |
| `callAccept` / `callAcceptForeground`   | `--call-accept`, …                  | Call and Answer buttons, ring pulse                                                                   | `var(--success)`                              | `var(--success)`                             |
| `callEnd` / `callEndForeground`         | `--call-end`, …                     | Hang up, Decline, End conference                                                                      | `var(--destructive)`                          | `var(--destructive)`                         |
| `border`                                | `--border`                          | Borders, dividers                                                                                     | `oklch(0.925 0.009 264.5)`                    | `oklch(1 0 0 / 10%)`                         |
| `input`                                 | `--input`                           | Form control borders                                                                                  | `oklch(0.88 0.01 264.5)`                      | `oklch(1 0 0 / 16%)`                         |
| `ring`                                  | `--ring`                            | Focus ring                                                                                            | `primary` at 60%                              | same                                         |
| `overlay`                               | `--overlay`                         | Backdrop behind dialogs                                                                               | `oklch(0 0 0 / 45%)`                          | `oklch(0 0 0 / 60%)`                         |
| `radius`                                | `--radius`                          | Base corner radius (sm/md/xl are derived)                                                             | `0.75rem`                                     | same                                         |
| `fontSans`                              | `--font-sans`                       | Font stack                                                                                            | Inter, system UI                              | same                                         |

`--sipkit-height` (compact widget height, default 640px) is a layout hook, not a token.

Toasts (sonner "rich colours") are mapped onto `success`, `destructive`, `warning` and `primary` in
`styles.css`, so they follow the theme too.

## Overriding tokens

Precedence, lowest first:

1. Built-in value (light or dark).
2. `--sipkit-<token>` CSS variable: both themes.
3. `--sipkit-dark-<token>` CSS variable: dark theme only.
4. `themeTokens` (React) / `theme-tokens` + `themeTokens` (web component). These set the same `--sipkit-*`
   variables inline on the widget root, so they beat host CSS.

Token names are camelCase in JS (`callAccept`) and kebab-case in CSS (`--sipkit-call-accept`).

### React

```tsx
<Softphone
  softphone={phone}
  theme="system"
  themeTokens={{
    primary: '#0a7',
    radius: '0.5rem',
    fontSans: "'Segoe UI', system-ui, sans-serif",
    callEnd: '#b91c1c',
    dark: { primary: '#3dd6a0', background: '#0b1416' },
  }}
/>
```

- Top-level keys apply to both themes; keys under `dark` apply in dark mode only.
- `brandColor="#0a7"` is shorthand for `themeTokens={{ primary: '#0a7' }}` (`themeTokens.primary` wins).
- If you set a surface (`primary`, `background`, `card`, `callAccept`, …) as a hex, `rgb()` or `oklch()`
  colour and leave out its `…Foreground`, a readable foreground (white or near-black, whichever has more
  contrast) is picked for you. Named colours and `var()` are passed through without this.
- Unknown keys, non-strings and values containing `;{}<>` are ignored.
- Helpers are exported: `themeTokensToCssVars()`, `lightTokens`, `darkTokens`, `THEME_COLOR_TOKENS`,
  `contrastRatio()`, `parseColor()`.

### Web component

```html
<sipkit-phone
  theme="dark"
  theme-tokens='{"primary":"#0a7","radius":"0.5rem","dark":{"primary":"#3dd6a0"}}'
></sipkit-phone>
<script>
  // or as a property (merged over the attribute; re-renders on assignment)
  document.querySelector('sipkit-phone').themeTokens = { primary: '#7c3aed' };
</script>
```

`brand-color="#0a7"` still works. Invalid JSON in `theme-tokens` is ignored with one console warning.

### Plain CSS (no JS)

Custom properties are inherited, so they reach into the shadow root of `<sipkit-phone>` and into the
React widget from any ancestor:

```css
sipkit-phone,           /* web component */
.crm-softphone-slot {
  /* any ancestor of the React widget */
  --sipkit-primary: #0f766e;
  --sipkit-dark-primary: #2dd4bf;
  --sipkit-radius: 0.5rem;
  --sipkit-font-sans: 'Roboto', sans-serif;
}
```

Plain CSS cannot pick a readable foreground for you: if you change a surface colour, also set its
`-foreground` (for example `--sipkit-primary-foreground`). And `--sipkit-<token>` applies to dark mode too, so
when you override surfaces (`--sipkit-background`, `--sipkit-card`) give dark values with `--sipkit-dark-*` or
force `theme="light"`.

## Contrast

`tokens.test.ts` computes the WCAG 2.x contrast ratio for every pair in `CONTRAST_PAIRS` in both themes
(translucent fills such as badge backgrounds are composited first):

| Kind                                          | Minimum | Examples                                                                                                                                                                     |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text                                          | 4.5:1   | foreground/background, muted-foreground on background/card/muted/popover, primary-foreground/primary, destructive and success text, badge text on tinted fills, warning text |
| UI glyphs, status dots, icons on call buttons | 3:1     | call-accept-foreground/call-accept, success/warning/destructive dots and quality bars on card                                                                                |

Changing a token value that breaks a pair fails CI. Values were adjusted when the test was added: light
`success` (0.64 → 0.49 L), `destructive` (0.6 → 0.55), `warningForeground` (0.28 → 0.38, so it also
works as text on white), `mutedForeground` (0.55 → 0.5), `input` (darker); dark `primary`, `success`,
`destructive` (lighter, with dark foregrounds).

Host overrides are not checked at runtime. Use `contrastRatio(parseColor(a)!, parseColor(b)!)` if you
want to validate a brand palette.

## Playground

`apps/playground`: the header has Theme (Light / Dark / System) and Brand (Default / Custom brand)
switches; "Custom brand" passes an example `themeTokens` object. `embed-demo.html` shows host CSS
variables, the `theme` attribute and `theme-tokens`. Playwright: `e2e/theming.spec.ts`.
