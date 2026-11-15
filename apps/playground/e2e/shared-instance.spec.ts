import { expect, test, type Page } from '@playwright/test';

/**
 * Shared instance without the browser extension (docs/shared-instance.md):
 * same-origin tabs elect a leader with Web Locks; the leader runs the mock
 * softphone, other tabs are remote clients over BroadcastChannel.
 */
const URL = '/?instance=shared';

async function signIn(page: Page) {
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

const created = (page: Page) => page.evaluate(() => window.__sipkitInstancesCreated ?? 0);

test.describe('shared instance (web leader tab, mock engine)', () => {
  test('two tabs share one instance and only the leader creates it', async ({ context }) => {
    const a = await context.newPage();
    await a.goto(URL);
    await expect(a.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    await signIn(a);

    const b = await context.newPage();
    await b.goto(URL);
    await expect(b.getByTestId('instance-role')).toHaveAttribute('data-role', 'client');
    await expect(b.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    expect(await created(a)).toBe(1);
    expect(await created(b)).toBe(0);

    // DND toggled in B is the leader's state.
    await b.getByTestId('dnd-toggle').click();
    await expect(a.getByTestId('dnd-toggle')).toHaveAttribute('data-state', 'on');
    await a.getByTestId('dnd-toggle').click();
    await expect(b.getByTestId('dnd-toggle')).toHaveAttribute('data-state', 'off');
  });

  test('answer in tab B while tab A leads', async ({ context }) => {
    const a = await context.newPage();
    await a.goto(URL);
    await expect(a.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    await signIn(a);
    const b = await context.newPage();
    await b.goto(URL);
    await expect(b.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');

    await a.getByTestId('simulate-incoming').click();
    const incomingB = b.getByTestId('incoming-call');
    await expect(incomingB).toContainText('Jane Customer');
    await expect(a.getByTestId('incoming-call')).toBeVisible();
    await incomingB.getByRole('button', { name: 'Answer' }).click();
    await expect(a.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    const callId = (p: Page) => p.evaluate(() => window.__softphone?.getSnapshot().calls[0]?.id);
    expect(await callId(b)).toBe(await callId(a));

    // Hang up from A ends it in B.
    await a.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.getByTestId('call-screen')).toBeHidden();
  });

  test('leader reloads during a call: B takes over, A reattaches as a client', async ({ context }) => {
    const a = await context.newPage();
    await a.goto(URL);
    await expect(a.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    await signIn(a);
    const b = await context.newPage();
    await b.goto(URL);
    await expect(b.getByTestId('instance-role')).toHaveAttribute('data-role', 'client');
    await expect(b.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');

    await a.getByTestId('simulate-incoming').click();
    await b.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');

    await a.reload();
    // The lock passes to B, which creates the (only) new instance with the handed-over credentials.
    await expect(b.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    expect(await created(b)).toBe(1);
    await expect(b.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    // A comes back as a client of B and mirrors B's state.
    await expect(a.getByTestId('instance-role')).toHaveAttribute('data-role', 'client');
    expect(await created(a)).toBe(0);
    await expect(a.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    // Without core reload continuity the mock call ended with the old leader; both tabs agree on that.
    const calls = (p: Page) => p.evaluate(() => window.__softphone?.getSnapshot().calls.length);
    expect(await calls(a)).toBe(await calls(b));

    // The new pair works: a call that rings now shows in both, answered from A.
    await b.getByTestId('simulate-incoming').click();
    await a.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
  });
  test('with resume on, the leader closing mid-call hands the same call to the next tab', async ({ context }) => {
    // "Survive reload" is a per-tab playground flag (sessionStorage): turn it on for every tab.
    await context.addInitScript(() => sessionStorage.setItem('pg:resume', 'true'));
    const a = await context.newPage();
    await a.goto(URL);
    await expect(a.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    await signIn(a);
    const b = await context.newPage();
    await b.goto(URL);
    await expect(b.getByTestId('instance-role')).toHaveAttribute('data-role', 'client');

    await a.getByTestId('simulate-incoming').click();
    await b.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    const snapshotCall = (p: Page) =>
      p.evaluate(() => {
        const c = window.__softphone?.getSnapshot().calls[0];
        return c ? { id: c.id, connectedAt: c.connectedAt, state: c.state } : null;
      });
    const before = (await snapshotCall(b))!;
    expect(before.state).toBe('connected');

    // The leader tab goes away for good; B takes over and rejoins the anchored call.
    await a.close();
    await expect(b.getByTestId('instance-role')).toHaveAttribute('data-role', 'leader');
    await expect(b.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(b.getByTestId('event-log')).toContainText(`call:resumed ${before.id}`);
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    const after = (await snapshotCall(b))!;
    expect(after.id).toBe(before.id);
    expect(after.connectedAt).toBe(before.connectedAt);
    expect(await b.evaluate(() => window.__softphone?.getSnapshot().calls.length)).toBe(1);

    // A real hangup ends it and clears the shared descriptor.
    await b.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.getByTestId('call-screen')).toBeHidden();
  });
});
