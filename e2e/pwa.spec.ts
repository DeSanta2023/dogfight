// Lab 08: the game is a PWA (installable: manifest + icons + service worker) and playable by touch.
import { expect, test } from '@playwright/test';

test('the manifest is installable: name, start_url, standalone, 192 and 512 icons that really exist', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const res = await request.get(href!);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const manifest = (await res.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifest.name).toBeTruthy();
  expect(manifest.start_url).toBe('/');
  expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
  for (const size of ['192x192', '512x512'])
    expect(manifest.icons.some((i) => i.sizes === size && i.type === 'image/png')).toBe(
      true,
    );
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type']).toContain(icon.type);
  }
  // the service worker is never served from the HTTP cache: a new version must be noticed
  const sw = await request.get('/sw.js');
  expect(sw.headers()['content-type']).toContain('javascript');
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('the service worker installs, and the page still opens with the network off', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('no active service worker');
  });
  // make sure the worker controls this page (it claims clients on activate)
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.reload(); // caches the page with the worker in charge
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('canvas#game')).toBeAttached();
  await expect(page).toHaveTitle('Dogfight');
  await context.setOffline(false);
});

test('touch buttons fly the ship (they press the same keys as the keyboard)', async ({
  page,
}) => {
  await page.goto('/?debug=1&touch=1&nosw=1');
  await page.getByLabel('Callsign').fill('Thumb');
  await page
    .locator('li', { hasText: 'Melee' })
    .getByRole('button', { name: 'Join' })
    .click();
  await expect(page.locator('#room-panel')).toBeVisible();
  const where = () =>
    page.evaluate(() => {
      const own = window.dogfight.net?.latest?.snap.own;
      return own?.alive ? { x: own.x, y: own.y } : null;
    });
  await expect.poll(where).not.toBeNull();
  const before = (await where())!;

  const thrust = page.getByRole('button', { name: 'Thrust' });
  await expect(thrust).toBeVisible();
  const box = (await thrust.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const now = await where();
      return now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
    })
    .toBeGreaterThan(20);
});
