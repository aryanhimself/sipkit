import { expect, test, type Locator, type Page } from '@playwright/test';

/** Computed style of the widget root (`.sipkit-phone`), piercing the shadow DOM for the embed. */
async function rootStyle(page: Page, prop: string, embed = false): Promise<string> {
  return page.evaluate(
    ({ prop, embed }) => {
      const scope = embed ? document.querySelector('sipkit-phone')?.shadowRoot : document;
      const el = scope?.querySelector('.sipkit-phone');
      if (!el) throw new Error('widget root not found');
      const cs = getComputedStyle(el);
      return prop.startsWith('--') ? cs.getPropertyValue(prop).trim() : cs.getPropertyValue(prop);
    },
    { prop, embed },
  );
}

/** Background colour of an element, resolved to rgb(). */
async function bg(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Extension / username').fill('1001');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

const radio = (page: Page, group: string, name: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name });

test.describe('theming: React widget', () => {
  test('light/dark switch changes the computed background', async ({ page }) => {
    await login(page);
    const root = page.getByRole('region', { name: 'SipKit' });
    await expect(root).toHaveAttribute('data-theme', 'light');
    const light = await rootStyle(page, 'background-color');

    await radio(page, 'Theme', 'Dark').click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    const dark = await rootStyle(page, 'background-color');
    expect(dark).not.toBe(light);
  });

  test('system theme follows prefers-color-scheme live', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await login(page);
    const root = page.getByRole('region', { name: 'SipKit' });
    await radio(page, 'Theme', 'System').click();
    await expect(root).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(root).toHaveAttribute('data-theme', 'dark');
  });

  test('custom brand tokens restyle the widget at runtime', async ({ page }) => {
    await login(page);
    const callButton = page.getByRole('button', { name: 'Call', exact: true });
    const before = await bg(callButton);

    await radio(page, 'Brand', 'Custom brand').click();
    await expect.poll(() => bg(callButton)).toBe('rgb(21, 128, 61)'); // callAccept #15803d
    expect(before).not.toBe('rgb(21, 128, 61)');
    expect(await rootStyle(page, '--radius')).toBe('0.375rem');

    await radio(page, 'Theme', 'Dark').click();
    await expect.poll(() => rootStyle(page, 'background-color')).toBe('rgb(11, 20, 22)'); // dark.background #0b1416
  });
});

test.describe('theming: <sipkit-phone> embed', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/embed-demo.html');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!document
              .querySelector('sipkit-phone')
              ?.shadowRoot?.querySelector('[data-state="registered"]'),
        ),
      )
      .toBe(true);
  });

  test('theme attribute switches dark mode inside the shadow DOM', async ({ page }) => {
    const light = await rootStyle(page, 'background-color', true);
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect.poll(() => rootStyle(page, 'background-color', true)).not.toBe(light);
    expect(
      await page.evaluate(() =>
        document
          .querySelector('sipkit-phone')!
          .shadowRoot!.querySelector('.sipkit-phone')!
          .getAttribute('data-theme'),
      ),
    ).toBe('dark');
  });

  test('host CSS variables pierce the shadow DOM (--sipkit-* and --sipkit-dark-*)', async ({ page }) => {
    // embed-demo.html sets `sipkit-phone { --sipkit-primary: #0f766e; --sipkit-dark-primary: #2dd4bf }`.
    expect(await rootStyle(page, '--primary', true)).toBe('#0f766e');
    await page.addStyleTag({ content: 'sipkit-phone { --sipkit-background: rgb(1, 2, 3); }' });
    await expect.poll(() => rootStyle(page, 'background-color', true)).toBe('rgb(1, 2, 3)');

    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect.poll(() => rootStyle(page, '--primary', true)).toBe('#2dd4bf');
  });

  test('theme-tokens attribute overrides host CSS at runtime', async ({ page }) => {
    await page.getByRole('button', { name: 'Custom tokens' }).click();
    await expect.poll(() => rootStyle(page, '--primary', true)).toBe('#7c3aed');
    expect(await rootStyle(page, '--radius', true)).toBe('0.25rem');
  });
});
