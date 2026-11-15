/**
 * Design tokens: the single source of truth for the widget's colours.
 *
 * - `styles.css` contains a generated copy of these values (between the
 *   `<sipkit-tokens>` markers). `pnpm --filter sipkit-ui gen:tokens`
 *   rewrites it; a unit test fails when the two drift apart.
 * - The same test checks WCAG contrast for every pair in `CONTRAST_PAIRS`.
 * - docs/theming.md documents the table below.
 *
 * Override order (later wins): built-in value < `--sipkit-<token>` (both themes)
 * < `--sipkit-dark-<token>` (dark only) < `themeTokens` prop / `theme-tokens`
 * attribute (which simply sets those same `--sipkit-*` variables inline).
 *
 * This module must stay free of React/DOM imports: tests and docs use it too.
 */

/** Colour tokens and what they are used for. Keep this list small. */
export const THEME_COLOR_TOKENS = {
  background: 'Widget surface (behind everything)',
  foreground: 'Default text on background',
  card: 'Raised surfaces: panels, incoming-call banner, bottom tab bar',
  cardForeground: 'Text on card',
  popover: 'Menus, dialogs, tooltips, toasts',
  popoverForeground: 'Text on popover',
  primary: 'Brand colour: primary buttons, active tab, links, focus ring',
  primaryForeground: 'Text/icons on primary',
  secondary: 'Secondary buttons, round in-call action buttons',
  secondaryForeground: 'Text/icons on secondary',
  muted: 'Subtle fills: inputs, avatars, skeletons, tab list',
  mutedForeground: 'Secondary text: hints, timestamps, labels',
  accent: 'Hover/selected fills for menu items and list rows',
  accentForeground: 'Text on accent',
  destructive: 'Errors, missed calls, poor call quality, destructive actions',
  destructiveForeground: 'Text/icons on destructive',
  success: 'Registered status, good call quality, incoming-call accent',
  successForeground: 'Text/icons on success',
  warning: 'Connecting status, fair call quality, warning badges',
  warningForeground: 'Text/icons on warning; also warning text on light backgrounds',
  callAccept: 'Call / Answer buttons (defaults to success)',
  callAcceptForeground: 'Icon on the call / answer button',
  callEnd: 'Hang up / Decline buttons (defaults to destructive)',
  callEndForeground: 'Icon on the hang up / decline button',
  border: 'Borders and dividers',
  input: 'Form control borders',
  ring: 'Focus ring (defaults to primary at 60%)',
  overlay: 'Backdrop behind modal dialogs',
} as const;

export type ThemeColorToken = keyof typeof THEME_COLOR_TOKENS;
export const THEME_COLOR_TOKEN_NAMES = Object.keys(THEME_COLOR_TOKENS) as ThemeColorToken[];

/** Non-colour tokens. */
export const THEME_OTHER_TOKENS = {
  radius: 'Base corner radius (other radii are derived from it). Default `0.75rem`',
  fontSans: 'Font stack. Default Inter, then the system UI font',
} as const;
export type ThemeOtherToken = keyof typeof THEME_OTHER_TOKENS;

export type ThemeTokenName = ThemeColorToken | ThemeOtherToken;

/** A partial set of token values (any CSS colour / length / font stack). */
export type ThemeTokens = Partial<Record<ThemeTokenName, string>>;

/**
 * What hosts pass at runtime. Top-level values apply to both themes; values
 * under `dark` override them when the widget is dark.
 *
 * ```ts
 * { primary: '#0a7', radius: '0.5rem', dark: { primary: '#3dd6a0' } }
 * ```
 */
export type ThemeTokenOverrides = ThemeTokens & { dark?: ThemeTokens };

export type ThemePalette = Record<ThemeColorToken, string>;

export const DEFAULT_RADIUS = '0.75rem';

