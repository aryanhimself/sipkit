import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockSoftphone } from 'sipkit-react/testing';
import type { SoftphoneConfigInput } from 'sipkit-core';
import { Softphone } from '../softphone';
import '../embed';
import { createPhone } from '../test/utils';

type Listener = (e: { matches: boolean }) => void;

/** A controllable prefers-color-scheme media query. */
function mockColorScheme(dark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  const spy = vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(() => mql as unknown as MediaQueryList);
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((l) => l({ matches: next }));
    },
    listeners,
    restore: () => spy.mockRestore(),
  };
}

const root = () => screen.getByRole('region', { name: 'SipKit' });

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('<Softphone> theme', () => {
  it("theme='system' follows prefers-color-scheme live", async () => {
    const scheme = mockColorScheme(false);
    render(<Softphone softphone={createPhone()} toaster={false} theme="system" />);
    expect(root().dataset.theme).toBe('light');
    act(() => scheme.set(true));
    expect(root().dataset.theme).toBe('dark');
    act(() => scheme.set(false));
    expect(root().dataset.theme).toBe('light');
  });

  it('an explicit theme ignores the OS setting and follows prop changes', () => {
    const scheme = mockColorScheme(true);
    const phone = createPhone();
    const { rerender } = render(<Softphone softphone={phone} toaster={false} theme="light" />);
    expect(root().dataset.theme).toBe('light');
    expect(scheme.listeners.size).toBe(0);
    rerender(<Softphone softphone={phone} toaster={false} theme="dark" />);
    expect(root().dataset.theme).toBe('dark');
  });

  it('themeTokens set --sipkit-* variables (dark ones as --sipkit-dark-*) and win over brandColor', () => {
    render(
      <Softphone
        softphone={createPhone()}
        toaster={false}
        brandColor="#2563eb"
        themeTokens={{
          primary: '#00aa77',
          radius: '0.25rem',
          callEnd: '#b91c1c',
          dark: { background: '#000000' },
        }}
      />,
    );
    const style = root().style;
    expect(style.getPropertyValue('--sipkit-primary')).toBe('#00aa77');
    expect(style.getPropertyValue('--sipkit-primary-foreground')).toBe('#111827');
    expect(style.getPropertyValue('--sipkit-radius')).toBe('0.25rem');
    expect(style.getPropertyValue('--sipkit-call-end')).toBe('#b91c1c');
    expect(style.getPropertyValue('--sipkit-dark-background')).toBe('#000000');
    expect(style.getPropertyValue('--sipkit-dark-foreground')).toBe('#ffffff');
  });

  it('brandColor alone sets primary and a readable primary-foreground', () => {
    render(<Softphone softphone={createPhone()} toaster={false} brandColor="#0f766e" />);
    expect(root().style.getPropertyValue('--sipkit-primary')).toBe('#0f766e');
    expect(root().style.getPropertyValue('--sipkit-primary-foreground')).toBe('#ffffff');
  });
});

describe('<sipkit-phone> theme', () => {
  function factory(config: SoftphoneConfigInput) {
    return new MockSoftphone({ ...config, username: '1001' }, { registerDelayMs: 0 });
  }

  async function mount(attrs: Record<string, string>) {
    const el = document.createElement('sipkit-phone');
    el.factory = factory;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const ready = new Promise((resolve) =>
      el.addEventListener('sipkit:ready', resolve, { once: true }),
    );
    document.body.appendChild(el);
    await ready;
    const inner = () => el.shadowRoot!.querySelector<HTMLElement>('.sipkit-phone');
    await waitFor(() => expect(inner()).toBeTruthy());
    return { el, inner: () => inner()! };
  }

  it('applies the theme and theme-tokens attributes and reacts to changes', async () => {
    const { el, inner } = await mount({
      theme: 'dark',
      'theme-tokens': '{"primary":"#0a7","dark":{"card":"#111"}}',
    });
    expect(inner().dataset.theme).toBe('dark');
    expect(inner().style.getPropertyValue('--sipkit-primary')).toBe('#0a7');
    expect(inner().style.getPropertyValue('--sipkit-dark-card')).toBe('#111');

    el.setAttribute('theme', 'light');
    await waitFor(() => expect(inner().dataset.theme).toBe('light'));

    el.setAttribute('theme-tokens', '{"radius":"2px"}');
    await waitFor(() => expect(inner().style.getPropertyValue('--sipkit-radius')).toBe('2px'));
    expect(inner().style.getPropertyValue('--sipkit-primary')).toBe('');
  });

  it('merges the themeTokens property over the attribute and ignores invalid JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { el, inner } = await mount({ 'theme-tokens': '{"primary":"#0a7","radius":"4px"}' });
    el.themeTokens = { primary: '#123456' };
    await waitFor(() => expect(inner().style.getPropertyValue('--sipkit-primary')).toBe('#123456'));
    expect(inner().style.getPropertyValue('--sipkit-radius')).toBe('4px');

    el.themeTokens = undefined;
    el.setAttribute('theme-tokens', '{oops');
    await waitFor(() => expect(inner().style.getPropertyValue('--sipkit-radius')).toBe(''));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('theme-tokens'));
  });

  it('falls back to system for an unknown theme value', async () => {
    mockColorScheme(true);
    const { inner } = await mount({ theme: 'sepia' });
    expect(inner().dataset.theme).toBe('dark');
  });
});
