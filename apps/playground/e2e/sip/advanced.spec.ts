import { expect, test } from '@playwright/test';
import {
  GATEWAY_WSS_URL,
  answerIncoming,
  closePhone,
  dial,
  expectCallState,
  expectMediaFlowing,
  openPhone,
  rtpBytes,
  type Phone,
} from './helpers';

/** Live (not yet ended) calls as seen by the core API on that page. */
async function liveCalls(phone: Phone) {
  return phone.page.evaluate(() =>
    window.__softphone!.getSnapshot().calls.map((c) => ({ id: c.id, state: c.state, remote: c.remoteNumber, inConference: c.inConference })),
  );
}

test.describe('real Asterisk: advanced call features', () => {
  let a: Phone | undefined;
  let b: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    a = b = undefined;
  });

  test('early media: 183 audio plays before answer (602)', async ({ browser }) => {
    test.setTimeout(90_000);
    a = await openPhone(browser, '1001');
    await dial(a, '602');
    await expectCallState(a, 'early');
    // Media must flow while still unanswered.
    await expect.poll(async () => (await rtpBytes(a!)).received, { timeout: 10_000 }).toBeGreaterThan(1000);
    // The dialplan answers after the ~16 s tt-monkeys prompt.
    await expect(a.page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 30_000 });
  });

  test('attended transfer: 1001 consults the echo test, then joins 1002 to it', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);

    const consultState = await a.page.evaluate(async () => {
      const sp = window.__softphone!;
      const original = sp.getSnapshot().activeCallId!;
      const consult = await sp.startAttendedTransfer('600');
      (window as unknown as { __xfer: unknown }).__xfer = { original, consult: consult.id };
      return sp.getSnapshot().calls.find((c) => c.id === original)?.state;
    });
    expect(consultState).toBe('held');
    await expect.poll(async () => (await liveCalls(a!)).find((c) => c.remote === '600')?.state).toBe('connected');

    await a.page.evaluate(async () => {
      const { original, consult } = (window as unknown as { __xfer: { original: string; consult: string } }).__xfer;
      await window.__softphone!.completeAttendedTransfer(original, consult);
    });

    // Both of 1001's legs end; 1002 is now bridged to the echo app and hears itself.
    await expect.poll(async () => (await liveCalls(a!)).length).toBe(0);
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
  });

  test('3-way local conference: 1001 merges 1002 and the echo test', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);

    // Second line: the first is auto-held, then both are merged.
    await a.page.evaluate(() => window.__softphone!.call('600'));
    await expect.poll(async () => (await liveCalls(a!)).find((c) => c.remote === '600')?.state).toBe('connected');
    await a.page.evaluate(() => window.__softphone!.conference());

    await expect
      .poll(async () => (await liveCalls(a!)).map((c) => `${c.remote}:${c.state}:${c.inConference}`).sort())
      .toEqual(['1002:connected:true', '600:connected:true']);
    await expect(a.page.getByTestId('call-status')).toContainText('Conference');

    // Everyone still gets audio after the mix replaces 1001's outgoing tracks.
    await expectMediaFlowing(a);
    await expectMediaFlowing(b);

    await a.page.evaluate(() => window.__softphone!.hangupAll());
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
  });

  /** 1001 calls 1002 (answered) and the echo test, then merges them. */
  async function mergedConference(browser: Parameters<typeof openPhone>[0]) {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '1002');
    await answerIncoming(b);
    await a.page.evaluate(() => window.__softphone!.call('600'));
    await expect.poll(async () => (await liveCalls(a!)).find((c) => c.remote === '600')?.state).toBe('connected');
    await a.page.getByRole('button', { name: 'Merge' }).click();
    const panel = a.page.getByRole('region', { name: 'Conference', exact: true });
    await expect(panel.getByTestId('conference-party')).toHaveCount(2);
    await expect
      .poll(async () => (await liveCalls(a!)).map((c) => `${c.remote}:${c.state}:${c.inConference}`).sort())
      .toEqual(['1002:connected:true', '600:connected:true']);
    await expectMediaFlowing(b);
    return { a, b, panel };
  }

  /** Every live sender on the page still sends a live track (not a torn-down mixer output). */
  async function sendersLive(phone: Phone): Promise<boolean> {
    return phone.page.evaluate(() =>
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs
        .filter((pc) => pc.connectionState !== 'closed')
        .flatMap((pc) => pc.getSenders())
        .every((s) => !s.track || s.track.readyState === 'live'),
    );
  }

  test('conference: removing the echo party leaves 1001 and 1002 talking', async ({ browser }) => {
    const { a, b, panel } = await mergedConference(browser);
    // Remove the echo test (line 2) from the roster.
    await panel
      .locator('[data-testid="conference-party"][data-line="2"]')
      .getByRole('button', { name: /from conference$/ })
      .click();
    await expect
      .poll(async () => (await liveCalls(a)).map((c) => `${c.remote}:${c.state}:${c.inConference}`).sort())
      .toEqual(['1002:connected:false', '600:held:false']);
    await expect(panel).toBeHidden();
    expect(await sendersLive(a)).toBe(true);
    // 1001's own microphone is back on the 1002 leg: media flows both ways.
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
    await expectMediaFlowing(a);
  });

  test('conference: split gives each party its own line, one held', async ({ browser }) => {
    const { a, b, panel } = await mergedConference(browser);
    await panel.getByTestId('conference-split').click();
    await expect(panel).toBeHidden();
    // The active call (1002, the first party) stays connected; the echo test is held.
    await expect
      .poll(async () => (await liveCalls(a)).map((c) => `${c.remote}:${c.state}:${c.inConference}`).sort())
      .toEqual(['1002:connected:false', '600:held:false']);
    expect(await sendersLive(a)).toBe(true);
    await expectCallState(b, 'connected');
    await expectMediaFlowing(b);
    // Swap lines: resume the echo test (auto-holds 1002) and it echoes 1001's own mic again.
    await a.page.evaluate(async () => {
      const sp = window.__softphone!;
      const echo = sp.getSnapshot().calls.find((c) => c.remoteNumber === '600')!;
      await sp.hold(false, echo.id);
    });
    await expect
      .poll(async () => (await liveCalls(a)).map((c) => `${c.remote}:${c.state}`).sort())
      .toEqual(['1002:held', '600:connected']);
    await expectMediaFlowing(a);
  });

  test('incoming call to a busy line rings as a second call (call waiting)', async ({ browser }) => {
    a = await openPhone(browser, '1001');
    b = await openPhone(browser, '1002');
    await dial(a, '600');
    await expectCallState(a, 'connected');

    await dial(b, '1001');
    await expect(a.page.getByTestId('incoming-call')).toContainText('1002');
    await a.page.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    // Answering auto-holds the echo call.
    await expect
      .poll(async () => (await liveCalls(a!)).map((c) => `${c.remote}:${c.state}`).sort())
      .toEqual(['1002:connected', '600:held']);
    await expectMediaFlowing(b);
  });
});

test.describe('real Asterisk: sip-gateway mode', () => {
  let gw: Phone | undefined;
  let direct: Phone | undefined;

  test.afterEach(async () => {
    await closePhone(gw);
    await closePhone(direct);
    gw = direct = undefined;
  });

  test('gateway user calls a direct WebRTC user through the upstream SIP trunk', async ({ browser }) => {
    gw = await openPhone(browser, '1001', GATEWAY_WSS_URL);
    direct = await openPhone(browser, '1002');

    await dial(gw, '1002');
    await answerIncoming(direct);
    await expectCallState(gw, 'connected');
    await expectMediaFlowing(gw);
    await expectMediaFlowing(direct);

    await gw.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(direct.page.getByTestId('call-screen')).toBeHidden();
  });
});
