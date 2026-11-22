// Lab 07, part 4: record the browser while 8 bots play in the same room.
//
//   npm run build            (the server serves client/dist)
//   node perf/scripts/profile-client.mjs --label before [--seconds 30] [--bots 8] [--query ""]
//
// Measured in the page (what a player feels):  frame time p50/p95/p99/max   (requestAnimationFrame
//   deltas), long tasks, dropped frames.
// Measured by Chrome (what V8 does):           GC pauses (trace events), who allocates most
//   (the sampling HEAP profiler, garbage included), CPU profile -> flame chart.
// Output: docs/perf/client-<label>.json, flame-<label>.svg and flame-<label>.png.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawnBots } from '../lib/bots.mjs';
import { flameSvg, topSelf } from '../lib/flame.mjs';
import { startServer } from '../lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1] ?? true]);
    return acc;
  }, []),
);
const label = args.label ?? 'run';
const seconds = Number(args.seconds ?? 30);
const botCount = Number(args.bots ?? 8);
const query = String(args.query ?? '');
const throttle = Number(args.throttle ?? 1); // DevTools "CPU: 4x slowdown": makes small costs visible
const outDir = fileURLToPath(new URL('../../docs/perf/', import.meta.url));
await mkdir(outDir, { recursive: true });

const percentile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// A build with readable function names (npm run build:profile) if it exists, else the normal one.
const profileBuild = fileURLToPath(new URL('../../client/dist-profile', import.meta.url));
const { existsSync } = await import('node:fs');
const server = await startServer(
  existsSync(profileBuild) ? { STATIC_DIR: profileBuild } : {},
);
const bots = await spawnBots({ url: server.wsUrl, room: 'melee', count: botCount });
console.log(`${bots.joined} bots in the room "melee"`);

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Runs before the game's own code: a frame sampler that costs one array push per frame.
await page.addInitScript(() => {
  const frames = [];
  const longTasks = [];
  Object.assign(window, { __frames: frames, __longTasks: longTasks, __sampling: false });
  let last = performance.now();
  const tick = (now) => {
    if (window.__sampling) frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      if (window.__sampling)
        for (const e of list.getEntries()) longTasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* long tasks are not available everywhere */
  }
});

await page.goto(`${server.url}/${query ? `?${query}` : ''}`);
await page.getByLabel('Callsign').fill('Profiler');
await page
  .locator('li', { hasText: 'Melee' })
  .getByRole('button', { name: 'Join' })
  .click();
await page.locator('#room-panel').waitFor({ state: 'visible' });
await page.waitForTimeout(3000); // warm-up: the JIT has compiled the hot code, assets are loaded
await page.screenshot({ path: `${outDir}client-${label}-game.png` });

const cdp = await page.context().newCDPSession(page);
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); // microseconds
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', {
  samplingInterval: 2048,
  includeObjectsCollectedByMajorGC: true, // garbage is exactly what we are looking for
  includeObjectsCollectedByMinorGC: true,
});
await browser.startTracing(page, {
  categories: ['v8', 'v8.gc', 'devtools.timeline', 'disabled-by-default-v8.gc'],
});
await cdp.send('Profiler.start');
await page.evaluate(() => {
  window.__frames.length = 0;
  window.__longTasks.length = 0;
  window.__sampling = true;
});

await page.waitForTimeout(seconds * 1000);

const { frames, longTasks } = await page.evaluate(() => {
  window.__sampling = false;
  return { frames: window.__frames, longTasks: window.__longTasks };
});
const { profile } = await cdp.send('Profiler.stop');
const { profile: heap } = await cdp.send('HeapProfiler.stopSampling');
const trace = JSON.parse((await browser.stopTracing()).toString());
const botState = { ...bots.state, stillJoined: bots.joined };

// ---- frame time -------------------------------------------------------------------------------
const sorted = [...frames].sort((a, b) => a - b);
const frameStats = {
  frames: frames.length,
  fps: round(frames.length / seconds, 1),
  p50: round(percentile(sorted, 0.5)),
  p95: round(percentile(sorted, 0.95)),
  p99: round(percentile(sorted, 0.99)),
  max: round(sorted.at(-1) ?? 0),
  over16_7: frames.filter((f) => f > 16.7 * 1.05).length,
  over33: frames.filter((f) => f > 33.4).length,
  longTasks: longTasks.length,
  longTaskMaxMs: round(Math.max(0, ...longTasks)),
};

