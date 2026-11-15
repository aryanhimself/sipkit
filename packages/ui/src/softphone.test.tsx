import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Softphone } from './softphone';
import { createPhone } from './test/utils';

async function renderRegistered(props: Partial<Parameters<typeof Softphone>[0]> = {}, config = {}) {
  const phone = createPhone(config);
  const utils = render(<Softphone softphone={phone} toaster={false} {...props} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return { phone, ...utils };
}

describe('<Softphone />', () => {
  it('shows the login form and signs in', async () => {
    const user = userEvent.setup();
    const phone = createPhone({ username: '', password: '' });
    render(<Softphone softphone={phone} toaster={false} />);
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeTruthy();
    await user.type(screen.getByLabelText('Extension / username'), '1002');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    expect(phone.config.username).toBe('1002');
    expect(screen.getByLabelText('Number to dial')).toBeTruthy();
  });

  it('shows the failure reason when registration is rejected', async () => {
    const user = userEvent.setup();
    const phone = createPhone({ username: '', password: '' });
    render(<Softphone softphone={phone} toaster={false} />);
    await user.type(screen.getByLabelText('Extension / username'), '1002');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('403'));
  });

  it('uses brandName from config', async () => {
    await renderRegistered({}, { brandName: 'Acme Desk' });
    expect(screen.getByTestId('brand-name').textContent).toBe('Acme Desk');
    expect(screen.getByRole('region', { name: 'Acme Desk' })).toBeTruthy();
  });

  it('dials with the keypad, connects, holds, mutes, sends DTMF and hangs up', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '0 (hold for +)' }));
    await user.click(screen.getByRole('button', { name: '0 (hold for +)' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    expect((screen.getByLabelText('Number to dial') as HTMLInputElement).value).toBe('1002');
    await user.click(screen.getByRole('button', { name: 'Call' }));

    const screenEl = await screen.findByTestId('call-screen');
    expect(within(screenEl).getByTestId('call-title').textContent).toBe('1002');
    await waitFor(() => expect(screenEl.dataset.callState).toBe('connected'));

    await user.click(screen.getByRole('button', { name: 'Hold' }));
    expect(phone.getSnapshot().calls[0]!.state).toBe('held');
    expect(screen.getByTestId('call-status').textContent).toMatch(/On hold/);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(phone.getSnapshot().calls[0]!.state).toBe('connected');

    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(phone.getSnapshot().calls[0]!.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Keypad' }));
    const dtmf = screen.getByTestId('dialpad-dtmf');
    await user.click(within(dtmf).getByRole('button', { name: '5' }));
    await user.click(within(dtmf).getByRole('button', { name: '#' }));
    expect(phone.dtmfLog.map((d) => d.tones).join('')).toBe('5#');

    await user.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(screen.queryByTestId('call-screen')).toBeNull());
    expect(phone.cdrs).toHaveLength(1);
  });

  it('Enter calls from the dial input and Esc hangs up', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await user.type(screen.getByLabelText('Number to dial'), '1003{Enter}');
    await screen.findByTestId('call-screen');
    expect(phone.getSnapshot().calls[0]!.remoteNumber).toBe('1003');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('call-screen')).toBeNull());
  });

  it('strips formatting when pasting a number', async () => {
    const user = userEvent.setup();
    await renderRegistered();
    const input = screen.getByLabelText('Number to dial') as HTMLInputElement;
    await user.click(input);
    await user.paste('+1 (555) 123-4567');
    expect(input.value).toBe('+15551234567');
  });

  it('long-press 0 inserts +', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderRegistered();
      const zero = screen.getByRole('button', { name: '0 (hold for +)' });
      fireEvent.pointerDown(zero, { button: 0 });
      act(() => {
        vi.advanceTimersByTime(700);
      });
      fireEvent.pointerUp(zero);
      expect((screen.getByLabelText('Number to dial') as HTMLInputElement).value).toBe('+');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers an incoming call with the button and rejects with Esc', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    act(() => {
      phone.simulateIncomingCall('5550100', 'Alice Smith');
    });
    const card = await screen.findByTestId('incoming-call');
    expect(within(card).getByText('Alice Smith')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(screen.getByTestId('call-screen').dataset.callState).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Hang up' }));

    act(() => {
      phone.simulateIncomingCall('5550101');
    });
    await screen.findByTestId('incoming-call');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('incoming-call')).toBeNull());
    expect(phone.cdrs.at(-1)!.reason).toBe('rejected');
  });

  it('Enter answers a ringing call', async () => {
    const { phone } = await renderRegistered();
    act(() => {
      phone.simulateIncomingCall('5550102');
    });
    const card = await screen.findByTestId('incoming-call');
    fireEvent.keyDown(card, { key: 'Enter' });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
  });

  it('switches lines and merges into a conference', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Add call' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Number'), '1003');
    await user.click(within(dialog).getByRole('button', { name: 'Call' }));
    await waitFor(() => expect(phone.getSnapshot().calls).toHaveLength(2));
    const tabs = screen.getByRole('tablist', { name: 'Lines' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    await waitFor(() => expect(phone.getSnapshot().calls[1]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(phone.getSnapshot().calls.every((c) => c.inConference)).toBe(true);
    expect(screen.getByTestId('call-title').textContent).toBe('Conference call');
    await user.click(within(tabs).getAllByRole('tab')[0]!);
    expect(phone.getSnapshot().activeCallId).toBe(phone.getSnapshot().calls[0]!.id);
  });

  it('blind and attended transfer', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Number'), '1009');
    await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(phone.cdrs.at(-1)?.reason).toBe('transferred'));

    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Attended/ }));
    await user.type(within(dialog).getByLabelText('Number'), '1004');
    await user.click(within(dialog).getByRole('button', { name: /consult/i }));
    const banner = await screen.findByRole('region', { name: 'Attended transfer' });
    await waitFor(() => expect(within(banner).getByRole('button', { name: /Complete/ })).toHaveProperty('disabled', false));
    await user.click(within(banner).getByRole('button', { name: /Complete/ }));
    await waitFor(() => expect(phone.getSnapshot().calls).toHaveLength(0));
  });

  it('records history and calls back from it', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await act(async () => {
      await phone.call('1007');
    });
    await act(() => phone.hangup());
    await user.click(screen.getByRole('tab', { name: 'History' }));
    const list = await screen.findByRole('list', { name: 'Call history' });
    await user.click(within(list).getByRole('button', { name: /1007/ }));
    await screen.findByTestId('call-screen');
    expect(phone.getSnapshot().calls[0]!.remoteNumber).toBe('1007');
  });

  it('lists contacts and resolves caller names', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered({
      contacts: [{ id: '1', name: 'Bob Builder', number: '2001', description: 'Support' }],
    });
    await user.click(screen.getByRole('tab', { name: 'Contacts' }));
    await user.type(screen.getByLabelText('Search contacts'), 'bob');
    await user.click(screen.getByRole('button', { name: 'Call Bob Builder' }));
    expect(await screen.findByTestId('call-title')).toHaveProperty('textContent', 'Bob Builder');
    expect(phone.getSnapshot().calls[0]!.remoteNumber).toBe('2001');
  });

  it('respects disabledFeatures (case-insensitive)', async () => {
    const { phone } = await renderRegistered({}, { disabledFeatures: ['HISTORY', 'Contacts', 'transfer', 'conference'] });
    expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Contacts' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();
    await act(async () => {
      await phone.call('1002');
    });
    await waitFor(() => expect(phone.getSnapshot().calls[0]!.state).toBe('connected'));
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add call' })).toBeNull();
  });

  it('settings change devices and auto-answer', async () => {
    const user = userEvent.setup();
    const { phone } = await renderRegistered();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Microphone'), 'headset-mic');
    expect(phone.getSnapshot().devices.selected.microphone).toBe('headset-mic');
    await user.click(screen.getByRole('switch', { name: 'Auto-answer' }));
    await waitFor(() => expect(phone.config.autoAnswer).toBe(true));
  });

  it('renders extension tabs, call actions, panels and slots', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { phone } = await renderRegistered({
      extensions: {
        tabs: [{ id: 'crm', label: 'CRM', order: 5, render: (ctx) => <p>CRM for {ctx.api.config.username}</p> }],
        callActions: [{ id: 'ticket', label: 'Ticket', icon: <span>T</span>, onSelect }],
        panels: [{ id: 'notes', title: 'Notes', showInCompact: true, when: 'in-call', render: () => <p>Call notes</p> }],
      },
      slots: {
        callInfo: (call) => <p>CRM match for {call.remoteNumber}</p>,
        headerActions: () => <button type="button">Help</button>,
      },
    });
    expect(screen.getByRole('button', { name: 'Help' })).toBeTruthy();
    const tabNames = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabNames).toEqual(['Phone', 'CRM', 'History', 'Contacts', 'Settings']);
    await user.click(screen.getByRole('tab', { name: 'CRM' }));
    expect(screen.getByText('CRM for 1001')).toBeTruthy();

    expect(screen.queryByText('Call notes')).toBeNull();
    await act(async () => {
      await phone.call('1002');
    });
    expect(await screen.findByText('CRM match for 1002')).toBeTruthy();
    expect(screen.getByText('Call notes')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ticket' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ remoteNumber: '1002' }), expect.anything());
  });

  it('full layout shows phone and side tabs together', async () => {
    await renderRegistered({ layout: 'full' });
    expect(screen.getByLabelText('Number to dial')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Phone' })).toBeNull();
  });

  it('applies theme and brand color', async () => {
    await renderRegistered({ theme: 'dark', brandColor: '#0f766e' });
    const root = screen.getByRole('region', { name: 'SipKit' });
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.getPropertyValue('--sipkit-primary')).toBe('#0f766e');
  });
});
