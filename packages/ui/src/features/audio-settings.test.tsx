import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from 'sipkit-core';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

async function renderPhone(phone = createPhone()) {
  render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

afterEach(() => localStorage.clear());

describe('microphone permission', () => {
  it('shows nothing on the dialer and "allowed" in Settings when the mic is already allowed', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    expect(screen.queryByTestId('mic-access')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByTestId('mic-access').dataset.state).toBe('granted');
    expect(screen.queryByRole('button', { name: 'Allow microphone' })).toBeNull();
    expect(phone.microphonePrompts).toBe(0);
  });

  it('asks only when the browser has not decided, and only once', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone(createPhone({}, { microphone: 'prompt' }));
    expect(screen.queryByTestId('mic-access')).toBeNull(); // no nagging on the dialer
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Allow microphone' }));
    await waitFor(() => expect(screen.getByTestId('mic-access').dataset.state).toBe('granted'));
    expect(await phone.requestMicrophone()).toBe('granted');
    expect(phone.microphonePrompts).toBe(1);
  });

  it('explains how to unblock a blocked mic instead of asking again', async () => {
    const phone = await renderPhone();
    act(() => phone.simulateMicrophonePermission('denied'));
    const banner = screen.getByTestId('mic-access');
    expect(banner.dataset.state).toBe('denied');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('Microphone blocked.');
    expect(screen.queryByRole('button', { name: 'Allow microphone' })).toBeNull();
    act(() => phone.simulateMicrophonePermission('granted'));
    expect(screen.queryByTestId('mic-access')).toBeNull();
  });
});

describe('microphone help from the host app (extension popup)', () => {
  it('uses the host text and action instead of in-page prompts', async () => {
    const onAllow = vi.fn();
    const user = userEvent.setup();
    const phone = createPhone({}, { microphone: 'prompt' });
    render(<Softphone softphone={phone} toaster={false} microphoneHelp={{ blocked: 'Open Options to allow it.', onAllow }} />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Allow microphone' }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(phone.microphonePrompts).toBe(0);
    act(() => phone.simulateMicrophonePermission('denied'));
    const notices = screen.getAllByTestId('mic-access');
    expect(notices[0]!.textContent).toContain('Open Options to allow it.');
    await user.click(screen.getAllByRole('button', { name: 'Fix microphone access' })[0]!);
    expect(onAllow).toHaveBeenCalledTimes(2);
  });
});

describe('voice processing settings', () => {
  it('switches the browser filters live and remembers them per account', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const noise = screen.getByRole('switch', { name: 'Reduce background noise' });
    expect(noise.getAttribute('aria-checked')).toBe('true');
    await user.click(noise);
    await waitFor(() => expect(phone.config.audioProcessing.noiseSuppression).toBe(false));
    await user.click(screen.getByRole('switch', { name: 'Isolate my voice' }));
    await waitFor(() => expect(phone.config.audioProcessing.voiceIsolation).toBe(true));
    expect(JSON.parse(localStorage.getItem('sipkit:audio-prefs:1001')!)).toMatchObject({
      noiseSuppression: false,
      voiceIsolation: true,
    });
    expect(screen.queryByRole('switch', { name: 'AI noise removal' })).toBeNull(); // plugin not installed
  });

  it('restores saved choices on the next start', async () => {
    localStorage.setItem('sipkit:audio-prefs:1001', JSON.stringify({ echoCancellation: false }));
    const phone = await renderPhone();
    await waitFor(() => expect(phone.config.audioProcessing.echoCancellation).toBe(false));
    expect(phone.config.audioProcessing.noiseSuppression).toBe(true);
  });

  it('offers AI noise removal when the plugin is installed', async () => {
    let enabled = true;
    const listeners = new Set<() => void>();
    const plugin = definePlugin({
      id: 'noise-suppression',
      setup: () => ({
        api: {
          get enabled() {
            return enabled;
          },
          supported: true,
          setEnabled(on: boolean) {
            enabled = on;
            for (const l of listeners) l();
          },
          subscribe(l: () => void) {
            listeners.add(l);
            return () => listeners.delete(l);
          },
        },
      }),
    });
    const user = userEvent.setup();
    await renderPhone(createPhone({}, { plugins: [plugin] }));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const toggle = await screen.findByRole('switch', { name: 'AI noise removal' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(enabled).toBe(false);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });
});