/** Light theme. Values may reference other tokens with `var(--name)`. */
export const lightTokens: ThemePalette = {
  background: 'oklch(1 0 0)',
  foreground: 'oklch(0.21 0.03 264.7)',
  card: 'oklch(1 0 0)',
  cardForeground: 'oklch(0.21 0.03 264.7)',
  popover: 'oklch(1 0 0)',
  popoverForeground: 'oklch(0.21 0.03 264.7)',
  primary: 'oklch(0.53 0.2 262)',
  primaryForeground: 'oklch(0.985 0.01 260)',
  secondary: 'oklch(0.967 0.007 264.5)',
  secondaryForeground: 'oklch(0.21 0.03 264.7)',
  muted: 'oklch(0.967 0.007 264.5)',
  mutedForeground: 'oklch(0.5 0.025 264.4)',
  accent: 'oklch(0.955 0.014 262)',
  accentForeground: 'oklch(0.3 0.08 262)',
  destructive: 'oklch(0.55 0.21 26)',
  destructiveForeground: 'oklch(0.985 0 0)',
  success: 'oklch(0.49 0.13 152)',
  successForeground: 'oklch(0.985 0 0)',
  warning: 'oklch(0.77 0.16 70)',
  warningForeground: 'oklch(0.38 0.09 50)',
  callAccept: 'var(--success)',
  callAcceptForeground: 'var(--success-foreground)',
  callEnd: 'var(--destructive)',
  callEndForeground: 'var(--destructive-foreground)',
  border: 'oklch(0.925 0.009 264.5)',
  input: 'oklch(0.88 0.01 264.5)',
  ring: 'color-mix(in oklab, var(--primary) 60%, transparent)',
  overlay: 'oklch(0 0 0 / 45%)',
};

/** Dark theme. */
export const darkTokens: ThemePalette = {
  background: 'oklch(0.17 0.02 265)',
  foreground: 'oklch(0.96 0.006 264.5)',
  card: 'oklch(0.205 0.022 265)',
  cardForeground: 'oklch(0.96 0.006 264.5)',
  popover: 'oklch(0.225 0.024 265)',
  popoverForeground: 'oklch(0.96 0.006 264.5)',
  primary: 'oklch(0.68 0.16 262)',
  primaryForeground: 'oklch(0.18 0.03 265)',
  secondary: 'oklch(0.27 0.025 265)',
  secondaryForeground: 'oklch(0.96 0.006 264.5)',
  muted: 'oklch(0.26 0.022 265)',
  mutedForeground: 'oklch(0.72 0.02 264.4)',
  accent: 'oklch(0.29 0.04 262)',
  accentForeground: 'oklch(0.93 0.03 262)',
  destructive: 'oklch(0.68 0.19 22)',
  destructiveForeground: 'oklch(0.17 0.03 22)',
  success: 'oklch(0.72 0.15 152)',
  successForeground: 'oklch(0.16 0.03 152)',
  warning: 'oklch(0.8 0.15 75)',
  warningForeground: 'oklch(0.25 0.06 46)',
  callAccept: 'var(--success)',
  callAcceptForeground: 'var(--success-foreground)',
  callEnd: 'var(--destructive)',
  callEndForeground: 'var(--destructive-foreground)',
  border: 'oklch(1 0 0 / 10%)',
  input: 'oklch(1 0 0 / 16%)',
  ring: 'color-mix(in oklab, var(--primary) 60%, transparent)',
  overlay: 'oklch(0 0 0 / 60%)',
};

export const PALETTES = { light: lightTokens, dark: darkTokens } as const;

/** Minimum contrast: 4.5 for text (WCAG 1.4.3 AA), 3 for icons/glyphs/status dots (WCAG 1.4.11). */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_UI_CONTRAST = 3;

export interface ContrastPair {
  fg: ThemeColorToken;
  /** Background token, optionally `token/alpha@base` for a translucent fill over `base` (e.g. `success/14@card`). */
  bg: string;
  min: number;
  /** Limit to one theme (default: both). */
  theme?: 'light' | 'dark';
  /** Where the pair occurs. */
  usage: string;
}

