import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call, CallQuality } from 'sipkit-core';
import { SoftphoneProvider } from 'sipkit-react';
import { Softphone } from '../softphone';
import { createPhone } from '../test/utils';
import { CallQualityDetails, CallQualityIndicator } from './call-quality';

afterEach(() => {
  vi.useRealTimers();
});

const quality = (level: CallQuality['level'], mos: number): CallQuality => ({
  at: 0,
  level,
  mos,
  rttMs: 42,
  codec: 'opus',
  inbound: { packetLossPct: 1.5, jitterMs: 7, bitrateKbps: 40 },
  outbound: { packetLossPct: 0, jitterMs: 7 },
  totals: { packetsSent: 0, packetsReceived: 0, packetsLost: 0 },
});

function renderIndicator(q: CallQuality | undefined, state: Call['state'] = 'connected') {
  const phone = createPhone();
  const call: Call = {
    id: 'c1',
    line: 1,
    direction: 'outgoing',
    state,
    remoteNumber: '1002',
    muted: false,
    hold: 'none',
    createdAt: 0,
    inConference: false,
    meta: {},
    quality: q,
  };
  vi.spyOn(phone, 'getSnapshot').mockReturnValue({ ...phone.getSnapshot(), calls: [call], activeCallId: 'c1' });
  return render(
    <SoftphoneProvider softphone={phone}>
      <CallQualityIndicator call={call} />
    </SoftphoneProvider>,
  );
}

describe('<CallQualityIndicator />', () => {
  it('says "No audio" when no packets flow', () => {
    renderIndicator({ ...quality('poor', 1), noAudio: 'both' });
    const el = screen.getByTestId('call-quality');
    expect(el.textContent).toBe('No audio');
    expect(el.getAttribute('aria-label')).toBe('Call quality: No audio');
    expect(el.dataset.noAudio).toBe('both');
  });

  it.each([
    ['good', 4.4, 3],
    ['fair', 3.8, 2],
    ['poor', 2.1, 1],
  ] as const)('renders %s with an accessible label and %i bars', (level, mos, bars) => {
    renderIndicator(quality(level, mos));
    const el = screen.getByTestId('call-quality');
    expect(el.dataset.level).toBe(level);
    expect(el.getAttribute('aria-label')).toBe(`Call quality: ${level[0]!.toUpperCase()}${level.slice(1)}`);
    const filled = [...el.querySelectorAll('rect')].filter((r) => r.getAttribute('opacity') === '1');
    expect(filled).toHaveLength(bars);
  });

  it('renders nothing without a sample or when not connected', () => {
    const { unmount } = renderIndicator(undefined);
    expect(screen.queryByTestId('call-quality')).toBeNull();
    unmount();
    renderIndicator(quality('good', 4.4), 'held');
    expect(screen.queryByTestId('call-quality')).toBeNull();
  });

  it('shows the numbers in the tooltip on focus', async () => {
    renderIndicator(quality('fair', 3.8));
    act(() => screen.getByTestId('call-quality').focus());
    const details = await screen.findAllByTestId('call-quality-details');
    expect(details[0]?.textContent).toContain('3.8');
    expect(details[0]?.textContent).toContain('42 ms');
    expect(details[0]?.textContent).toContain('OPUS');
  });

  it('formats missing values as a dash', () => {
    render(
      <CallQualityDetails
        quality={{ ...quality('good', 4.4), rttMs: undefined, codec: undefined, inbound: {}, outbound: {} }}
      />,
    );
    const dl = screen.getByTestId('call-quality-details');
    expect(within(dl).getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(dl.textContent).not.toContain('Codec');
  });
});

describe('call screen integration', () => {
  it('degrades from good to poor when the mock network gets worse', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const phone = createPhone();
    render(<Softphone softphone={phone} toaster={false} />);
    await act(() => vi.advanceTimersByTimeAsync(50));
    await act(async () => {
      await phone.call('1002');
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByTestId('call-screen').dataset.callState).toBe('connected');
    expect(screen.queryByTestId('call-quality')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByTestId('call-quality').dataset.level).toBe('good');
    phone.simulateNetwork('poor');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByTestId('call-quality').dataset.level).toBe('poor');
  });
});
