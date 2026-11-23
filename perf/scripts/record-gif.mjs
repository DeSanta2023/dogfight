// Records a short GIF of the game with 8 bots in the room, for the README.
//   npm run build && node perf/scripts/record-gif.mjs   ->  docs/gameplay.gif   (needs ffmpeg)
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawnBots } from '../lib/bots.mjs';
import { startServer } from '../lib/server.mjs';

const out = fileURLToPath(new URL('../../docs/gameplay.gif', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'dogfight-gif-'));
const server = await startServer();
const bots = await spawnBots({ url: server.wsUrl, room: 'melee', count: 8 });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 800, height: 450 },
  recordVideo: { dir, size: { width: 800, height: 450 } },
});
const page = await context.newPage();
await page.goto(server.url);
await page.getByLabel('Callsign').fill('You');
await page
  .locator('li', { hasText: 'Melee' })
  .getByRole('button', { name: 'Join' })
  .click();
await page.locator('#room-panel').waitFor({ state: 'visible' });
await page.waitForTimeout(1500);
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 6; i++) {
  await page.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  await page.keyboard.down('Space');
  await page.waitForTimeout(900);
  await page.keyboard.up('Space');
  await page.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight');
}
await page.keyboard.up('ArrowUp');
const video = await page.video().path();
await context.close();
await browser.close();
bots.stop();
await server.stop();
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-i',
    video,
    '-ss',
    '1',
    '-vf',
    'fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop',
    '0',
    out,
  ],
  { stdio: 'ignore' },
);
await rm(dir, { recursive: true, force: true });
console.log('written', out);
