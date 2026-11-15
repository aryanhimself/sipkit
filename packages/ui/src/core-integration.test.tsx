/**
 * The UI against the real core Softphone driven by core's FakeEngine
 * (instead of the in-memory MockSoftphone), with the built-in plugins.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { callHistoryPlugin, contactsPlugin } from 'sipkit-core';
import { createTestSoftphone } from 'sipkit-core/testing';
import { Softphone } from './softphone';

async function setup() {
  const { softphone, engine } = await createTestSoftphone({
    config: { logLevel: 'silent' },
    plugins: [
      callHistoryPlugin(),
      contactsPlugin({ initial: [{ name: 'Carol Core', number: '3001' }] }),
    ],
  });
  render(<Softphone softphone={softphone} toaster={false} persistHistory={false} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return { softphone, engine };
}

describe('<Softphone /> with core Softphone + FakeEngine', () => {
  it('places a call, holds, mutes, sends DTMF and hangs up; history comes from the plugin', async () => {
    const user = userEvent.setup();
    const { softphone, engine } = await setup();
    await user.type(screen.getByLabelText('Number to dial'), '1002{Enter}');
    const callScreen = await screen.findByTestId('call-screen');
    const engineCallId = [...engine.calls.keys()][0]!;
    act(() => engine.simulateRemoteAnswer(engineCallId));
    await waitFor(() => expect(callScreen.dataset.callState).toBe('connected'));

    await user.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(softphone.getSnapshot().calls[0]!.state).toBe('held'));
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(softphone.getSnapshot().calls[0]!.state).toBe('connected'));
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(softphone.getSnapshot().calls[0]!.muted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Keypad' }));
    await user.click(within(screen.getByTestId('dialpad-dtmf')).getByRole('button', { name: '7' }));
    await waitFor(() => expect(engine.commandsFor('sendDtmf')).toEqual([[engineCallId, '7']]));

    await user.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(screen.queryByTestId('call-screen')).toBeNull());

    await user.click(screen.getByRole('tab', { name: 'History' }));
    const list = await screen.findByRole('list', { name: 'Call history' });
    expect(within(list).getByText('1002')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Clear/ }));
    await screen.findByText('No recent calls');
  });

  it('answers an incoming call and resolves the name from the contacts plugin', async () => {
    const user = userEvent.setup();
    const { softphone, engine } = await setup();
    act(() => {
      engine.simulateIncomingCall({ remoteNumber: '3001' });
    });
    const card = await screen.findByTestId('incoming-call');
    expect(within(card).getByText('Carol Core')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(softphone.getSnapshot().calls[0]?.state).toBe('connected'));

    await user.click(screen.getByRole('tab', { name: 'Contacts' }));
    expect(screen.getByText('Carol Core')).toBeTruthy();
  });
});
