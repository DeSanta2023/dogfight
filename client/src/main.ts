import './ui/ui.css';
import { createLoop, type LoopStats } from './loop.ts';
import { createInput, type InputSource } from './input.ts';
import { z } from 'zod';
import { Game } from '@dogfight/shared/game.ts';
import { isKind } from '@dogfight/shared/kinds.ts';
import type { RoomInfo } from '@dogfight/shared/protocol.ts';
import type { World } from '@dogfight/shared/world.ts';
import { createCanvas } from './render/canvas.ts';
import { applyWorldTransform, drawArena, drawHud } from './render/draw.ts';
import { drawEntity } from './render/draw-world.ts';
import { createSprites, type Sprites } from './render/sprites.ts';
import type { Drawable } from './render/drawable.ts';
import { createLoadingScreen } from './render/loading.ts';
import { createAudio } from './audio.ts';
import { createHud } from './hud.ts';
import { drawNetgraph } from './render/netgraph.ts';
import { NetGame } from './net/netgame.ts';
import { Conditioner } from './net/conditioner.ts';
import { bitsFromInput } from '@dogfight/shared/input.ts';
import { physicsHooks } from '@dogfight/shared/ship.ts';
import { Lobby } from './lobby.ts';
import { mountTouchControls } from './ui/touch-controls.ts';
import { mountLobbyView } from './ui/lobby-view.ts';
import { mountRetryView } from './ui/retry-view.ts';
import { mountRoomView } from './ui/room-view.ts';
import { RoomSession } from './net/session.ts';
import {
  describeError,
  fetchJson,
  type Failure,
  isAbortError,
  loadAll,
  withRetry,
} from './assets/loader.ts';
import {
  ABORT_AFTER_MS,
  SLOW_MS,
  type Manifest,
  applyChaos,
  parseChaos,
  withDelay,
} from './assets/chaos.ts';

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
//   Lab 05 (networked game; every flag changes ONE thing so the effect can be seen):
//     ?predict=0                                      stage 1: own ship moves only after a snapshot
//     ?interp=0                                       draw the newest snapshot, no interpolation
//     ?delay=100                                      interpolation delay in ms (default 100)
//     ?format=json                                    JSON frames instead of the binary protocol
//     ?lag=100 &jitter=30 &loss=5                     artificial RTT (ms), jitter (ms), loss (%)
//     ?noise=8                                        Math.random() inside integrate (browser only)
//     ?graph=0                                        hide the netgraph (key G toggles it)
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const experiment = params.get('exp');
const autopilot = params.has('autopilot');
const seedParam = Number(params.get('seed'));
const chaos = parseChaos(params);
const sequential = params.get('load') === 'sequential';
const predict = params.get('predict') !== '0';
const interp = params.get('interp') !== '0';
const interpDelayMs = Number(params.get('delay')) > 0 ? Number(params.get('delay')) : 100;
const wireFormat = params.get('format') === 'json' ? 'json' : 'binary';
const conditioner = Conditioner.fromParams(params);
const noise = Number(params.get('noise')) || 0;
let showGraph = params.get('graph') !== '0';
if (noise > 0) {
  // The experiment: randomness inside the physics, in the BROWSER only. The server's integrate()
  // stays deterministic, so every prediction is slightly wrong and every snapshot corrects it.
  physicsHooks.afterIntegrate = (s) => ({
    ...s,
    vx: s.vx + (Math.random() - 0.5) * noise,
    vy: s.vy + (Math.random() - 0.5) * noise,
  });
}

/** index.html promises these elements; if one is missing, fail loudly at start-up, not later. */
function byId<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type))
    throw new Error(`index.html has no #${id} (${type.name})`);
  return found;
}

const canvasApi = createCanvas(byId('game', HTMLCanvasElement));
const { ctx, view } = canvasApi;
const overlay = byId('overlay', HTMLElement);
const roomPanel = byId('room-panel', HTMLElement);

const input: InputSource = autopilot
  ? {
      isDown: (code: string) => code === 'ArrowUp',
      justPressed: () => false,
      endStep: () => {},
    }
  : createInput(window);

const audio = createAudio();
const hud = createHud();
const loadingScreen = createLoadingScreen();

// ---- application state: what is on screen ---------------------------------------------------
// 'loading' -> 'lobby' -> 'playing' (Esc goes back to 'lobby'); 'failed' = Retry button.
type Phase = 'loading' | 'lobby' | 'joining' | 'playing' | 'failed';
let phase: Phase = experiment || autopilot ? 'playing' : 'loading';
let sprites: Sprites | null = null;
let loadReport: { elapsedMs: number; failed: Failure[]; concurrent: boolean } = {
  elapsedMs: 0,
  failed: [],
  concurrent: !sequential,
};
let game: Game | null = null; // offline Game (experiments)
let net: NetGame | null = null; // NetGame while we are in a room: the server owns the world
let room: RoomInfo | null = null;
let callsign = '';
let simTime = 0;
let autopilotResult = '';
let detachGame = () => {};
let unmount = () => {};
let session: RoomSession | null = null; // RoomSession while joining or in a room
let roomUnmount = () => {};

