// Lab 07: two REAL browsers (two isolated contexts = two separate players) in ONE room.
//   1. the second one sees the first one's ship move,
//   2. a chat message of the first one arrives at the second one.
import { expect, test, type Browser, type Page } from '@playwright/test';

/** What a page knows about the game, through the `?debug=1` hook (window.dogfight). */
interface DogfightHook {
  session: { slot: number } | null;
  net: {
    latest: { snap: { ships: { slot: number; x: number; y: number }[] } } | null;
  } | null;
}
declare global {
  interface Window {
    dogfight: DogfightHook;
  }
}

async function join(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext(); // own cookies, storage and socket: a different person
  const page = await context.newPage();
  await page.goto('/?debug=1');
  await page.getByLabel('Callsign').fill(name);
  await page
    .locator('li', { hasText: 'Melee' })
    .getByRole('button', { name: 'Join' })
    .click();
  await expect(page.locator('#room-panel')).toBeVisible();
  await expect(page.locator('.roster')).toContainText(name);
  return page;
}

const slotOf = (page: Page) => page.evaluate(() => window.dogfight.session?.slot ?? -1);
const positionOf = (page: Page, slot: number) =>
  page.evaluate((s) => {
    const ship = window.dogfight.net?.latest?.snap.ships.find((x) => x.slot === s);
    return ship ? { x: ship.x, y: ship.y } : null;
  }, slot);

test('the second browser sees the first one move, and receives its chat', async ({
  browser,
}) => {
  const alice = await join(browser, 'Alice');
  const bob = await join(browser, 'Bob');
  await expect(alice.locator('.roster')).toContainText('Bob');

  const aliceSlot = await slotOf(alice);
  expect(aliceSlot).toBeGreaterThanOrEqual(0);

  // Bob has Alice's ship in his snapshots. Where is it now?
  await expect.poll(() => positionOf(bob, aliceSlot)).not.toBeNull();
  const before = (await positionOf(bob, aliceSlot))!;

  // Alice holds the thrust key for 1.5 s: a person pressing ArrowUp.
  await alice.bringToFront();
  await alice.keyboard.down('ArrowUp');
  await alice.waitForTimeout(1500);
  await alice.keyboard.up('ArrowUp');

  // ...and Bob's copy of her ship has moved (on the server, so it is real, not just her prediction).
  await expect
    .poll(async () => {
      const now = await positionOf(bob, aliceSlot);
      return now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
    })
    .toBeGreaterThan(20);

  // Chat: Enter focuses the box, Enter sends.
  await alice.keyboard.press('Enter');
  await alice.getByLabel('Chat message').fill('hello from Alice');
  await alice.keyboard.press('Enter');
  await expect(bob.locator('.chat-log')).toContainText('hello from Alice');
  await expect(alice.locator('.chat-log')).toContainText('hello from Alice');
});
