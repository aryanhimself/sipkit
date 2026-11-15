import { expect, test, type Page } from '@playwright/test';

/** Width/height of a playing <video>, 0 until frames are decoded. */
const videoSize = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => {
    const v = el as HTMLVideoElement;
    return v.videoWidth * v.videoHeight * (v.paused ? 0 : 1);
  });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

test.describe('video calls (mock engine, synthetic canvas video)', () => {
  test('video call: remote + mirrored local preview, camera toggle, remote camera off/on', async ({ page }) => {
    await signIn(page);
    await page.getByLabel('Number to dial').fill('1002');
    await page.getByRole('button', { name: 'Video call', exact: true }).click();

    const region = page.getByTestId('call-video');
    await expect(region).toBeVisible();
    await expect(region).toHaveAccessibleName('Video');
    await expect(page.getByTestId('local-video')).toBeVisible();
    await expect.poll(() => videoSize(page, 'local-video')).toBeGreaterThan(0);
    // Local preview is mirrored (Tailwind v4 -scale-x-100 → CSS `scale` or `transform`).
    const mirror = await page.getByTestId('local-video').evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.scale} ${cs.transform}`;
    });
    expect(mirror).toMatch(/(^|\s|\()-1/);

    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await expect(region).toHaveAttribute('data-remote-video', 'on');
    await expect(page.getByTestId('remote-video')).toHaveAccessibleName('Video from 1002');
    await expect.poll(() => videoSize(page, 'remote-video')).toBeGreaterThan(0);

    const camera = page.getByRole('button', { name: 'Camera', exact: true });
    await expect(camera).toHaveAttribute('aria-pressed', 'true');
    await camera.click();
    await expect(camera).toHaveAttribute('aria-pressed', 'false');
    await expect(region).toHaveAttribute('data-camera', 'off');
    await expect(page.getByTestId('local-video')).toHaveCount(0);
    await camera.click();
    await expect(region).toHaveAttribute('data-camera', 'on');
    await expect.poll(() => videoSize(page, 'local-video')).toBeGreaterThan(0);

    await page.getByTestId('simulate-remote-camera-off').click();
    await expect(region).toHaveAttribute('data-remote-video', 'off');
    await expect(page.getByTestId('remote-video-placeholder')).toContainText('Camera off');
    await page.getByTestId('simulate-remote-camera-on').click();
    await expect(region).toHaveAttribute('data-remote-video', 'on');
    await expect(page.getByTestId('event-log')).toContainText('video on · camera on · remote on');

    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByTestId('call-screen')).toBeHidden();
  });

  test('incoming video call: answer with video or audio only', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('simulate-incoming-video').click();
    const card = page.getByTestId('incoming-call');
    await expect(card).toHaveAttribute('data-video', 'true');
    await expect(card).toContainText('Incoming video call');
    await card.getByRole('button', { name: 'Answer audio only' }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(page.getByTestId('call-video')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hang up' }).click();

    await page.getByTestId('simulate-incoming-video').click();
    await page.getByTestId('incoming-call').getByRole('button', { name: 'Answer with video' }).click();
    await expect(page.getByTestId('call-video')).toHaveAttribute('data-remote-video', 'on');
    await expect.poll(() => videoSize(page, 'remote-video')).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('audio call upgrades to video; conference turns video off', async ({ page }) => {
    await signIn(page);
    await page.getByLabel('Number to dial').fill('1002');
    await page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected', { timeout: 5000 });
    await expect(page.getByTestId('call-video')).toHaveCount(0);
    await page.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect(page.getByTestId('call-video')).toHaveAttribute('data-camera', 'on');

    await page.getByTestId('simulate-incoming').click();
    await page.getByTestId('incoming-call').getByRole('button', { name: 'Answer' }).click();
    await page.getByRole('button', { name: 'Merge' }).click();
    await expect(page.getByRole('region', { name: 'Conference', exact: true })).toBeVisible();
    // Conferences are audio-only: the video call's camera was switched off.
    await expect
      .poll(() => page.evaluate(() => window.__softphone?.getSnapshot().calls.find((c) => c.hasVideo)?.cameraOn))
      .toBe(false);
    await expect(page.getByTestId('call-video')).toHaveCount(0);
  });

  test('full-width layout keeps the video area responsive', async ({ page }) => {
    await signIn(page);
    await page.getByRole('radio', { name: 'Full width' }).click();
    await page.getByLabel('Number to dial').fill('1002');
    await page.getByRole('button', { name: 'Video call', exact: true }).click();
    const region = page.getByTestId('call-video');
    await expect(region).toBeVisible();
    const box = (await region.boundingBox())!;
    expect(box.width / box.height).toBeGreaterThan(1.5);
    const pip = (await page.getByTestId('local-video').boundingBox())!;
    expect(pip.width).toBeLessThan(box.width / 2);
  });
});
