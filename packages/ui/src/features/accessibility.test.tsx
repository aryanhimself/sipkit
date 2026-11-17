import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '@/i18n/context';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

async function renderRegistered(config = {}, options = {}) {
  const phone = createPhone(config, options);
  const utils = render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return { phone, ...utils };
}

const polite = () => screen.getByTestId('announcer-polite').textContent?.trim();
const assertive = () => screen.getByTestId('announcer-assertive').textContent?.trim();

describe('call failure messages', () => {
  it('maps reasons and SIP codes to words', () => {
    const i18n = createI18n('en');
    expect(i18n.callFailure('failed', 404)).toBe('Number not reachable (404)');
    expect(i18n.callFailure('busy', 486)).toBe('Busy (486)');
    expect(i18n.callFailure('failed', 599)).toBe('Call failed (599)');
    expect(i18n.callFailure('failed')).toBe('Call failed');
    expect(i18n.callFailure('media-error')).toMatch(/^Microphone blocked — allow microphone access/);
    expect(i18n.callFailure('local-hangup')).toBeNull();
    expect(i18n.callFailure('transferred', 302)).toBeNull();
    expect(createI18n('ne').callFailure('failed', 404)).toBe('नम्बरमा सम्पर्क हुन सकेन (404)');
  });

  it('shows "Busy (486)" as an alert and in the history row', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered({}, { busyNumbers: ['1009'] });
    await act(async () => {
      await phone.call('1009');
    });
    const alert = await screen.findByTestId('call-failure');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain("Call to 1009 didn't go through");
    expect(within(alert).getByTestId('call-failure-reason').textContent).toBe('Busy (486)');

    await user.click(screen.getByRole('tab', { name: 'History' }));
    const row = await screen.findByTestId('history-row');
    expect(within(row).getByTestId('history-detail').textContent).toBe('Busy (486)');
    // The status text is part of the row's accessible description.
    const described = row.getAttribute('aria-describedby')!;
    expect(document.getElementById(described)?.textContent).toContain('Busy (486)');
  });

  it('explains an unreachable number (404), dismisses and calls again', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    act(() => phone.simulateCallFailure('failed', 404));
    expect((await screen.findByTestId('call-failure-reason')).textContent).toBe('Number not reachable (404)');

    await user.click(screen.getByRole('button', { name: 'Call again' }));
    expect(screen.queryByTestId('call-failure')).toBeNull();
    await waitFor(() => expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('1002'));

    act(() => phone.simulateCallFailure('failed', 404));
    await screen.findByTestId('call-failure');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('call-failure')).toBeNull();
  });

  it('shows the failure as one compact line that hides itself', async () => {
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('9841429506');
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => phone.simulateCallFailure('failed', 480));
      const alert = await screen.findByTestId('call-failure');
      expect(alert.textContent).toContain('Not available right now (480)');
      // Screen readers still get the full sentence.
      expect(alert.textContent).toContain("didn't go through");
      act(() => vi.advanceTimersByTime(7_000));
      expect(screen.queryByTestId('call-failure')).not.toBeNull();
      act(() => vi.advanceTimersByTime(1_500));
      expect(screen.queryByTestId('call-failure')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a one-line no-audio hint on the call screen instead of a toast', async () => {
    const phone = createPhone({ callQualityInterval: 0.1 }, { network: { lossPct: 100, rttMs: 40, jitterMs: 2 } });
    render(<Softphone softphone={phone} toaster={false} />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    await act(async () => {
      await phone.call('1002');
    });
    const hint = await screen.findByTestId('call-no-audio', {}, { timeout: 3000 });
    expect(hint.textContent).toBe('The network may be blocking call audio. Try another network.');
    expect(hint.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('call-quality').textContent).toBe('No audio');
  });

  it('tells the user when the microphone is blocked', async () => {
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    act(() => phone.simulateCallFailure('media-error'));
    expect((await screen.findByTestId('call-failure-reason')).textContent).toBe(
      'Microphone blocked — allow microphone access in your browser settings',
    );
  });

  it('does not show an error when a call simply ends', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Hang up' }));
    expect(screen.queryByTestId('call-failure')).toBeNull();
  });
});

