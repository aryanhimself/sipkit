// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_PAIRS,
  PALETTES,
  THEME_COLOR_TOKEN_NAMES,
  composite,
  contrastRatio,
  generateTokenCss,
  parseColor,
  parseThemeTokens,
  replaceTokenCss,
  resolveTokenColor,
  themeTokensToCssVars,
  tokenCssName,
  type Rgba,
  type ThemeColorToken,
  type ThemePalette,
} from './tokens';

const STYLES = fileURLToPath(new URL('../styles.css', import.meta.url));

function resolveBg(palette: ThemePalette, spec: string): Rgba {
  const m = /^(\w+)(?:\/(\d+)@(\w+))?$/.exec(spec);
  if (!m) throw new Error(`bad bg spec ${spec}`);
  const base = resolveTokenColor(palette, m[1] as ThemeColorToken);
  if (!base) throw new Error(`unresolvable ${m[1]}`);
  if (!m[2]) return base;
  const under = resolveTokenColor(palette, m[3] as ThemeColorToken)!;
  return composite({ ...base, a: Number(m[2]) / 100 }, under);
}

describe('styles.css token block', () => {
  it('matches src/theme/tokens.ts (run `pnpm --filter sipkit-ui gen:tokens` to update)', () => {
    const css = readFileSync(STYLES, 'utf8');
    const expected = replaceTokenCss(css);
    if (process.env.UPDATE_TOKENS && expected !== css) writeFileSync(STYLES, expected);
    else expect(css).toBe(expected);
  });

  it('maps every colour token into Tailwind (@theme inline)', () => {
    const css = readFileSync(STYLES, 'utf8');
    for (const t of THEME_COLOR_TOKEN_NAMES) {
      expect(css, t).toContain(`--color-${tokenCssName(t)}: var(--${tokenCssName(t)});`);
    }
  });

  it('defines every token for light and dark with --sipkit-* overrides', () => {
    const block = generateTokenCss();
    for (const t of THEME_COLOR_TOKEN_NAMES) {
      const name = tokenCssName(t);
      expect(block).toContain(`--${name}: var(--sipkit-${name}, `);
      expect(block).toContain(`--${name}: var(--sipkit-dark-${name}, var(--sipkit-${name}, `);
    }
  });
});

describe.each(Object.entries(PALETTES))('%s theme contrast (WCAG 2.x)', (theme, palette) => {
  it('every token resolves to a colour', () => {
    for (const t of THEME_COLOR_TOKEN_NAMES) {
      if (t === 'ring') continue; // color-mix of primary
      expect(resolveTokenColor(palette, t), t).not.toBeNull();
    }
  });

  const pairs = CONTRAST_PAIRS.filter((p) => !p.theme || p.theme === theme);
  it.each(pairs.map((p) => [`${p.fg} on ${p.bg} (${p.usage})`, p] as const))(
    '%s',
    (_label, pair) => {
      const fg = resolveTokenColor(palette, pair.fg)!;
      const bg = resolveBg(palette, pair.bg);
      const ratio = contrastRatio(fg, bg);
      expect(
        Math.round(ratio * 100) / 100,
        `${theme}: ${pair.fg} on ${pair.bg}`,
      ).toBeGreaterThanOrEqual(pair.min);
    },
  );
});

describe('colour maths', () => {
  it('parses hex, rgb and oklch', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('#00000080')!.a).toBeCloseTo(0.5, 2);
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0 0 0 / 50%)')!.a).toBe(0.5);
    const white = parseColor('oklch(1 0 0)')!;
    expect(white.r).toBeCloseTo(1, 3);
    expect(parseColor('oklch(0 0 0 / 45%)')!.a).toBeCloseTo(0.45);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777')!, parseColor('#fff')!)).toBeCloseTo(4.48, 2);
  });
});

describe('themeTokensToCssVars', () => {
  it('maps tokens to --sipkit-* (both themes) and dark to --sipkit-dark-*', () => {
    expect(
      themeTokensToCssVars({
        primary: '#0a7',
        primaryForeground: '#fff',
        radius: '0.5rem',
        fontSans: 'Georgia, serif',
        dark: { primary: '#3dd6a0', primaryForeground: '#000' },
      }),
    ).toEqual({
      '--sipkit-primary': '#0a7',
      '--sipkit-primary-foreground': '#fff',
      '--sipkit-radius': '0.5rem',
      '--sipkit-font-sans': 'Georgia, serif',
      '--sipkit-dark-primary': '#3dd6a0',
      '--sipkit-dark-primary-foreground': '#000',
    });
  });

  it('picks readable text for a surface given without its foreground', () => {
    expect(themeTokensToCssVars({ primary: '#fde047' })['--sipkit-primary-foreground']).toBe(
      '#111827',
    );
    expect(themeTokensToCssVars({ background: '#0b1020' })['--sipkit-foreground']).toBe('#ffffff');
    // Unparseable (named colour / var()) -> left to the built-in foreground.
    expect(themeTokensToCssVars({ primary: 'teal' })['--sipkit-primary-foreground']).toBeUndefined();
  });

  it('drops unknown keys and unsafe values', () => {
    expect(
      themeTokensToCssVars({
        primary: 'red; background: url(x)',
        nope: '#fff',
        border: '',
        input: 42,
      } as never),
    ).toEqual({});
    expect(themeTokensToCssVars(null)).toEqual({});
  });

  it('parses the theme-tokens attribute', () => {
    expect(parseThemeTokens('{"primary":"#0a7"}')).toEqual({ primary: '#0a7' });
    expect(parseThemeTokens('not json')).toBeUndefined();
    expect(parseThemeTokens('[1]')).toBeUndefined();
    expect(parseThemeTokens('')).toBeUndefined();
  });
});