// ---- game -----------------------------------------------------------------------------------
// The sim never calls Math.random(); the seed is chosen HERE, at the edge of the program.
function newGame(): Game {
  if (autopilot) return new Game({ seed: 1, asteroids: 0, pickups: false });
  const seed = seedParam || Math.floor(Math.random() * 2 ** 32);
  return new Game({ seed, ...room?.arena });
}

function startGame(): void {
  detachGame();
  const fresh = newGame();
  game = fresh;
  hud.reset();
  // The simulation publishes events; these two modules subscribe. It imports neither of them.
  const detachAudio = audio.attach(fresh.events);
  const detachHud = hud.attach(fresh.events);
  detachGame = () => {
    detachAudio();
    detachHud();
  };
}

/** Online: no Game here. The server simulates; NetGame predicts our ship and shows the rest. */
function startNetGame(slot: number): void {
  detachGame();
  game = null;
  net = new NetGame({
    slot,
    send: (data) => session?.sendGame(data),
    format: wireFormat,
    predict,
    interp,
    interpDelayMs,
    conditioner,
  });
  hud.reset();
  const detachAudio = audio.attach(net.events);
  const detachHud = hud.attach(net.events, slot);
  detachGame = () => {
    detachAudio();
    detachHud();
    net = null;
    loop.setStep(1 / 60);
  };
  loop.setStep(1 / 30); // the same 30 steps/s as the server: one input per step = one per tick
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
let loadController: AbortController | null = null;

// What the server-side files promise, checked when they ARRIVE (a file is data from outside).
const manifestSchema = z.object({
  assets: z.record(
    z.string(),
    z.object({
      type: z.enum(['json', 'image', 'audio']),
      url: z.string(),
      onError: z.enum(['fail', 'fallback', 'skip']).optional(),
    }),
  ),
});
const atlasSchema = z.object({
  frames: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      fit: z.number(),
    }),
  ),
});
const arenaSchema = z
  .object({
    asteroids: z.number().int().min(0).optional(),
    pickups: z.boolean().optional(),
    hunterChance: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional(),
  })
  .catch({}); // a broken arena.json means "defaults", not "no game"

const asAudio = (value: unknown): AudioBuffer | null =>
  typeof AudioBuffer !== 'undefined' && value instanceof AudioBuffer ? value : null;
const asImage = (value: unknown): CanvasImageSource | null =>
  value instanceof HTMLImageElement || value instanceof ImageBitmap ? value : null;

