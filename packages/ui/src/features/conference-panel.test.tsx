import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Softphone } from '../softphone';
import { createPhone } from '../test/utils';

async function threeWayConference() {
  const phone = createPhone({ maxLines: 4 });
  render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() =>
    expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'),
  );
  for (const n of ['1002', '1003', '1004']) {
    await act(async () => {
      await phone.call(n);
    });
    await waitFor(() =>
      expect(phone.getSnapshot().calls.find((c) => c.remoteNumber === n)?.state).toBe('connected'),
    );
  }
  expect(screen.queryByTestId('conference-panel')).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Merge' }));
  const panel = await screen.findByRole('region', { name: 'Conference' });
  return { phone, user, panel };
}

const byNumber = (phone: ReturnType<typeof createPhone>, n: string) =>
  phone.getSnapshot().calls.find((c) => c.remoteNumber === n)!;

describe('<ConferencePanel />', () => {
  it('lists every party with state and timer', async () => {
    const { panel } = await threeWayConference();
    const parties = within(panel).getAllByTestId('conference-party');
    expect(parties.map((p) => p.dataset.line)).toEqual(['1', '2', '3']);
    expect(parties.map((p) => p.dataset.state)).toEqual(['connected', 'connected', 'connected']);
    expect(within(parties[0]!).getByText('1002')).toBeTruthy();
    expect(within(parties[0]!).getByTestId('conference-party-status').textContent).toMatch(
      /^\d+:\d{2}/,
    );
    expect(within(panel).getByText(/3 parties/)).toBeTruthy();
  });

  it('mutes one party, removes one (kept on hold) and hangs up another', async () => {
    const { phone, user, panel } = await threeWayConference();

    const mute = within(panel).getByRole('button', { name: 'Mute 1002' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    await user.click(mute);
    expect(byNumber(phone, '1002').partyMuted).toBe(true);
    expect(
      within(panel).getByRole('button', { name: 'Unmute 1002' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await user.click(within(panel).getByRole('button', { name: 'Remove 1004 from conference' }));
    // the removed party was the active call: the call screen (and panel) re-mount for the next one
    const fresh = () => screen.getByRole('region', { name: 'Conference' });
    await waitFor(() => expect(within(fresh()).getAllByTestId('conference-party')).toHaveLength(2));
    expect(byNumber(phone, '1004')).toMatchObject({ inConference: false, state: 'held' });

    await user.click(within(fresh()).getByRole('button', { name: 'Hang up 1003' }));
    await waitFor(() => expect(screen.queryByTestId('conference-panel')).toBeNull());
    expect(byNumber(phone, '1002')).toMatchObject({ inConference: false, state: 'connected' });
    expect(byNumber(phone, '1003')).toBeUndefined();
  });

  it('Split breaks the conference into separate lines; one stays connected', async () => {
    const { phone, user, panel } = await threeWayConference();
    await user.click(within(panel).getByTestId('conference-split'));
    await waitFor(() => expect(screen.queryByTestId('conference-panel')).toBeNull());
    const calls = phone.getSnapshot().calls;
    expect(calls.every((c) => !c.inConference)).toBe(true);
    expect(calls.filter((c) => c.state === 'connected')).toHaveLength(1);
    expect(calls.filter((c) => c.state === 'held')).toHaveLength(2);
  });

  it('End conference hangs up every party', async () => {
    const { phone, user, panel } = await threeWayConference();
    await user.click(within(panel).getByRole('button', { name: /End conference/ }));
    await waitFor(() => expect(phone.getSnapshot().calls).toHaveLength(0));
  });
});

describe('<ConferencePanel /> server mode', () => {
  it('shows the room roster and only the controls the capabilities allow', async () => {
    const phone = createPhone({ conference: { mode: 'server' } });
    render(<Softphone softphone={phone} toaster={false} />);
    await waitFor(() =>
      expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'),
    );
    for (const n of ['1002', '6000']) {
      await act(async () => {
        await phone.call(n);
      });
      await waitFor(() =>
        expect(phone.getSnapshot().calls.find((c) => c.remoteNumber === n)?.state).toBe('connected'),
      );
    }
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    const panel = await screen.findByRole('region', { name: 'Conference' });
    expect(within(panel).getByTestId('conference-room').textContent).toBe('Room 71001');
    const parties = within(panel).getAllByTestId('conference-party');
    expect(parties.map((p) => p.textContent)).toEqual([
      expect.stringContaining('1002'),
      expect.stringContaining('6000'),
    ]);
    expect(within(panel).queryByRole('button', { name: /^Mute/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /from conference$/ })).toBeNull();
    expect(within(panel).queryByTestId('conference-split')).toBeNull();
    expect(screen.getByTestId('call-title').textContent).toBe('Conference call');
    // Parties stay in the room: the button says "Leave" and hangs up only our leg.
    const leave = within(panel).getByTestId('conference-end');
    expect(leave.textContent).toContain('Leave conference');
    await user.click(leave);
    await waitFor(() => expect(phone.getSnapshot().calls).toHaveLength(0));
  });
});
