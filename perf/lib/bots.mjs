// Headless players for Lab 07. A bot is a WebSocket that sends EXACTLY what the browser sends:
// the binary input packet of shared/codec.ts (30 per second, the last 8 inputs repeated in each
// one), made from the same four key bits a human's keyboard makes (LEFT, RIGHT, THRUST, FIRE).
// The only thing that differs is who presses the keys: a seeded random "pilot".
import { WebSocket } from 'ws';
import { encodeInput } from '@dogfight/shared/codec.ts';
import { BIT, TICK_HZ } from '@dogfight/shared/input.ts';

const REDUNDANCY = 8; // same constant as client/src/net/netgame.ts

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pilot: holds thrust most of the time, turns for a while, fires in bursts. Like a person. */
export function createPilot(seed) {
  const random = mulberry32(seed);
  let turn = 0; // -1 left, 0 straight, 1 right
  let turnLeft = 0;
  let burstLeft = 0;
  let thrustLeft = 40;
  let thrust = true;
  return () => {
    if (turnLeft-- <= 0) {
      turn = Math.floor(random() * 3) - 1;
      turnLeft = 5 + Math.floor(random() * 40);
    }
    if (thrustLeft-- <= 0) {
      thrust = random() < 0.75;
      thrustLeft = 10 + Math.floor(random() * 60);
    }
    if (burstLeft <= 0 && random() < 0.04) burstLeft = 3 + Math.floor(random() * 10);
    let bits = 0;
    if (turn < 0) bits |= BIT.LEFT;
    if (turn > 0) bits |= BIT.RIGHT;
    if (thrust) bits |= BIT.THRUST;
    if (burstLeft > 0) {
      bits |= BIT.FIRE;
      burstLeft--;
    }
    return bits;
  };
}

/**
 * Connects `count` bots to `url` (ws://host:port/ws) and joins `room`. Resolves when all of them
 * have joined; `stop()` closes them. `failed` counts bots that could not join or were dropped.
 */
export async function spawnBots({ url, room, count, prefix = 'bot', seed = 1 }) {
  const bots = [];
  const state = { failed: 0, closed: 0, snapshots: 0, bytes: 0 };

  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(url);
        const bot = {
          ws,
          pilot: createPilot(seed * 1000 + i),
          seq: 0,
          pending: [],
          joined: false,
        };
        bots.push(bot);
        const give = (ok) => {
          if (!ok) state.failed++;
          resolve();
        };
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              v: 1,
              type: 'join',
              room,
              name: `${prefix}${i}`,
              format: 'binary',
            }),
          ),
        );
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            state.snapshots++;
            state.bytes += data.byteLength ?? data.length;
            return;
          }
          const message = JSON.parse(data.toString());
          if (message.type === 'joined') {
            bot.joined = true;
            give(true);
          } else if (message.type === 'error' && !bot.joined) give(false);
        });
        ws.on('close', () => {
          state.closed++;
          if (!bot.joined) give(false);
        });
        ws.on('error', () => {});
      });
    }),
  );

  // ONE timer drives every bot: 30 packets per second each, corrected so it does not drift.
  const period = 1000 / TICK_HZ;
  let next = performance.now() + period;
  let timer = null;
  let running = true;
  const tick = () => {
    if (!running) return;
    for (const bot of bots) {
      if (bot.ws.readyState !== WebSocket.OPEN) continue;
      bot.seq++;
      bot.pending.push({ seq: bot.seq, bits: bot.pilot() });
      if (bot.pending.length > REDUNDANCY) bot.pending.shift();
      const first = bot.pending[0];
      bot.ws.send(
        encodeInput(
          first.seq,
          bot.pending.map((p) => p.bits),
        ),
      );
    }
    next += period;
    timer = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  timer = setTimeout(tick, period);

  return {
    bots,
    state,
    get joined() {
      return bots.filter((b) => b.joined && b.ws.readyState === WebSocket.OPEN).length;
    },
    stop() {
      running = false;
      clearTimeout(timer);
      for (const bot of bots) bot.ws.close();
    },
  };
}