async function loadEverything(signal: AbortSignal, useChaos: boolean) {
  const { assets: files } = manifestSchema.parse(
    await withRetry(
      () => fetchJson('assets/manifest.json', { signal, timeoutMs: 4000 }),
      {
        signal,
      },
    ),
  );

  let manifest: Manifest = Object.fromEntries(
    Object.entries(files).filter(
      ([, entry]) => audio.available || entry.type !== 'audio',
    ),
  );
  if (useChaos) manifest = applyChaos(manifest, chaos);

  // The timeout chaos waits SLOW_MS; shorten the per-request limit so the demo does not take
  // half a minute. Normal runs use the loader's defaults.
  const demoTimeout = useChaos && chaos.flags.has('timeout');
  return loadAll(manifest, {
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
}

async function boot(): Promise<void> {
  unmount();
  phase = 'loading';
  loadingScreen.reset();
  attempt++;
  const controller = new AbortController();
  loadController = controller;
  const { signal } = controller;
  const useChaos = attempt === 1; // chaos breaks the first try only; Retry then succeeds

  if (useChaos && chaos.flags.has('abort')) {
    setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  }

  try {
    const result = await loadEverything(signal, useChaos);
    const { assets, failed } = result;
    loadReport = { elapsedMs: result.elapsedMs, failed, concurrent: !sequential };

    audio.setBuffers({
      shoot: asAudio(assets['shoot']),
      hit: asAudio(assets['hit']),
      explode: asAudio(assets['explode']),
      pickup: asAudio(assets['pickup']),
    });
    const sheet = asImage(assets['sprites']);
    const atlas = atlasSchema.safeParse(assets['atlas']);
    sprites = sheet && atlas.success ? createSprites({ sheet, atlas: atlas.data }) : null;
    const arena = arenaSchema.parse(assets['arena'] ?? {});
    Object.assign(window, { dogfightAssets: { ...loadReport, arena } }); // for the DevTools console

    defaultArena = arena;
    showLobby();
  } catch (error) {
    phase = 'failed';
    const what = isAbortError(error)
      ? 'Loading was cancelled'
      : 'Could not load the game';
    const url = error instanceof Error && 'url' in error ? String(error.url) : '';
    unmount = mountRetryView(overlay, {
      title: what,
      detail: `Reason: ${describeError(error)}${url ? ` (${url})` : ''}. Press Retry to try again.`,
      onRetry: boot,
    });
  }
}

// ---- lobby ----------------------------------------------------------------------------------
let lobby: Lobby | null = null;
let firstRoomsRequest = true;

let defaultArena: RoomInfo['arena'] = {};

function showLobby(notice = ''): void {
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
    lobby.on('joined', (detail) => enterRoom(detail.room, detail.name));
  }
  const failed = loadReport.failed.map(
    ({ id, error }) => `${id}: ${describeError(error)}`,
  );
  unmount = mountLobbyView(overlay, lobby, {
    notice:
      notice || (failed.length ? `Started with fallbacks — ${failed.join(', ')}` : ''),
  });
  lobby.start();
}

// ---- room: the lobby's Join opens a WebSocket (Lab 04); the game starts when the SERVER says
// "joined". Coordinates are not sent yet (Lab 05): the server only knows who is in the room.
function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

const RECONNECT_GIVE_UP_MS = 10_000;
let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

function enterRoom(chosen: RoomInfo, name: string): void {
  callsign = name;
  unmount();
  phase = 'joining';
  session = new RoomSession({ url: wsUrl(), format: wireFormat });
  const current = session;
  unmount = mountRetryView(overlay, {
    title: `Joining ${chosen.name}…`,
    detail: 'Connecting to the server.',
    buttonLabel: 'Cancel',
    onRetry: () => abandonRoom(),
  });

  current.on('joined', (detail) => {
    if (session !== current) return;
    if (phase === 'playing') {
      // A re-join after a reconnect. The connection was broken, so what we predicted and what the
      // server did may have drifted apart, and a RESTARTED server counts its ticks from zero:
      // start the netcode again (fresh snapshots, fresh prediction) instead of trusting old state.
      clearTimeout(giveUpTimer);
      giveUpTimer = undefined;
      startNetGame(detail.slot);
      return;
    }
    unmount();
    room = { ...detail.room, arena: { ...defaultArena, ...detail.room.arena } };
    startNetGame(detail.slot);
    phase = 'playing';
    roomUnmount = mountRoomView(roomPanel, current);
  });
  current.on('game', (detail) => {
    if (session === current) net?.receive(detail.data, detail.size);
  });
  current.on('rejected', (detail) => {
    if (session !== current) return;
    abandonRoom(`Could not join ${chosen.name}: ${detail.message}`);
  });
  current.on('ended', (detail) => {
    if (session !== current) return;
    abandonRoom(`Disconnected: ${detail.reason}`);
  });
  // The connection dropped in the middle of a match (server killed, Wi-Fi gone). The session keeps
  // retrying; if it cannot get back within RECONNECT_GIVE_UP_MS, the player goes back to the lobby
  // by themselves, with a notice, instead of staring at a frozen game.
  current.on('status', (detail) => {
    if (session !== current || phase !== 'playing') return;
    if (detail.state === 'reconnecting' && giveUpTimer === undefined) {
      giveUpTimer = setTimeout(() => {
        giveUpTimer = undefined;
        if (session === current)
          abandonRoom('Lost connection to the server. Back in the lobby.');
      }, RECONNECT_GIVE_UP_MS);
    }
  });
  // While the first connect is retried, tell the player (the panel above) what is going on.
  current.on('status', (detail) => {
    if (session !== current || phase !== 'joining' || detail.state !== 'reconnecting')
      return;
    unmount();
    unmount = mountRetryView(overlay, {
      title: `Joining ${chosen.name}…`,
      detail: `Server not reachable. Trying again${detail.delayMs ? ` in ${(detail.delayMs / 1000).toFixed(1)} s` : ''}.`,
      buttonLabel: 'Cancel',
      onRetry: () => abandonRoom(),
    });
  });
  current.join(chosen.id, name);
}

/** Leave the room (if any), close the socket, and show the lobby again. */
function abandonRoom(notice = ''): void {
  clearTimeout(giveUpTimer);
  giveUpTimer = undefined;
  const old = session;
  session = null;
  old?.leave();
  roomUnmount();
  roomUnmount = () => {};
  detachGame();
  detachGame = () => {};
  game = null;
  unmount();
  showLobby(notice);
}

function leaveGame(): void {
  abandonRoom();
}

// ---- keyboard shortcuts outside the simulation ------------------------------------------------
window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement;
  if (event.code === 'KeyM' && !event.repeat && !typing) {
    audio.toggleMute();
  }
  if (event.code === 'KeyG' && !event.repeat && !typing) showGraph = !showGraph;
  if (event.code === 'Escape' && phase === 'playing' && !experiment && !autopilot)
    leaveGame();
});

