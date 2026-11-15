import { describe, expect, it } from 'vitest';
import { unlayer } from '../../build/unlayer-css';
import { isFeatureEnabled } from './features';
import { formatNumber, initials, sanitizePastedNumber } from './format';

describe('format helpers', () => {
  it('initials', () => {
    expect(initials('Jane Doe')).toBe('JD');
    expect(initials('1002')).toBe('#');
    expect(initials(undefined)).toBe('#');
  });
  it('sanitizes pasted numbers', () => {
    expect(sanitizePastedNumber(' +44 (20) 7946-0958 ')).toBe('+442079460958');
    expect(sanitizePastedNumber('tel:555.123.4567')).toBe('5551234567');
    expect(sanitizePastedNumber('sip:alice@pbx.example.com')).toBe('sip:alice@pbx.example.com');
  });
  it('formats long numbers', () => {
    expect(formatNumber('1002')).toBe('1002');
    expect(formatNumber('+15551234567')).toBe('+155 512 34567');
  });
});

describe('isFeatureEnabled', () => {
  it('is case-insensitive', () => {
    expect(isFeatureEnabled({ disabledFeatures: ['History'] }, 'history')).toBe(false);
    expect(isFeatureEnabled({ disabledFeatures: ['history'] }, 'contacts')).toBe(true);
  });
});

describe('unlayer', () => {
  it('removes @layer statements and wrappers, keeping order', () => {
    const css = '@layer theme,base;@layer theme{:root{--a:1}}.x{color:red}@layer utilities{.p{padding:0}@media (min-width:1px){.q{margin:0}}}';
    expect(unlayer(css)).toBe(':root{--a:1}.x{color:red}.p{padding:0}@media (min-width:1px){.q{margin:0}}');
  });
  it('treats escaped quotes in selectors as plain characters', () => {
    const css = "@layer utilities{.\\[\\&_svg\\:not\\(\\[class\\*\\=\\'size-\\'\\]\\)\\]\\:size-4 svg{width:1rem}.y{color:red}}@property --z{syntax:'*'}";
    expect(unlayer(css)).toBe(
      ".\\[\\&_svg\\:not\\(\\[class\\*\\=\\'size-\\'\\]\\)\\]\\:size-4 svg{width:1rem}.y{color:red}@property --z{syntax:'*'}",
    );
  });
});
