import './ui/ui.css';
import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { Game } from './sim/game.js';
import { createCanvas } from './render/canvas.js';
import { applyWorldTransform, drawArena, drawHud } from './render/draw.js';
import { drawEntity } from './render/draw-world.js';
import { createSprites } from './render/sprites.js';
import { createLoadingScreen } from './render/loading.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { Lobby } from './lobby.js';
import { mountLobbyView } from './ui/lobby-view.js';
import { mountRetryView } from './ui/retry-view.js';
import {
  describeError,
  fetchJson,
  isAbortError,
  loadAll,
  withRetry,
} from './assets/loader.js';
import {
  ABORT_AFTER_MS,
  SLOW_MS,
  applyChaos,
  parseChaos,
  withDelay,
} from './assets/chaos.js';

// ---------------------------------------------------------------------------
// URL switches. Normal play: no parameters  (loading -> lobby -> game).
//   Lab 01 experiments (skip loading and lobby; vector art, so the numbers stay comparable):
//     ?exp=block | ?exp=interval | ?exp=variable      the three "break it on purpose" runs
//     &autopilot=1                                    hold thrust, report the position after 5 s
//   Lab 02:
//     ?seed=123                                       the same asteroids and pickups every run
//   Lab 03:
//     ?load=sequential                                load assets one after another (timing demo)
//     ?latency=300                                    delay every asset request by 300 ms
//     ?chaos=404,json,timeout,abort,rooms             break the FIRST load on purpose (see chaos.js)
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const experiment = params.get('exp');
const autopilot = params.has('autopilot');
const seedParam = Number(params.get('seed'));
const chaos = parseChaos(params);
const sequential = params.get('load') === 'sequential';

const canvasApi = createCanvas(document.getElementById('game'));
const { ctx, view } = canvasApi;
const overlay = document.getElementById('overlay');

const input = autopilot
  ? { isDown: (code) => code === 'ArrowUp', justPressed: () => false, endStep: () => {} }
  : createInput(window);

const audio = createAudio();
const hud = createHud();
const loadingScreen = createLoadingScreen();

// ---- application state: what is on screen ---------------------------------------------------
// 'loading' -> 'lobby' -> 'playing' (Esc goes back to 'lobby'); 'failed' = Retry button.
let phase = experiment || autopilot ? 'playing' : 'loading';
let sprites = null;
let loadReport = { elapsedMs: 0, failed: [], concurrent: !sequential };
let game = null;
let room = null;
let callsign = '';
let simTime = 0;
let autopilotResult = '';
let detachGame = () => {};
let unmount = () => {};

// ---- game -----------------------------------------------------------------------------------
// The sim never calls Math.random(); the seed is chosen HERE, at the edge of the program.
function newGame() {
  if (autopilot) return new Game({ seed: 1, asteroids: 0, pickups: false });
  const seed = seedParam || Math.floor(Math.random() * 2 ** 32);
  return new Game({ seed, ...room?.arena });
}

function startGame() {
  detachGame();
  game = newGame();
  hud.reset();
  // The simulation publishes events; these two modules subscribe. It imports neither of them.
  const detachAudio = audio.attach(game.events);
  const detachHud = hud.attach(game.events);
  detachGame = () => {
    detachAudio();
    detachHud();
  };
}

if (phase === 'playing') startGame();