const T = MIN_TEXT_CONTRAST;
const U = MIN_UI_CONTRAST;

/** Every foreground/background combination the UI renders. */
export const CONTRAST_PAIRS: ContrastPair[] = [
  { fg: 'foreground', bg: 'background', min: T, usage: 'body text' },
  { fg: 'foreground', bg: 'muted', min: T, usage: 'text on muted fills' },
  { fg: 'cardForeground', bg: 'card', min: T, usage: 'panels, tab bar' },
  { fg: 'popoverForeground', bg: 'popover', min: T, usage: 'menus, dialogs, toasts' },
  { fg: 'primaryForeground', bg: 'primary', min: T, usage: 'primary buttons' },
  { fg: 'secondaryForeground', bg: 'secondary', min: T, usage: 'secondary buttons' },
  { fg: 'accentForeground', bg: 'accent', min: T, usage: 'hovered menu items' },
  { fg: 'mutedForeground', bg: 'background', min: T, usage: 'hints, timestamps' },
  { fg: 'mutedForeground', bg: 'card', min: T, usage: 'inactive tab labels' },
  { fg: 'mutedForeground', bg: 'muted', min: T, usage: 'muted text on muted fills' },
  { fg: 'mutedForeground', bg: 'popover', min: T, usage: 'menu labels, dialog descriptions' },
  { fg: 'primary', bg: 'background', min: T, usage: 'links, active tab text' },
  { fg: 'primary', bg: 'primary/8@card', min: T, usage: 'active bottom tab' },
  { fg: 'destructive', bg: 'background', min: T, usage: 'error text, missed calls' },
  { fg: 'destructive', bg: 'destructive/10@background', min: T, usage: 'error banner text' },
  {
    fg: 'destructiveForeground',
    bg: 'destructive',
    min: T,
    usage: 'destructive buttons and badges',
  },
  { fg: 'success', bg: 'background', min: T, usage: '"Incoming call" label, quality text' },
  { fg: 'success', bg: 'success/14@card', min: T, usage: 'success badge' },
  { fg: 'successForeground', bg: 'success', min: T, usage: 'success buttons' },
  { fg: 'warningForeground', bg: 'warning', min: T, usage: 'warning fills' },
  {
    fg: 'warningForeground',
    bg: 'background',
    min: T,
    theme: 'light',
    usage: 'fair quality text (light)',
  },
  {
    fg: 'warningForeground',
    bg: 'warning/18@card',
    min: T,
    theme: 'light',
    usage: 'warning badge (light)',
  },
  { fg: 'warning', bg: 'background', min: T, theme: 'dark', usage: 'fair quality text (dark)' },
  { fg: 'warning', bg: 'warning/18@card', min: T, theme: 'dark', usage: 'warning badge (dark)' },
  { fg: 'callAcceptForeground', bg: 'callAccept', min: U, usage: 'call / answer icon' },
  { fg: 'callEndForeground', bg: 'callEnd', min: U, usage: 'hang up / decline icon' },
  { fg: 'success', bg: 'card', min: U, usage: 'online dot, quality bars' },
  { fg: 'warning', bg: 'card', min: U, theme: 'dark', usage: 'connecting dot (dark)' },
  { fg: 'destructive', bg: 'card', min: U, usage: 'error dot, poor quality bars' },
  { fg: 'primary', bg: 'background', min: U, usage: 'checkbox / switch fill' },
];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `primaryForeground` -> `primary-foreground`. */
export function tokenCssName(token: ThemeTokenName): string {
  return token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Host-facing override variable: `--sipkit-primary`, or `--sipkit-dark-primary` for dark-only. */
export function tokenOverrideVar(token: ThemeTokenName, dark = false): string {
  return `--sipkit-${dark ? 'dark-' : ''}${tokenCssName(token)}`;
}

// ---------------------------------------------------------------------------
// CSS generation
// ---------------------------------------------------------------------------

export const CSS_BEGIN_MARKER =
  '/* <sipkit-tokens> generated from src/theme/tokens.ts by `pnpm gen:tokens`; do not edit */';
export const CSS_END_MARKER = '/* </sipkit-tokens> */';

/** The token block of styles.css (between and including the markers). */
export function generateTokenCss(): string {
  const lines: string[] = [CSS_BEGIN_MARKER, ':where(.sipkit-phone) {'];
  lines.push(`  --radius: var(${tokenOverrideVar('radius')}, ${DEFAULT_RADIUS});`);
  for (const token of THEME_COLOR_TOKEN_NAMES) {
    lines.push(
      `  --${tokenCssName(token)}: var(${tokenOverrideVar(token)}, ${lightTokens[token]});`,
    );
  }
  lines.push('}', '', ":where(.sipkit-phone[data-theme='dark']) {");
  lines.push(
    `  --radius: var(${tokenOverrideVar('radius', true)}, var(${tokenOverrideVar('radius')}, ${DEFAULT_RADIUS}));`,
  );
  for (const token of THEME_COLOR_TOKEN_NAMES) {
    lines.push(
      `  --${tokenCssName(token)}: var(${tokenOverrideVar(token, true)}, var(${tokenOverrideVar(token)}, ${darkTokens[token]}));`,
    );
  }
  lines.push('}', CSS_END_MARKER);
  return lines.join('\n');
}

/** Replace the marked token block inside a stylesheet. */
export function replaceTokenCss(stylesheet: string): string {
  const start = stylesheet.indexOf(CSS_BEGIN_MARKER);
  const end = stylesheet.indexOf(CSS_END_MARKER);
  if (start < 0 || end < start) throw new Error('styles.css: token markers not found');
  return (
    stylesheet.slice(0, start) + generateTokenCss() + stylesheet.slice(end + CSS_END_MARKER.length)
  );
}

// ---------------------------------------------------------------------------
// Runtime overrides
// ---------------------------------------------------------------------------

const ALL_TOKENS = new Set<string>([
  ...THEME_COLOR_TOKEN_NAMES,
  ...Object.keys(THEME_OTHER_TOKENS),
]);

/** Surface token -> the text token that sits on it (used to auto-pick readable text). */
const FOREGROUND_OF: Partial<Record<ThemeColorToken, ThemeColorToken>> = {
  background: 'foreground',
  card: 'cardForeground',
  popover: 'popoverForeground',
  primary: 'primaryForeground',
  secondary: 'secondaryForeground',
  accent: 'accentForeground',
  destructive: 'destructiveForeground',
  success: 'successForeground',
  warning: 'warningForeground',
  callAccept: 'callAcceptForeground',
  callEnd: 'callEndForeground',
};

const LIGHT_TEXT = '#ffffff';
const DARK_TEXT = '#111827';

function isSafeValue(v: unknown): v is string {
  // Values end up in a style attribute via setProperty, which can't break out,
  // but reject obvious junk so a bad JSON attribute doesn't produce odd CSS.
  return typeof v === 'string' && v.trim() !== '' && v.length <= 200 && !/[;{}<>]/.test(v);
}

function collect(
  tokens: ThemeTokens | undefined,
  dark: boolean,
  out: Record<string, string>,
): void {
  if (!tokens || typeof tokens !== 'object') return;
  for (const [key, value] of Object.entries(tokens)) {
    if (!ALL_TOKENS.has(key) || !isSafeValue(value)) continue;
    out[tokenOverrideVar(key as ThemeTokenName, dark)] = value.trim();
  }
  // A host that sets a surface but not its text gets a readable one picked for it.
  for (const [surface, fg] of Object.entries(FOREGROUND_OF) as [
    ThemeColorToken,
    ThemeColorToken,
  ][]) {
    const value = tokens[surface];
    if (!isSafeValue(value) || isSafeValue(tokens[fg])) continue;
    const rgba = parseColor(value);
    if (!rgba) continue;
    out[tokenOverrideVar(fg, dark)] = readableTextOn(rgba);
  }
}

/**
 * Convert host overrides to `--sipkit-*` CSS variables (for a style attribute).
 * Unknown keys and unsafe values are dropped.
 */
export function themeTokensToCssVars(
  overrides: ThemeTokenOverrides | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!overrides || typeof overrides !== 'object') return out;
  collect(overrides, false, out);
  collect(overrides.dark, true, out);
  return out;
}