// ---- the loop (Lab 01) ------------------------------------------------------------------------
function simulate(dt: number): void {
  if (phase === 'playing') {
    if (net) {
      net.step(bitsFromInput(input)); // only WHAT IS HELD goes to the server, never a position
    } else {
      if (input.justPressed('KeyR')) startGame();
      game?.step(dt, input);
    }

    simTime += dt;
    if (autopilot && !autopilotResult && simTime >= 5 && game?.ship) {
      const { x, y } = game.ship.pos;
      autopilotResult = `5 s thrust -> x=${x.toFixed(3)} y=${y.toFixed(3)}`;
      console.log(`[${experiment ?? 'fixed'}] ${autopilotResult}`);
    }
  }
  input.endStep();
}

let frameCounter = 0;
let entityCount = 0;

/** The callsign above every OTHER ship (our own needs no label). */
function drawCallsigns(entities: readonly Drawable[], ownSlot: number): void {
  ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9fd2ff';
  for (const e of entities) {
    if (e.kind !== 'ship' || e.slot === ownSlot) continue;
    const player = session?.players.find((p) => p.slot === e.slot);
    ctx.fillText(player?.name ?? `P${e.slot}`, e.pos.x, e.pos.y - 26);
  }
  ctx.textAlign = 'left';
}

/** The live entities of a World that the renderer can draw (explosions included). */
function* drawablesOf(world: World): Generator<Drawable> {
  for (const e of world) {
    if (
      isKind(e, 'ship') ||
      isKind(e, 'bullet') ||
      isKind(e, 'asteroid') ||
      isKind(e, 'pickup') ||
      isKind(e, 'explosion')
    )
      yield e;
  }
}

function render(alpha: number, stats: LoopStats): void {
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
    if (net) {
      const entities = net.view(alpha);
      for (const entity of entities) drawEntity(ctx, entity, alpha, sprites);
      drawCallsigns(entities, net.slot);
      entityCount = entities.length;
    } else if (game) {
      for (const entity of drawablesOf(game.world))
        drawEntity(ctx, entity, alpha, sprites);
      entityCount = game.world.size;
    }
    hud.drawWorld(ctx);
  }
  ctx.restore();

  if (phase === 'loading') loadingScreen.draw(ctx, view);
  if (phase !== 'playing') return;

  const hudData = net ? net.hud : game?.hud;
  if (hudData) hud.drawScreen(ctx, view, hudData);

  const assetNote = loadReport.failed.length
    ? `fallbacks: ${loadReport.failed.map((f) => f.id).join(', ')}`
    : sprites
      ? 'sprites'
      : 'vector art';
  const extra = [
    `mode       ${experiment ?? 'normal (rAF + fixed step)'}`,
    `alpha      ${alpha.toFixed(2)}   dpr ${view.dpr}   entities ${entityCount}`,
  ];
  if (room) {
    const n = session?.players.length ?? 1;
    extra.push(
      `room       ${room.name} · ${callsign} · ${n} in room · ${session?.state ?? 'local'}`,
    );
  }
  if (!experiment && !autopilot) {
    extra.push(
      `assets     ${assetNote} · ${loadReport.concurrent ? 'concurrent' : 'sequential'} ${loadReport.elapsedMs.toFixed(0)} ms`,
      `sound      ${audio.available ? audio.state : 'unavailable'}${audio.muted ? ' (muted)' : ''}`,
    );
  }
  extra.push(
    autopilotResult || 'arrows/WASD fly · SPACE fire · M mute · G netgraph · Esc lobby',
  );
  drawHud(ctx, stats, extra);
  if (net && showGraph) drawNetgraph(ctx, view, net, { noise });
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
if (import.meta.env.DEV || params.has('debug'))
  Object.assign(globalThis, {
    dogfight: {
      loop,
      audio,
      get game() {
        return game;
      },
      get net() {
        return net;
      },
      get phase() {
        return phase;
      },
      get session() {
        return session;
      },
    },
  });

// ---- Lab 08: phone and install ----------------------------------------------------------------
// Touch buttons (only on touch screens) press the same keys as the keyboard.
mountTouchControls(document.body, window, params.has('touch'));

// The service worker makes the game installable (see public/sw.js). Not in dev: Vite's hot reload
// and a cache that serves old files do not mix.
if ('serviceWorker' in navigator && !import.meta.env.DEV && !params.has('nosw')) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* no service worker (private mode, http on a LAN address): the game works without it */
    });
  });
}
