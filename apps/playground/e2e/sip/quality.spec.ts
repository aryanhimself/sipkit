import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { CallQuality } from 'sipkit-core';
import { closePhone, dial, expectCallState, openPhone, type Phone } from './helpers';

/** Latest quality sample of the active call (read from the core snapshot). */
async function activeQuality(phone: Phone): Promise<CallQuality | null> {
  return phone.page.evaluate(() => {
    const s = window.__softphone?.getSnapshot();
    return s?.calls.find((c) => c.id === s.activeCallId)?.quality ?? null;
  });
}

test.describe('call quality (real Asterisk)', () => {
  let a: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    a = undefined;
  });

  test('echo call (600) reports good quality with sane numbers', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    await dial(a, '600');
    await expectCallState(a, 'connected');

    const indicator = a.page.getByTestId('call-quality');
    await expect(indicator).toHaveAttribute('data-level', 'good');
    await expect(indicator).toHaveAccessibleName('Call quality: Good');

    // Wait for a sample that has an interval behind it (bitrate needs two samples).
    await expect
      .poll(async () => (await activeQuality(a!))?.inbound.bitrateKbps ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const q = (await activeQuality(a))!;
    expect(q.level).toBe('good');
    expect(q.mos).toBeGreaterThanOrEqual(4);
    expect(q.mos).toBeLessThanOrEqual(4.5);
    expect(q.codec).toMatch(/^(opus|pcmu|pcma|g722)$/);
    expect(q.inbound.packetLossPct ?? 0).toBeLessThan(2);
    expect(q.inbound.jitterMs ?? 0).toBeLessThan(50);
    expect(q.inbound.bitrateKbps).toBeLessThan(200);
    expect(q.outbound.bitrateKbps ?? 0).toBeGreaterThan(0);
    expect(q.totals.packetsReceived).toBeGreaterThan(50);
    expect(q.totals.packetsSent).toBeGreaterThan(50);
    if (q.rttMs !== undefined) expect(q.rttMs).toBeLessThan(200);

    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(a.page.getByTestId('call-screen')).toBeHidden();
    await expect(a.page.getByTestId('event-log')).toContainText(/cdr outgoing 600 \d+s \(local-hangup\) quality good/);
  });

  /**
   * Opt-in (E2E_NETEM=1 scripts/e2e-sip-docker.sh): adds packet loss with tc/netem on
   * the Playwright container's own interface (NET_ADMIN on that throwaway container
   * only; the shared Asterisk container is untouched). Egress loss shows up as
   * outbound loss through Asterisk's RTCP receiver reports.
   */
  test('indicator degrades under netem packet loss', async ({ browser }) => {
    test.skip(process.env.E2E_NETEM !== '1', 'set E2E_NETEM=1 (needs NET_ADMIN in the Playwright container)');
    const iface = process.env.E2E_NETEM_IFACE ?? 'eth0';
    a = await openPhone(browser, '1001');
    await dial(a, '600');
    await expectCallState(a, 'connected');
    const indicator = a.page.getByTestId('call-quality');
    await expect(indicator).toHaveAttribute('data-level', 'good');
    try {
      execSync(`tc qdisc replace dev ${iface} root netem loss 30%`);
      await expect(indicator).toHaveAttribute('data-level', 'poor', { timeout: 20_000 });
      const q = (await activeQuality(a))!;
      expect(Math.max(q.inbound.packetLossPct ?? 0, q.outbound.packetLossPct ?? 0)).toBeGreaterThan(10);
    } finally {
      execSync(`tc qdisc del dev ${iface} root || true`);
    }
    await expect(indicator).toHaveAttribute('data-level', 'good', { timeout: 20_000 });
  });
});
