import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePushPlatform } from 'sipkit-core/testing';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

const PUSH = { enabled: true, serviceUrl: 'https://push.test', token: 't', vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' };

async function renderPhone(platform: FakePushPlatform | null, push: Record<string, unknown> = PUSH, locale = 'en') {
  const phone = createPhone({ push }, { pushPlatform: platform });
  render(<Softphone softphone={phone} toaster={false} locale={locale} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 201 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('push UI', () => {
  it('renders nothing without browser support or config', async () => {
    await renderPhone(null);
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.queryByTestId('push-settings')).toBeNull();
  });

  it('prompt subscribes; "Not now" is remembered', async () => {
    const user = userEvent.setup();
    const platform = new FakePushPlatform();
    const phone = await renderPhone(platform);
    expect(screen.getByTestId('push-prompt').textContent).toContain('Never miss a call');
    await user.click(screen.getByTestId('push-prompt-enable'));
    await waitFor(() => expect(phone.getSnapshot().push?.subscribed).toBe(true));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    expect(platform.workerConfig?.labels).toMatchObject({ title: 'Incoming call', body: '{caller} is calling', answer: 'Answer' });

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const settings = screen.getByTestId('push-settings');
    expect(settings.dataset.subscribed).toBe('true');
    await user.click(screen.getByTestId('push-toggle'));
    await waitFor(() => expect(settings.dataset.subscribed).toBe('false'));
  });

  it('dismissing the prompt hides it for good', async () => {
    const user = userEvent.setup();
    await renderPhone(new FakePushPlatform());
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    expect(localStorage.getItem('sipkit:push-prompt-dismissed')).toBe('1');
  });

  it('shows the blocked state and the pending banner (ne)', async () => {
    const phone = await renderPhone(new FakePushPlatform({ permission: 'denied' }), PUSH, 'ne');
    expect(screen.queryByTestId('push-prompt')).toBeNull();
    act(() => phone.simulatePushLaunch({ action: 'answer', pushCallId: 'p1' }));
    expect(screen.getByTestId('push-pending').textContent).toContain('तपाईंको सूचनाबाट कल जोड्दै');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'सेटिङ' }));
    expect(screen.getByTestId('push-error').textContent).toContain('सूचनाहरू रोकिएका छन्');
    expect(screen.getByTestId('push-toggle')).toHaveProperty('disabled', true);
  });
});