// ---- GC pauses --------------------------------------------------------------------------------
// Trace events: V8.GCScavenger = a minor GC (young generation), V8.GCCompactor / MajorGC = a
// major one. 'dur' is in microseconds and is the time JavaScript was stopped (or, for the
// concurrent phases, the time of that phase) - we count the events that stop the main thread.
const gcEvents = trace.traceEvents.filter(
  (e) =>
    e.ph === 'X' &&
    typeof e.dur === 'number' &&
    /^(V8\.GCScavenger|V8\.GCCompactor|V8\.GCFinalizeMC|MinorGC|MajorGC)$/.test(e.name),
);
const pauses = (re) => gcEvents.filter((e) => re.test(e.name)).map((e) => e.dur / 1000);
const summarize = (list) => ({
  count: list.length,
  totalMs: round(list.reduce((a, b) => a + b, 0)),
  maxMs: round(Math.max(0, ...list)),
});
const gc = {
  minor: summarize(pauses(/^(V8\.GCScavenger|MinorGC)$/)),
  major: summarize(pauses(/^(V8\.GCCompactor|V8\.GCFinalizeMC|MajorGC)$/)),
  eventNamesSeen: [
    ...new Set(trace.traceEvents.filter((e) => /GC/.test(e.name)).map((e) => e.name)),
  ].slice(0, 12),
};

// ---- who allocates ----------------------------------------------------------------------------
const alloc = new Map();
let allocTotal = 0;
const walk = (node) => {
  const self = node.selfSize ?? 0;
  if (self > 0) {
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    alloc.set(key, (alloc.get(key) ?? 0) + self);
    allocTotal += self;
  }
  for (const c of node.children ?? []) walk(c);
};
walk(heap.head);
const allocators = [...alloc]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([fn, bytes]) => ({
    fn,
    kb: Math.round(bytes / 1024),
    pct: round((bytes / allocTotal) * 100, 1),
  }));

// ---- main-thread CPU: where the time of the 30 s went --------------------------------------------
const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
const cpuMs = { idle: 0, gc: 0, native: 0, js: 0 };
profile.samples.forEach((id, i) => {
  const name = nodeById.get(id)?.callFrame.functionName;
  const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
  if (name === '(idle)') cpuMs.idle += dt;
  else if (name === '(garbage collector)') cpuMs.gc += dt;
  else if (name === '(program)' || name === '(root)') cpuMs.native += dt;
  else cpuMs.js += dt;
});
const cpu = Object.fromEntries(
  Object.entries(cpuMs).map(([k, v]) => [k + 'Ms', Math.round(v)]),
);
cpu.busyPct = round(
  ((cpuMs.gc + cpuMs.native + cpuMs.js) /
    (cpuMs.idle + cpuMs.gc + cpuMs.native + cpuMs.js)) *
    100,
  1,
);

// ---- flame chart ------------------------------------------------------------------------------
const svg = flameSvg(profile, {
  title: `Browser CPU flame chart: ${label}${throttle > 1 ? ` (CPU ${throttle}x slower)` : ''} (${seconds} s, ${botCount} bots + 1 player)`,
});
await writeFile(`${outDir}flame-${label}.svg`, svg);
const shot = await browser.newPage({ deviceScaleFactor: 1 });
const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
await shot.setViewportSize({ width: Number(w), height: Number(h) });
await shot.setContent(`<body style="margin:0">${svg}</body>`);
await shot.screenshot({ path: `${outDir}flame-${label}.png` });

const result = {
  label,
  seconds,
  bots: botCount,
  query,
  environment: {
    cpus: (await import('node:os')).cpus().length,
    node: process.version,
    browser: browser.version(),
  },
  throttle,
  frame: frameStats,
  cpu,
  gc,
  allocatedSampledKb: Math.round(allocTotal / 1024),
  topAllocators: allocators,
  topCpu: topSelf(profile),
  botState,
};
await writeFile(`${outDir}client-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await browser.close();
bots.stop();
await server.stop();