describe('screen reader announcements', () => {
  it('announces connected, on hold, resumed and ended once, in the polite region', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(polite()).toBe('Connected to 1002'));
    // The status line ticks every second, so it must not be a live region itself.
    expect(screen.getByTestId('call-status').getAttribute('aria-live')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(polite()).toBe('Call with 1002 on hold'));
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(polite()).toBe('Call with 1002 resumed'));
    await user.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(polite()).toBe('Call with 1002 ended'));
  });

  it('announces registration once (the pill is not a second live region)', async () => {
    await renderRegistered();
    expect(polite()).toBe('Registration: Online');
    expect(screen.getByTestId('registration-pill').getAttribute('aria-live')).toBe('off');
  });

  it('a failed call is reported by its alert, not the polite region', async () => {
    const { phone } = await renderRegistered({}, { busyNumbers: ['1009'] });
    await act(async () => {
      await phone.call('1009');
    });
    await screen.findByTestId('call-failure');
    expect(polite()).not.toMatch(/ended/);
  });

  it('moves focus to Answer for a ringing call on an idle phone', async () => {
    const { phone } = await renderRegistered();
    act(() => phone.simulateIncomingCall('5550100', 'Jane Customer'));
    const card = await screen.findByTestId('incoming-call');
    const answer = within(card).getByRole('button', { name: 'Answer' });
    await waitFor(() => expect(document.activeElement).toBe(answer));
    expect(answer.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(within(card).getByRole('button', { name: 'Decline' }).getAttribute('aria-keyshortcuts')).toBe('Escape');
  });

  it('announces a second incoming call assertively without stealing focus', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    const hold = screen.getByRole('button', { name: 'Hold' });
    hold.focus();
    act(() => phone.simulateIncomingCall('5550100', 'Jane Customer'));
    const banner = await screen.findByTestId('incoming-call');
    expect(banner.getAttribute('role')).toBe('alertdialog');
    expect(assertive()).toBe('Incoming call from Jane Customer');
    expect(document.activeElement).toBe(hold);
    // Escape declines from anywhere in the widget.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('incoming-call')).toBeNull());
  });
});

describe('keyboard and names', () => {
  it('every button in the call screen has an accessible name', async () => {
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    const callScreen = screen.getByTestId('call-screen');
    for (const button of within(callScreen).getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim(), button.outerHTML).not.toBe('');
    }
    // Decorative icons are hidden from assistive tech.
    for (const svg of callScreen.querySelectorAll('svg')) {
      expect(svg.closest('[aria-hidden="true"]'), svg.outerHTML).not.toBeNull();
    }
  });

  it('returns focus to the Keypad button when the in-call keypad closes', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Keypad' }));
    await user.click(screen.getByRole('button', { name: 'Hide keypad' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keypad' }));
  });

  it('switches lines with the arrow keys (one tab stop)', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
      await phone.call('1003');
    });
    const tabs = within(screen.getByRole('tablist', { name: 'Lines' })).getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0]);
    tabs[1]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(phone.getSnapshot().activeCallId).toBe(phone.getSnapshot().calls[0]!.id);
    await waitFor(() => expect(document.activeElement).toBe(tabs[0]));
    await user.keyboard('{End}');
    expect(phone.getSnapshot().activeCallId).toBe(phone.getSnapshot().calls[1]!.id);
  });

  it('transfer type is a radio group operable with the arrow keys', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    const dialog = await screen.findByRole('dialog');
    const blind = within(dialog).getByRole('radio', { name: /Blind/ });
    const attended = within(dialog).getByRole('radio', { name: /Attended/ });
    expect(blind.getAttribute('aria-checked')).toBe('true');
    expect(attended.tabIndex).toBe(-1);
    blind.focus();
    await user.keyboard('{ArrowRight}');
    expect(attended.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(attended);
    // Escape closes the dialog and focus goes back to the Transfer button.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Transfer' })));
  });
});

describe('login form', () => {
  it('marks a missing username invalid and links the message', async () => {
    const user = userEvent.setup();
    render(<Softphone softphone={createPhone({ username: '', password: '' })} toaster={false} />);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    const username = screen.getByLabelText('Extension / username');
    expect(username.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(username.getAttribute('aria-describedby')!);
    expect(message?.textContent).toContain('Enter your extension or username');
    expect(document.activeElement).toBe(username);
  });

  it('marks both credentials invalid on 403', async () => {
    const user = userEvent.setup();
    render(<Softphone softphone={createPhone({ username: '', password: '' })} toaster={false} />);
    await user.type(screen.getByLabelText('Extension / username'), '1002');
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    await user.type(password, 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByRole('alert');
    // The form is shown again for the failed registration: query the fields afresh.
    await waitFor(() => expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true'));
    const passwordAgain = screen.getByLabelText('Password') as HTMLInputElement;
    expect(screen.getByLabelText('Extension / username').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(passwordAgain.getAttribute('aria-describedby')!)?.textContent).toContain('403');
  });
});
