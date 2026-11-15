import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SoftphoneConfigInput } from 'sipkit-core';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

async function renderPhone(config: SoftphoneConfigInput = {}) {
  const phone = createPhone(config);
  render(
    <Softphone
      softphone={phone}
      toaster={false}
      contacts={[{ id: 'a', name: 'Alice Johnson', number: '1002' }]}
    />,
  );
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

const PRESENCE: SoftphoneConfigInput = { presence: { enabled: true, watch: ['1002', '1003'] } };

describe('BLF panel and presence lamps', () => {
  it('has no BLF tab unless presence is enabled', async () => {
    await renderPhone();
    expect(screen.queryByRole('tab', { name: 'Lamps' })).toBeNull();
  });

  it('shows lamps with text, calls on click and picks up a ringing extension', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone(PRESENCE);
    await user.click(screen.getByRole('tab', { name: 'Lamps' }));
    const panel = screen.getByTestId('blf-panel');
    const tiles = within(panel).getAllByTestId('blf-tile');
    expect(tiles.map((t) => t.dataset.target)).toEqual(['1002', '1003']);
    expect(tiles[0]!.dataset.state).toBe('idle');
    expect(within(tiles[0]!).getByText('Alice Johnson')).toBeTruthy();
    expect(within(tiles[0]!).getByText('Available')).toBeTruthy();

    act(() => phone.simulatePresence('1002', 'ringing', { remoteNumber: '5550100', remoteDisplayName: 'Jane' }));
    const ringing = screen.getAllByTestId('blf-tile')[0]!;
    expect(ringing.dataset.state).toBe('ringing');
    expect(within(ringing).getByText('Ringing · Jane')).toBeTruthy();
    expect(within(ringing).getByTestId('presence-lamp').dataset.state).toBe('ringing');
    await user.click(within(ringing).getByRole('button', { name: /Pick up the call ringing at Alice Johnson/ }));
    await waitFor(() => expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('**1002'));
  });

  it('dials a tile and shows busy state in the contacts list', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone(PRESENCE);
    act(() => phone.simulatePresence('1002', 'busy'));
    await user.click(screen.getByRole('tab', { name: /Contacts/ }));
    expect(screen.getByText(/1002 · Busy/)).toBeTruthy();
    expect(screen.getByTestId('presence-lamp').dataset.state).toBe('busy');
    await user.click(screen.getByRole('tab', { name: 'Lamps' }));
    await user.click(screen.getByRole('button', { name: /^1003: Available\. Call 1003/ }));
    await waitFor(() => expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('1003'));
  });
});
