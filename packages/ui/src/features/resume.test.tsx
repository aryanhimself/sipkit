import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Softphone } from '@/softphone';
import { createPhone } from '@/test/utils';

/** Reload-safe softphone (V2-RESUME-01): "Reconnecting…" pill and "Reconnecting call…" banner. */
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('resume UI', () => {
  it('shows the reconnecting banner on a restored call until it is back', async () => {
    const store = memory();
    const first = createPhone({ resume: { enabled: true } }, { resumeStorage: store });
    await first.start();
    const call = first.simulateIncomingCall('5550100', 'Jane')!;
    await first.answer(call.id);

    // "Reload": a fresh instance restores the call from the store.
    const second = createPhone(
      { username: '', password: '', resume: { enabled: true } },
      { resumeStorage: store, registerDelayMs: 40, resumeDelayMs: 80 },
    );
    render(<Softphone softphone={second} toaster={false} locale="ne" />);
    await waitFor(() => expect(screen.getByTestId('registration-pill').dataset.resuming).toBe('true'));
    expect(screen.getByTestId('registration-pill').textContent).toContain('पुनः जोड्दै…');
    const banner = await screen.findByTestId('call-resuming');
    expect(banner.textContent).toContain('कल पुनः जोड्दै…');
    expect(screen.getByTestId('call-screen').dataset.resuming).toBe('true');
    await waitFor(() => expect(screen.queryByTestId('call-resuming')).toBeNull());
    expect(screen.getByTestId('registration-pill').dataset.state).toBe('registered');
    expect(screen.getByTestId('registration-pill').dataset.resuming).toBeUndefined();
  });
});
