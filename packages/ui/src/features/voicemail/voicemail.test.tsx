import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SoftphoneConfigInput } from 'sipkit-core';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

async function renderPhone(config: SoftphoneConfigInput = {}) {
  const phone = createPhone(config);
  render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() =>
    expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'),
  );
  return phone;
}

describe('VoicemailBadge', () => {
  it('is hidden unless voicemail is enabled', async () => {
    await renderPhone();
    expect(screen.queryByTestId('voicemail-badge')).toBeNull();
  });

  it('is hidden when the voicemail feature is disabled', async () => {
    await renderPhone({
      voicemail: { enabled: true, number: '*97' },
      disabledFeatures: ['voicemail'],
    });
    expect(screen.queryByTestId('voicemail-badge')).toBeNull();
  });

  it('shows the new-message count and dials voicemail on click', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone({ voicemail: { enabled: true, number: '*97' } });
    const badge = screen.getByTestId('voicemail-badge');
    expect(badge.dataset.count).toBe('0');
    expect(screen.queryByTestId('voicemail-count')).toBeNull();
    expect(badge.getAttribute('aria-label')).toMatch(/No new voicemail\. Call voicemail/);

    act(() => phone.simulateVoicemail({ new: 3, old: 2 }));
    expect(badge.dataset.count).toBe('3');
    expect(screen.getByTestId('voicemail-count').textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toMatch(/^3 new voicemails/);

    await user.click(badge);
    await waitFor(() => expect(screen.getByTestId('call-screen')).toBeTruthy());
    expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('*97');
  });

  it('is disabled without a voicemail number until the server reports one', async () => {
    const phone = await renderPhone({ voicemail: { enabled: true } });
    const badge = screen.getByTestId('voicemail-badge') as HTMLButtonElement;
    expect(badge.disabled).toBe(true);
    act(() => phone.simulateVoicemail({ waiting: true, account: 'sip:*97@pbx' }));
    expect(badge.disabled).toBe(false);
    expect(screen.getByTestId('voicemail-count').textContent).toBe('');
  });
});

describe('DndToggle', () => {
  it('toggles DND with a visible pressed state, mirrored in settings', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    const toggle = screen.getByTestId('dnd-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(phone.getSnapshot().dnd).toBe(true);
    expect(toggle.dataset.state).toBe('on');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(phone.simulateIncomingCall('1002')).toBeUndefined();
    expect(screen.queryByTestId('incoming-call')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /settings/i }));
    const sw = screen.getByRole('switch', { name: 'Do Not Disturb' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.click(sw);
    expect(phone.getSnapshot().dnd).toBe(false);
    expect(toggle.dataset.state).toBe('off');
  });

  it('server mode: busy while the feature code runs, reverts on failure', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone({ dnd: { mode: 'server' } });
    const toggle = screen.getByTestId('dnd-toggle') as HTMLButtonElement;
    await user.click(toggle);
    expect(toggle.dataset.state).toBe('on');
    expect(toggle.dataset.pending).toBe('true');
    expect(toggle.disabled).toBe(true);
    await waitFor(() => expect(toggle.dataset.pending).toBeUndefined());
    expect(phone.getSnapshot().dnd).toBe(true);

    phone.failNextServerDnd();
    await user.click(toggle);
    expect(toggle.dataset.state).toBe('off');
    await waitFor(() => expect(toggle.dataset.pending).toBeUndefined());
    expect(toggle.dataset.state).toBe('on'); // reverted
  });

  it('can be hidden with disabledFeatures', async () => {
    await renderPhone({ disabledFeatures: ['dnd'] });
    expect(screen.queryByTestId('dnd-toggle')).toBeNull();
  });
});