// ---- audio: a real AudioContext may only start after a user gesture --------------------------
function unlockAudio() {
  audio.unlock().then((running) => {
    if (running) {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    }
  });
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// ---- loading --------------------------------------------------------------------------------
let attempt = 0;
let loadController = null;

async function loadEverything(signal, useChaos) {
  const { assets: files } = await withRetry(
    () => fetchJson('assets/manifest.json', { signal, timeoutMs: 4000 }),
    { signal },
  );

  let manifest = Object.fromEntries(
    Object.entries(files).filter(
      ([, entry]) => audio.available || entry.type !== 'audio',
    ),
  );
  if (useChaos) manifest = applyChaos(manifest, chaos);

  // The timeout chaos waits SLOW_MS; shorten the per-request limit so the demo does not take
  // half a minute. Normal runs use the loader's defaults.
  const demoTimeout = useChaos && chaos.flags.has('timeout');
  const result = await loadAll(manifest, {
    ctx: audio.available ? audio.createDecoder() : undefined,
    signal,
    concurrent: !sequential,
    timeoutMs: demoTimeout ? 1200 : 4000,
    retry: {
      attempts: demoTimeout ? 2 : 3,
      onRetry: ({ attempt: n, error }) => {
        loadingScreen.state.note = `retrying (${describeError(error)}), attempt ${n + 1}…`;
      },
    },
    onProgress: (progress) => {
      loadingScreen.onProgress(progress);
      loadingScreen.state.note = '';
    },
  });
  return result;
}

async function boot() {
  unmount();
  phase = 'loading';
  loadingScreen.reset();
  attempt++;
  loadController = new AbortController();
  const { signal } = loadController;
  const useChaos = attempt === 1; // chaos breaks the first try only; Retry then succeeds

  if (useChaos && chaos.flags.has('abort')) {
    setTimeout(() => loadController.abort(), ABORT_AFTER_MS);
  }

  try {
    const result = await loadEverything(signal, useChaos);
    const { assets, failed } = result;
    loadReport = { elapsedMs: result.elapsedMs, failed, concurrent: !sequential };

    audio.setBuffers({
      shoot: assets.shoot,
      hit: assets.hit,
      explode: assets.explode,
      pickup: assets.pickup,
    });
    sprites =
      assets.sprites && assets.atlas
        ? createSprites({ sheet: assets.sprites, atlas: assets.atlas })
        : null;
    window.dogfightAssets = { ...loadReport, arena: assets.arena }; // for the DevTools console

    showLobby(assets.arena);
  } catch (error) {
    phase = 'failed';
    const what = isAbortError(error)
      ? 'Loading was cancelled'
      : 'Could not load the game';
    unmount = mountRetryView(overlay, {
      title: what,
      detail: `Reason: ${describeError(error)}${error.url ? ` (${error.url})` : ''}. Press Retry to try again.`,
      onRetry: boot,
    });
  }
}

// ---- lobby ----------------------------------------------------------------------------------
let lobby = null;
let firstRoomsRequest = true;

function showLobby(defaultArena) {
  phase = 'lobby';
  if (!lobby) {
    lobby = new Lobby({
      // chaos=rooms: only the first request is delayed past its timeout; polling then recovers.
      url: () => {
        const first = firstRoomsRequest;
        firstRoomsRequest = false;
        return first && chaos.flags.has('rooms')
          ? withDelay('api/rooms', SLOW_MS)
          : 'api/rooms';
      },
    });
    lobby.addEventListener('joined', ({ detail }) => {
      room = { ...detail.room, arena: { ...defaultArena, ...detail.room.arena } };
      callsign = detail.name;
      unmount();
      startGame();
      phase = 'playing';
    });
  }
  const failed = loadReport.failed.map(
    ({ id, error }) => `${id}: ${describeError(error)}`,
  );
  unmount = mountLobbyView(overlay, lobby, {
    notice: failed.length ? `Started with fallbacks — ${failed.join(', ')}` : '',
  });
  lobby.start();
}

function leaveGame() {
  detachGame();
  detachGame = () => {};
  game = null;
  showLobby();
}

// ---- keyboard shortcuts outside the simulation ------------------------------------------------
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyM' && !event.repeat && event.target?.tagName !== 'INPUT') {
    audio.toggleMute();
  }
  if (event.code === 'Escape' && phase === 'playing' && !experiment && !autopilot)
    leaveGame();
});

// ---- the loop (Lab 01) ------------------------------------------------------------------------
function simulate(dt) {
  if (phase === 'playing') {
    if (input.justPressed('KeyR')) startGame();

    game.step(dt, input);

    simTime += dt;
    if (autopilot && !autopilotResult && simTime >= 5 && game.ship) {
      const { x, y } = game.ship.pos;
      autopilotResult = `5 s thrust -> x=${x.toFixed(3)} y=${y.toFixed(3)}`;
      console.log(`[${experiment ?? 'fixed'}] ${autopilotResult}`);
    }
  }
  input.endStep();
}

let frameCounter = 0;

function render(alpha, stats) {
  frameCounter++;
  if (experiment === 'block' && frameCounter % 60 === 0) {
    const t = performance.now();
    while (performance.now() < t + 100) {
      // busy-wait: nothing else can run on the main thread meanwhile
    }
  }

  canvasApi.begin();
  ctx.save();
  applyWorldTransform(ctx, view);
  drawArena(ctx);
  if (phase === 'playing') {
    for (const entity of game.world) drawEntity(ctx, entity, alpha, sprites);
    hud.drawWorld(ctx);
  }
  ctx.restore();

  if (phase === 'loading') loadingScreen.draw(ctx, view);
  if (phase !== 'playing') return;

  hud.drawScreen(ctx, view, game.hud);

  const assetNote = loadReport.failed.length
    ? `fallbacks: ${loadReport.failed.map((f) => f.id).join(', ')}`
    : sprites
      ? 'sprites'
      : 'vector art';
  const extra = [
    `mode       ${experiment ?? 'normal (rAF + fixed step)'}`,
    `alpha      ${alpha.toFixed(2)}   dpr ${view.dpr}   entities ${game.world.size}`,
  ];
  if (room) extra.push(`room       ${room.name} · ${callsign}`);
  if (!experiment && !autopilot) {
    extra.push(
      `assets     ${assetNote} · ${loadReport.concurrent ? 'concurrent' : 'sequential'} ${loadReport.elapsedMs.toFixed(0)} ms`,
      `sound      ${audio.available ? audio.state : 'unavailable'}${audio.muted ? ' (muted)' : ''}`,
    );
  }
  extra.push(
    autopilotResult || 'arrows/WASD fly · SPACE fire · R restart · M mute · Esc lobby',
  );
  drawHud(ctx, stats, extra);
}

const loop = createLoop({
  step: 1 / 60,
  simulate,
  render,
  scheduler: experiment === 'interval' ? 'interval' : 'raf',
  fixedStep: experiment !== 'variable',
});

loop.start();
if (phase === 'loading') boot();

// Handy in the DevTools console: dogfight.game.world, dogfight.game.ship.hp, ...
if (import.meta.env?.DEV)
  globalThis.dogfight = {
    loop,
    audio,
    get game() {
      return game;
    },
    get phase() {
      return phase;
    },
  };
