import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cdr } from 'sipkit-core';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

function seedHistory(username: string, peers: string[]) {
  const items: Cdr[] = peers.map((peer, i) => ({
    callId: `seed-${i}`,
    line: 1,
    direction: 'outgoing',
    caller: username,
    called: peer,
    startedAt: 1_000 + i,
    endedAt: 1_000 + i,
    durationMs: 0,
    reason: 'local-hangup',
  }));
  localStorage.setItem(`sipkit:history:${username}`, JSON.stringify(items));
}

async function renderPhone(config = {}, contacts = [{ id: 'a', name: 'Anish', number: '9841429506' }]) {
  const phone = createPhone(config);
  render(<Softphone softphone={phone} toaster={false} contacts={contacts} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

afterEach(() => localStorage.clear());

describe('dialer autocomplete', () => {
  it('suggests numbers from history and contacts as an accessible combobox', async () => {
    seedHistory('1001', ['9842477272', '9842477272', '1002']);
    const user = userEvent.setup();
    await renderPhone();
    const input = screen.getByRole('combobox', { name: 'Number to dial' });
    expect(input.getAttribute('aria-expanded')).toBe('false');

    await user.type(input, '984');
    const list = screen.getByRole('listbox', { name: 'Suggestions' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = within(list).getAllByRole('option');
    // Called twice beats the contact that was never called.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('984 247 7272'),
      expect.stringContaining('Anish'),
    ]);
    expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('2 suggestions'))).toBe(true);

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect((input as HTMLInputElement).value).toBe('9841429506');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the list and keeps the typed number; Enter then calls', async () => {
    seedHistory('1001', ['1002']);
    const user = userEvent.setup();
    const phone = await renderPhone();
    const input = screen.getByRole('combobox', { name: 'Number to dial' });
    await user.type(input, '10');
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect((input as HTMLInputElement).value).toBe('10');
    await user.keyboard('{Enter}');
    await screen.findByTestId('call-screen');
    expect(phone.getSnapshot().calls[0]!.remoteNumber).toBe('10');
  });

  it('clicking a suggestion fills the field', async () => {
    seedHistory('1001', ['9842477272']);
    const user = userEvent.setup();
    await renderPhone();
    const input = screen.getByRole('combobox', { name: 'Number to dial' }) as HTMLInputElement;
    await user.type(input, '98424');
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('984 247 7272'))!);
    expect(input.value).toBe('9842477272');
    expect(document.activeElement).toBe(input);
  });

  it('offers the best match as a chip when dialling with the keypad', async () => {
    seedHistory('1001', ['9842477272']);
    const user = userEvent.setup();
    await renderPhone();
    for (const d of ['9', '8']) await user.click(screen.getByRole('button', { name: d }));
    await user.click(screen.getByRole('button', { name: 'Use 984 247 7272' }));
    expect((screen.getByLabelText('Number to dial') as HTMLInputElement).value).toBe('9842477272');
  });
});

describe('dial prefix', () => {
  it('is set in Settings, saved per account, and shown in the dialer', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const prefix = screen.getByLabelText('Dial prefix');
    await user.type(prefix, '9{Enter}');
    await waitFor(() => expect(phone.config.techPrefix).toBe('9'));
    expect(JSON.parse(localStorage.getItem('sipkit:dial-prefs:1001')!)).toEqual({ techPrefix: '9', techPrefixMinDigits: 0 });
    expect(screen.getByText(/9842477272 is dialled as 99842477272/)).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: 'Skip for internal extensions' }));
    await waitFor(() => expect(phone.config.techPrefixMinDigits).toBe(7));

    await user.click(screen.getByRole('tab', { name: 'Phone' }));
    const input = screen.getByLabelText('Number to dial');
    await user.type(input, '1002');
    expect(screen.queryByText(/Dials as/)).toBeNull(); // short extension: no prefix
    await user.clear(input);
    await user.type(input, '9842477272');
    expect(screen.getByText('Dials as 99842477272')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('rejects letters and restores the saved prefix on the next start', async () => {
    localStorage.setItem('sipkit:dial-prefs:1001', JSON.stringify({ techPrefix: '0', techPrefixMinDigits: 7 }));
    const user = userEvent.setup();
    const phone = await renderPhone();
    await waitFor(() => expect(phone.config.techPrefix).toBe('0'));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const prefix = screen.getByLabelText('Dial prefix');
    await user.type(prefix, 'x');
    expect(prefix.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Use only digits');
    await user.tab();
    expect(phone.config.techPrefix).toBe('0');
  });
});
