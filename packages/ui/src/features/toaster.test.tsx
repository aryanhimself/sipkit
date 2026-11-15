import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SoftphoneProvider } from 'sipkit-react';
import { act } from 'react';
import { SoftphoneToaster } from './toaster';
import { createPhone } from '../test/utils';

describe('SoftphoneToaster', () => {
  it('shows notification events as toasts', async () => {
    const phone = createPhone();
    render(
      <SoftphoneProvider softphone={phone}>
        <SoftphoneToaster />
      </SoftphoneProvider>,
    );
    act(() => phone.simulateNotification('error', 'Network down', 'Reconnecting'));
    expect(await screen.findByText('Network down')).toBeTruthy();
    expect(screen.getByText('Reconnecting')).toBeTruthy();
  });

  it('respects showToasts=false', async () => {
    const phone = createPhone({ showToasts: false });
    render(
      <SoftphoneProvider softphone={phone}>
        <SoftphoneToaster />
      </SoftphoneProvider>,
    );
    act(() => phone.simulateNotification('info', 'Hidden toast'));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Hidden toast')).toBeNull();
  });
});
