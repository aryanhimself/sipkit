import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SoftphoneProvider } from './context';
import { useSoftphoneSnapshot } from './hooks/use-softphone-snapshot';
import { MockSoftphone } from './testing/mock-softphone';

function State() {
  const state = useSoftphoneSnapshot((s) => s.registration.state);
  return <span data-testid="state">{state}</span>;
}

describe('SoftphoneProvider', () => {
  it('starts an external instance but does not stop it on unmount', async () => {
    const phone = new MockSoftphone({ username: '1001' }, { registerDelayMs: 0 });
    const stop = vi.spyOn(phone, 'stop');
    const { unmount } = render(
      <SoftphoneProvider softphone={phone}>
        <State />
      </SoftphoneProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('registered'));
    unmount();
    expect(stop).not.toHaveBeenCalled();
  });

  it('creates via factory, shows fallback, and disposes on unmount', async () => {
    let created: MockSoftphone | undefined;
    const factory = vi.fn(async (config) => {
      created = new MockSoftphone(config, { registerDelayMs: 0 });
      return created;
    });
    const { unmount } = render(
      <SoftphoneProvider config={{ username: '2001' }} factory={factory} fallback={<p>loading</p>}>
        <State />
      </SoftphoneProvider>,
    );
    expect(screen.getByText('loading')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('registered'));
    expect(factory).toHaveBeenCalledWith({ username: '2001' });
    const destroy = vi.spyOn(created!, 'destroy');
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('applies config changes with updateConfig', async () => {
    let created: MockSoftphone | undefined;
    const factory = (config: object) => (created = new MockSoftphone(config, { registerDelayMs: 0 }));
    const { rerender } = render(
      <SoftphoneProvider config={{ username: '1' }} factory={factory}>
        <State />
      </SoftphoneProvider>,
    );
    await waitFor(() => expect(created).toBeDefined());
    const update = vi.spyOn(created!, 'updateConfig');
    rerender(
      <SoftphoneProvider config={{ username: '1' }} factory={factory}>
        <State />
      </SoftphoneProvider>,
    );
    expect(update).not.toHaveBeenCalled();
    rerender(
      <SoftphoneProvider config={{ username: '1', brandName: 'B' }} factory={factory}>
        <State />
      </SoftphoneProvider>,
    );
    await waitFor(() => expect(update).toHaveBeenCalledWith({ username: '1', brandName: 'B' }));
  });
});