/** Parse a `theme-tokens` attribute (JSON). Returns undefined for empty/invalid input. */
export function parseThemeTokens(json: string | null | undefined): ThemeTokenOverrides | undefined {
  if (!json || !json.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ThemeTokenOverrides)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Colour maths (sRGB, OKLCH) and WCAG contrast
// ---------------------------------------------------------------------------

/** sRGB (gamma-encoded) 0..1 plus alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseAlpha(s: string | undefined): number {
  if (s === undefined) return 1;
  const t = s.trim();
  return clamp01(t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t));
}

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function oklchToRgba(l: number, c: number, hDeg: number, a: number): Rgba {
  const h = (hDeg * Math.PI) / 180;
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l_ = Math.pow(l + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m_ = Math.pow(l - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s_ = Math.pow(l - 0.0894841775 * A - 1.291485548 * B, 3);
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const b = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  return { r: toGamma(clamp01(r)), g: toGamma(clamp01(g)), b: toGamma(clamp01(b)), a };
}

/** Parse `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()` or `oklch()`. Returns null for anything else. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const fn = /^(rgba?|oklch)\(\s*([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const [body = '', alpha] = fn[2]!.split('/');
  const parts = body.split(/[\s,]+/).filter(Boolean);
  let alphaStr = alpha;
  if (fn[1] === 'oklch') {
    if (parts.length !== 3) return null;
    const l = parts[0]!.endsWith('%') ? parseFloat(parts[0]!) / 100 : parseFloat(parts[0]!);
    const c = parseFloat(parts[1]!);
    const h = parseFloat(parts[2]!);
    if ([l, c, h].some(Number.isNaN)) return null;
    return oklchToRgba(l, c, h, parseAlpha(alphaStr));
  }
  if (parts.length === 4 && alphaStr === undefined) alphaStr = parts.pop();
  if (parts.length !== 3) return null;
  const ch = parts.map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255));
  if (ch.some(Number.isNaN)) return null;
  return { r: clamp01(ch[0]!), g: clamp01(ch[1]!), b: clamp01(ch[2]!), a: parseAlpha(alphaStr) };
}

/** Alpha-composite `top` over an opaque `bottom` (in gamma space, as browsers do). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG 2.x contrast ratio of two opaque colours (1..21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function readableTextOn(bg: Rgba): string {
  const white = parseColor(LIGHT_TEXT)!;
  const dark = parseColor(DARK_TEXT)!;
  const opaque = bg.a < 1 ? composite(bg, white) : bg;
  return contrastRatio(white, opaque) >= contrastRatio(dark, opaque) ? LIGHT_TEXT : DARK_TEXT;
}

/** Resolve a palette value (following `var(--token)` references) to a colour. */
export function resolveTokenColor(
  palette: ThemePalette,
  token: ThemeColorToken,
  depth = 0,
): Rgba | null {
  const value = palette[token];
  const ref = /^var\(--([a-z-]+)\)$/.exec(value.trim());
  if (ref) {
    if (depth > 5) return null;
    const name = ref[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as ThemeColorToken;
    return name in palette ? resolveTokenColor(palette, name, depth + 1) : null;
  }
  return parseColor(value);
}
