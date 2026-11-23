// Lab 08, chaos in a real browser: the server is killed (SIGKILL: no goodbye, no close frame) in the
// middle of a match. The player must find themselves in the lobby again, with a notice, without
// pressing anything.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4181;

test('server killed mid-match: the player is back in the lobby by themselves', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const logDir = await mkdtemp(join(tmpdir(), 'dogfight-chaos-'));
  const server = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), LOG_DIR: logDir, LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });
  try {
    await expect
      .poll(
        async () =>
          fetch(`http://127.0.0.1:${PORT}/ready`)
            .then((r) => r.status)
            .catch(() => 0),
        {
          timeout: 15_000,
        },
      )
      .toBe(200);

    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByLabel('Callsign').fill('Survivor');
    await page
      .locator('li', { hasText: 'Melee' })
      .getByRole('button', { name: 'Join' })
      .click();
    await expect(page.locator('#room-panel')).toBeVisible();

    server.kill('SIGKILL'); // the machine died: nobody says goodbye

    // 10 s of reconnecting, then the lobby again (and the notice says why).
    await expect(page.getByLabel('Callsign')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.notice')).toContainText('Lost connection');
  } finally {
    server.kill('SIGKILL');
  }
});
