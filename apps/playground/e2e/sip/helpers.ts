import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const WSS_URL = process.env.E2E_SIP_WSS_URL ?? 'wss://localhost:8089/ws';
export const GATEWAY_WSS_URL = process.env.E2E_SIP_GATEWAY_WSS_URL ?? 'wss://localhost:8189/ws';
export const PASSWORD = process.env.E2E_SIP_PASSWORD ?? 'sipkitdev123';

export interface Phone {
  context: BrowserContext;
  page: Page;
  user: string;
}

/**
 * Wraps RTCPeerConnection so tests can read real RTP stats (bytes in/out) and
 * prove media actually flows, not just that signalling reached "connected".
 */
const PC_SPY = () => {
  const Native = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  class Spy extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
  }
  window.RTCPeerConnection = Spy as typeof RTCPeerConnection;
};

export interface OpenPhoneOptions {
  /** Reuse a context (e.g. one whose service worker / storage must survive a closed tab). */
  context?: BrowserContext;
  /** Runs before the first page loads (init scripts, permissions). */
  prepare?: (context: BrowserContext) => Promise<void>;
  /** Page to open instead of "/" (e.g. a push notification deep link). */
  path?: string;
  /** Fill extra connect-form fields (e.g. the voicemail API) before Connect. */
  beforeConnect?: (page: Page) => Promise<void>;
}

/** Open a fresh browser context, connect the playground to Asterisk and wait for registration. */
export async function openPhone(
  browser: Browser,
  user: string,
  wssUrl = WSS_URL,
  /** Options, or (legacy) a callback that fills extra connect-form fields before Connect. */
  opts: OpenPhoneOptions | ((page: Page) => Promise<void>) = {},
): Promise<Phone> {
  const options: OpenPhoneOptions = typeof opts === 'function' ? { beforeConnect: opts } : opts;
  const beforeConnect = options.beforeConnect;
  const context = options.context ?? (await browser.newContext());
  if (!options.context) await options.prepare?.(context);
  const page = await context.newPage();
  await page.addInitScript(PC_SPY);
  page.on('console', (m) => {
    if (process.env.E2E_DEBUG || m.type() === "error") console.log(`[${user} console.error] ${m.text()}`);
  });
  await page.goto(options.path ?? '/');
  await page.getByRole('radio', { name: 'Real Asterisk' }).click();
  await page.getByLabel('WebSocket URL').fill(wssUrl);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await beforeConnect?.(page);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
  return { context, page, user };
}

export async function closePhone(phone: Phone | undefined): Promise<void> {
  if (!phone) return;
  await phone.page
    .evaluate(async () => {
      const sp = window.__softphone;
      if (!sp) return;
      await sp.hangupAll().catch(() => undefined);
      await sp.unregister().catch(() => undefined);
    })
    .catch(() => undefined);
  await phone.context.close();
}

export async function dial(phone: Phone, number: string): Promise<void> {
  await phone.page.getByLabel('Number to dial').fill(number);
  await phone.page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(phone.page.getByTestId('call-screen')).toBeVisible();
}

export async function answerIncoming(phone: Phone): Promise<void> {
  const incoming = phone.page.getByTestId('incoming-call');
  await expect(incoming).toBeVisible();
  await incoming.getByRole('button', { name: 'Answer' }).click();
  await expectCallState(phone, 'connected');
}

export async function expectCallState(phone: Phone, state: string): Promise<void> {
  await expect(phone.page.getByTestId('call-screen')).toHaveAttribute('data-call-state', state);
}

/** Total RTP audio bytes received / sent across all peer connections on the page. */
export async function rtpBytes(phone: Phone): Promise<{ received: number; sent: number }> {
  return phone.page.evaluate(async () => {
    let received = 0;
    let sent = 0;
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? []) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s: { type: string; kind?: string; bytesReceived?: number; bytesSent?: number }) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') received += s.bytesReceived ?? 0;
        if (s.type === 'outbound-rtp' && s.kind === 'audio') sent += s.bytesSent ?? 0;
      });
    }
    return { received, sent };
  });
}

/** Assert audio is flowing in both directions: received bytes keep increasing. */
export async function expectMediaFlowing(phone: Phone): Promise<void> {
  const before = await rtpBytes(phone);
  await expect
    .poll(async () => (await rtpBytes(phone)).received - before.received, {
      message: `${phone.user} should receive RTP audio`,
      timeout: 10_000,
    })
    .toBeGreaterThan(1000);
  await expect
    .poll(async () => (await rtpBytes(phone)).sent - before.sent, {
      message: `${phone.user} should send RTP audio`,
      timeout: 10_000,
    })
    .toBeGreaterThan(1000);
}
