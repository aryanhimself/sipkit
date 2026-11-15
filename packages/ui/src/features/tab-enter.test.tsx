import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

describe('keyboard', () => {
  it('Enter on a tab switches tabs and never places a call', async () => {
    const user = userEvent.setup();
    const phone = createPhone();
    render(<Softphone softphone={phone} toaster={false} />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered'));
    await user.type(screen.getByLabelText('Number to dial'), '1002');
    screen.getByRole('tab', { name: 'Settings' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true'));
    screen.getByRole('tab', { name: 'Phone' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Phone' }).getAttribute('aria-selected')).toBe('true'));
    await new Promise((r) => setTimeout(r, 50));
    expect(phone.getSnapshot().calls).toHaveLength(0);
  });
});
