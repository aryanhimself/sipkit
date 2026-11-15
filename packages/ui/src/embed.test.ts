import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockSoftphone } from 'sipkit-react/testing';
import type { SoftphoneConfigInput } from 'sipkit-core';
import { SipkitPhoneElement, loadCoreFactory, setFactory } from './embed';

function mockFactory() {
  const created: MockSoftphone[] = [];
  const factory = vi.fn((config: SoftphoneConfigInput) => {
    const phone = new MockSoftphone(config, { registerDelayMs: 0, ringDelayMs: 1, connectDelayMs: 5 });
    created.push(phone);
    return phone;
  });
  return { factory, created };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('<sipkit-phone>', () => {
  it('registers the custom element and the global API', () => {
    expect(customElements.get('sipkit-phone')).toBe(SipkitPhoneElement);
    expect(typeof window.Sipkit?.setFactory).toBe('function');
    expect(typeof window.Sipkit?.createMockSoftphone).toBe('function');
  });

  it('builds config from attributes, renders into shadow DOM and re-dispatches events', async () => {
    const { factory, created } = mockFactory();
    const el = document.createElement('sipkit-phone');
    el.factory = factory;
    el.setAttribute('username', '1001');
    el.setAttribute('password', 'pw');
    el.setAttribute('ws-url', 'wss://pbx.example.com:8089/ws');
    el.setAttribute('domain', 'pbx.example.com');
    el.setAttribute('tech-prefix', '9');
    el.setAttribute('brand-name', 'Acme Phone');
    el.setAttribute('theme', 'dark');

    const registrations: string[] = [];
    const callEvents: string[] = [];
    const cdrs: unknown[] = [];
    el.addEventListener('sipkit:registration', (e) => registrations.push((e as CustomEvent).detail.state));
    el.addEventListener('sipkit:call', (e) => callEvents.push((e as CustomEvent).detail.type));
    el.addEventListener('sipkit:cdr', (e) => cdrs.push((e as CustomEvent).detail));
    const ready = new Promise((resolve) => el.addEventListener('sipkit:ready', resolve, { once: true }));
    document.body.appendChild(el);
    await ready;

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        username: '1001',
        password: 'pw',
        websocketUrls: ['wss://pbx.example.com:8089/ws'],
        domain: 'pbx.example.com',
        techPrefix: '9',
        brandName: 'Acme Phone',
      }),
    );
    const phone = created[0]!;
    expect(el.softphone).toBe(phone);
    await waitFor(() => expect(registrations).toContain('registered'));

    const shadow = el.shadowRoot!;
    expect(shadow.querySelector('style')).toBeTruthy();
    await waitFor(() => expect(shadow.querySelector('[data-testid="brand-name"]')?.textContent).toBe('Acme Phone'));
    expect(shadow.querySelector('.sipkit-phone')?.getAttribute('data-theme')).toBe('dark');

    await phone.call('1002');
    await phone.hangup();
    expect(callEvents).toEqual(expect.arrayContaining(['created', 'updated', 'ended']));
    expect(cdrs).toHaveLength(1);

    // attribute changes are applied with updateConfig
    el.setAttribute('brand-name', 'Renamed');
    await waitFor(() => expect(phone.config.brandName).toBe('Renamed'));

    // config property merges on top
    el.config = { brandName: 'From property', disabledFeatures: ['history'] };
    await waitFor(() => expect(phone.config.disabledFeatures).toEqual(['history']));

    const destroy = vi.spyOn(phone, 'destroy');
    el.remove();
    await waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it('switches language with the reactive locale attribute and messages property', async () => {
    const { factory } = mockFactory();
    const el = document.createElement('sipkit-phone');
    el.factory = factory;
    el.setAttribute('username', '1001');
    el.setAttribute('locale', 'ne');
    const ready = new Promise((resolve) => el.addEventListener('sipkit:ready', resolve, { once: true }));
    document.body.appendChild(el);
    await ready;
    const shadow = el.shadowRoot!;
    // The call button is the dialpad's only direct button child.
    const dialLabel = () => shadow.querySelector('[data-testid="dialpad-dial"] > button')?.getAttribute('aria-label');
    await waitFor(() => expect(dialLabel()).toBe('कल गर्नुहोस्'));
    expect(shadow.querySelector('.sipkit-phone')?.getAttribute('lang')).toBe('ne');

    el.setAttribute('locale', 'en');
    await waitFor(() => expect(dialLabel()).toBe('Call'));

    el.messages = { 'dialpad.call': 'Dial' };
    await waitFor(() => expect(dialLabel()).toBe('Dial'));
    expect(typeof window.Sipkit?.registerLocale).toBe('function');
  });

  it('uses the global factory from Sipkit.setFactory', async () => {
    const { factory } = mockFactory();
    setFactory(factory);
    const el = document.createElement('sipkit-phone');
    el.setAttribute('username', '2002');
    const ready = new Promise((resolve) => el.addEventListener('sipkit:ready', resolve, { once: true }));
    document.body.appendChild(el);
    await ready;
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ username: '2002' }));
  });

  it('defaults to core createSoftphone with the built-in plugins', async () => {
    const factory = await loadCoreFactory();
    expect(factory).toBeTypeOf('function');
    const api = await factory!({ username: '3003', autoRegister: false, logLevel: 'silent' });
    expect(api.config.username).toBe('3003');
    await (api as { ready?: Promise<void> }).ready;
    expect(api.plugin('call-history')).toBeDefined();
    expect(api.plugin('contacts')).toBeDefined();
    await api.stop();
  });
});
