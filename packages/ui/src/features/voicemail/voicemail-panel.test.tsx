import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SoftphoneConfigInput } from 'sipkit-core';
import type { MockSoftphoneOptions } from 'sipkit-react/testing';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

const VM: SoftphoneConfigInput = {
  voicemail: { enabled: true, number: '*97', api: { baseUrl: 'https://pbx.example.com/vm', token: 'dev' } },
};
const SEED: MockSoftphoneOptions['voicemailMessages'] = [
  { callerNumber: '1002', callerName: 'Ann Lee', duration: 12 },
  { callerNumber: '5550100', duration: 4, folder: 'old' },
];

beforeAll(() => {
  // happy-dom has no object URLs.
  let n = 0;
  Object.assign(URL, { createObjectURL: () => `blob:vm-${n++}`, revokeObjectURL: () => undefined });
});

async function renderPhone(config: SoftphoneConfigInput = VM, options: MockSoftphoneOptions = { voicemailMessages: SEED }) {
  const phone = createPhone(config, options);
  render(<Softphone softphone={phone} toaster={false} />);
  await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
  return phone;
}

async function openTab() {
  await userEvent.setup().click(screen.getByRole('tab', { name: /voicemail/i }));
  await waitFor(() => expect(screen.getAllByTestId('voicemail-item')).toHaveLength(2));
}

describe('VoicemailPanel', () => {
  it('has no tab without voicemail.api, or with the voicemail feature off', async () => {
    await renderPhone({ voicemail: { enabled: true } });
    expect(screen.queryByRole('tab', { name: /voicemail/i })).toBeNull();
  });

  it('hides the tab with disabledFeatures', async () => {
    await renderPhone({ ...VM, disabledFeatures: ['voicemail'] });
    expect(screen.queryByRole('tab', { name: /voicemail/i })).toBeNull();
  });

  it('lists messages newest first with a new badge on the tab', async () => {
    await renderPhone();
    await waitFor(() => expect(screen.getByTestId('voicemail-tab-badge').dataset.count).toBe('1'));
    await openTab();
    const items = screen.getAllByTestId('voicemail-item');
    expect(items.map((i) => i.dataset.folder)).toEqual(['old', 'new']); // seeded: Ann first, so older
    const ann = items.find((i) => within(i).getByTestId('voicemail-caller').textContent === 'Ann Lee')!;
    expect(ann.dataset.folder).toBe('new');
    expect(ann.textContent).toMatch(/0:12/);
    expect(screen.getByTestId('voicemail-counts').dataset.new).toBe('1');
  });

  it('plays, marks heard (MWI drops), calls back and deletes after confirming', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    await openTab();
    const badge = screen.getByTestId('voicemail-badge');
    await waitFor(() => expect(badge.dataset.count).toBe('1'));
    const ann = () => screen.getAllByTestId('voicemail-item').find((i) => i.textContent?.includes('Ann Lee'))!;

    await user.click(within(ann()).getByRole('button', { name: 'Play voicemail from Ann Lee' }));
    await waitFor(() => expect(within(ann()).getByTestId('voicemail-audio').getAttribute('src')).toMatch(/^blob:/));

    await user.click(within(ann()).getByRole('button', { name: 'Mark voicemail from Ann Lee as heard' }));
    await waitFor(() => expect(ann().dataset.folder).toBe('old'));
    await waitFor(() => expect(badge.dataset.count).toBe('0'));
    expect(screen.queryByTestId('voicemail-tab-badge')).toBeNull();

    await user.click(within(ann()).getByRole('button', { name: 'Delete voicemail from Ann Lee' }));
    const confirm = screen.getByTestId('voicemail-confirm');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByTestId('voicemail-item')).toHaveLength(2);
    await user.click(within(ann()).getByRole('button', { name: 'Delete voicemail from Ann Lee' }));
    await user.click(screen.getByTestId('voicemail-confirm-delete'));
    await waitFor(() => expect(screen.getAllByTestId('voicemail-item')).toHaveLength(1));
    expect(phone.voicemailBackend.messages()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^Call .* back$/ }));
    await waitFor(() => expect(phone.getSnapshot().calls[0]?.remoteNumber).toBe('5550100'));
  });

  it('shows a new message left while open, and errors with retry', async () => {
    const user = userEvent.setup();
    const phone = await renderPhone();
    await openTab();
    await new Promise((r) => setTimeout(r, 150));
    act(() => void phone.simulateVoicemailMessage({ callerNumber: '1003', callerName: 'Cy' }));
    await waitFor(() => expect(screen.getAllByTestId('voicemail-item')).toHaveLength(3));

    phone.voicemailBackend.failNext(401, 2);
    await user.click(screen.getByTestId('voicemail-refresh'));
    await waitFor(() => expect(screen.getByTestId('voicemail-error').textContent).toMatch(/denied/));
    expect(screen.getAllByTestId('voicemail-item')).toHaveLength(3); // stale list kept
    await user.click(within(screen.getByTestId('voicemail-error')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByTestId('voicemail-error')).toBeNull());
  });

  it('shows an empty state', async () => {
    await renderPhone(VM, {});
    await userEvent.setup().click(screen.getByRole('tab', { name: /voicemail/i }));
    await waitFor(() => expect(screen.getByText('No voicemail')).toBeTruthy());
  });
});
