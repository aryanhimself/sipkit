import type { Plugin } from 'vite';

/**
 * Removes `@layer` wrappers from the emitted library stylesheet.
 *
 * Unlayered host-page CSS always beats layered CSS, regardless of specificity.
 * When the widget is rendered in the light DOM of a CRM page, a host rule like
 * `button { background: blue }` would therefore override our utilities. Our
 * output keeps Tailwind's order (theme, base, utilities) and our base reset
 * uses zero-specificity `:where()`, so unwrapping preserves the cascade while
 * making the widget robust against host element selectors.
 */
export function unlayerCss(fileName = 'styles.css'): Plugin {
  return {
    name: 'sipkit-unlayer-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith(fileName)) continue;
        const source = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
        asset.source = unlayer(source);
      }
    },
  };
}

export function unlayer(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@layer', i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    // find either ';' (statement) or '{' (block)
    let j = at + 6;
    while (j < css.length && css[j] !== ';' && css[j] !== '{') j++;
    if (css[j] === ';') {
      i = j + 1; // drop `@layer a, b;`
      continue;
    }
    // block: copy inner content (recursively unlayered), drop wrapper
    let depth = 1;
    let k = j + 1;
    let quote: string | null = null;
    while (k < css.length && depth > 0) {
      const ch = css[k];
      if (ch === '\\') k++; // escaped char (also outside strings, e.g. `.\[class\*\=\'size-\'\]`)
      else if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      k++;
    }
    out += unlayer(css.slice(j + 1, k - 1));
    i = k;
  }
  return out;
}
