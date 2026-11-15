import { ARENA } from './arena.js';

/**
 * The wire format, two ways to write the SAME messages:
 *
 *   binary  ArrayBuffer + DataView. Little-endian, first byte = format version, second = type.
 *   json    JSON.stringify of the same plain objects (behind ?format=json, for comparison).
 *
 * Why little-endian: x86 and ARM (every PC and phone) are little-endian, so DataView does no
 * byte swapping; the order is still written down and passed explicitly, never "whatever the CPU
 * does" (an ArrayBuffer can be read through Int16Array, which DOES use the CPU's order).
 *
 * Sizes: positions of other entities are u16 (0..65535 over the arena = 0.02 units per step, below
 * one pixel), angles are Int16 (-pi..pi over -32767..32767), velocities Int16. The player's OWN ship
 * is sent as float64: the browser replays its inputs from that state, and an exact copy
 * makes the replay bit-identical to what the server did.
 *
 * No DOM and no Node modules here (no Buffer): the same file runs in both places.
 */
export const WIRE_VERSION = 1;
export const LE = true; // little-endian, passed to every DataView call

export const C2S = Object.freeze({ INPUT: 1, PING: 2 });
export const S2C = Object.freeze({ SNAPSHOT: 1, PONG: 2 });

export class DecodeError extends Error {
  name = 'DecodeError';
}

const U16 = 65535;
const I16 = 32767;
const qx = (x) => Math.max(0, Math.min(U16, Math.round((x / ARENA.width) * U16)));
const qy = (y) => Math.max(0, Math.min(U16, Math.round((y / ARENA.height) * U16)));
const dx = (q) => (q / U16) * ARENA.width;
const dy = (q) => (q / U16) * ARENA.height;
const TWO_PI = Math.PI * 2;
/** any angle -> Int16: wrap to [-pi, pi), then scale. */
export function angleToInt16(a) {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return Math.max(-I16, Math.min(I16, Math.round((w / Math.PI) * I16)));
}
export const int16ToAngle = (q) => (q / I16) * Math.PI;
const clampI16 = (v) => Math.max(-I16, Math.min(I16, Math.round(v)));
const clampU8 = (v) => Math.max(0, Math.min(255, v | 0));

// ---------------------------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------------------------

/** Input packet: [ver u8][type u8][firstSeq u32][count u8][bits u8 x count]. 7 + count bytes. */
export function encodeInput(firstSeq, bitsList) {
  const buffer = new ArrayBuffer(7 + bitsList.length);
  const view = new DataView(buffer);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, C2S.INPUT);
  view.setUint32(2, firstSeq >>> 0, LE);
  view.setUint8(6, bitsList.length);
  bitsList.forEach((bits, i) => view.setUint8(7 + i, bits & 15));
  return buffer;
}

export function encodePing(t) {
  const buffer = new ArrayBuffer(10);
  const view = new DataView(buffer);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, C2S.PING);
  view.setFloat64(2, t, LE);
  return buffer;
}

/** Returns { type: 'input', seq, bits: number[] } | { type: 'ping', t }, or throws DecodeError. */
export function decodeClient(data) {
  const view = asView(data);
  if (view.byteLength < 2) throw new DecodeError('too short');
  if (view.getUint8(0) !== WIRE_VERSION)
    throw new DecodeError('unsupported wire version');
  switch (view.getUint8(1)) {
    case C2S.INPUT: {
      if (view.byteLength < 7) throw new DecodeError('input too short');
      const count = view.getUint8(6);
      if (count < 1 || count > 32 || view.byteLength !== 7 + count)
        throw new DecodeError('bad input length');
      const bits = [];
      for (let i = 0; i < count; i++) bits.push(view.getUint8(7 + i) & 15);
      return { type: 'input', seq: view.getUint32(2, LE), bits };
    }
    case C2S.PING:
      if (view.byteLength !== 10) throw new DecodeError('bad ping length');
      return { type: 'ping', t: view.getFloat64(2, LE) };
    default:
      throw new DecodeError('unknown message type');
  }
}

// ---------------------------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------------------------

export function encodePong(t, tick) {
  const buffer = new ArrayBuffer(14);
  const view = new DataView(buffer);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, S2C.PONG);
  view.setFloat64(2, t, LE);
  view.setUint32(10, tick >>> 0, LE);
  return buffer;
}

// Sizes of the repeated records, bytes.
const SHIP_BYTES = 9;
const BULLET_BYTES = 14;
const ROCK_BYTES = 7;
const PICKUP_BYTES = 7;
const EVENT_BYTES = 5;
const OWN_ALIVE_BYTES = 5 * 8 + 8; // 5 x f64 + thrust, cooldown(2), hp, shield, rapid, homing, invuln
const cap = (list) => (list.length > 255 ? list.slice(0, 255) : list);

/** Snapshot -> ArrayBuffer. See the layout comment in README ("Binary format"). */
export function encodeSnapshot(s) {
  const ships = cap(s.ships);
  const bullets = cap(s.bullets);
  const asteroids = cap(s.asteroids);
  const pickups = cap(s.pickups);
  const events = cap(s.events);
  const own = s.own;

  const size =
    2 +
    4 +
    4 + // version, type, tick, ackSeq
    1 +
    (own.alive ? OWN_ALIVE_BYTES : 0) +
    4 +
    2 +
    1 + // own: flags [+ ship], score, deaths, respawn
    1 +
    ships.length * SHIP_BYTES +
    1 +
    bullets.length * BULLET_BYTES +
    1 +
    asteroids.length * ROCK_BYTES +
    1 +
    pickups.length * PICKUP_BYTES +
    1 +
    events.length * EVENT_BYTES;

  const buffer = new ArrayBuffer(size);
  const v = new DataView(buffer);
  let o = 0;
  const u8 = (n) => (v.setUint8(o, n), (o += 1));
  const u16 = (n) => (v.setUint16(o, n, LE), (o += 2));
  const i16 = (n) => (v.setInt16(o, n, LE), (o += 2));
  const u32 = (n) => (v.setUint32(o, n >>> 0, LE), (o += 4));
  const f64 = (n) => (v.setFloat64(o, n, LE), (o += 8));

  u8(WIRE_VERSION);
  u8(S2C.SNAPSHOT);
  u32(s.tick);
  u32(s.ackSeq);

  u8(own.alive ? 1 : 0);
  if (own.alive) {
    f64(own.x);
    f64(own.y);
    f64(own.vx);
    f64(own.vy);
    f64(own.angle);
    u8(own.thrust ? 1 : 0);
    u16(Math.min(U16, own.cooldownMs));
    u8(own.hp);
    u8(own.shield);
    u8(own.rapid);
    u8(own.homing);
    u8(own.invuln);
  }
  u32(own.score);
  u16(Math.min(U16, own.deaths));
  u8(clampU8(own.respawn));

  u8(ships.length);
  for (const e of ships) {
    u8(e.slot);
    u16(qx(e.x));
    u16(qy(e.y));
    i16(angleToInt16(e.angle));
    u8((e.thrust ? 1 : 0) | (e.invuln ? 2 : 0) | (e.shield ? 4 : 0));
    u8(e.hp);
  }
  u8(bullets.length);
  for (const e of bullets) {
    u16(e.id & U16);
    u16(qx(e.x));
    u16(qy(e.y));
    i16(clampI16(e.vx));
    i16(clampI16(e.vy));
    u8(e.slot & 255);
    u16(e.fireSeq & U16);
    u8(e.homing ? 1 : 0);
  }
  u8(asteroids.length);
  for (const e of asteroids) {
    u16(e.id & U16);
    u16(qx(e.x));
    u16(qy(e.y));
    u8((e.size & 15) | (e.hunter ? 16 : 0));
  }
  u8(pickups.length);
  for (const e of pickups) {
    u16(e.id & U16);
    u16(qx(e.x));
    u16(qy(e.y));
    u8(e.type);
  }
  u8(events.length);
  for (const e of events) {
    u8((e.kind & 15) | ((e.param ?? 0) << 4));
    u16(qx(e.x));
    u16(qy(e.y));
  }
  if (o !== size) throw new Error(`snapshot size mismatch: wrote ${o}, expected ${size}`);
  return buffer;
}

/** ArrayBuffer -> { type: 'snapshot', ...snapshot } | { type: 'pong', t, tick }. */
export function decodeServer(data) {
  const v = asView(data);
  if (v.byteLength < 2) throw new DecodeError('too short');
  if (v.getUint8(0) !== WIRE_VERSION) throw new DecodeError('unsupported wire version');
  const type = v.getUint8(1);
  if (type === S2C.PONG) {
    if (v.byteLength !== 14) throw new DecodeError('bad pong length');
    return { type: 'pong', t: v.getFloat64(2, LE), tick: v.getUint32(10, LE) };
  }
  if (type !== S2C.SNAPSHOT) throw new DecodeError('unknown message type');

  let o = 2;
  const need = (n) => {
    if (o + n > v.byteLength) throw new DecodeError('truncated snapshot');
  };
  const u8 = () => (need(1), v.getUint8(o++));
  const u16 = () => (need(2), ((o += 2), v.getUint16(o - 2, LE)));
  const i16 = () => (need(2), ((o += 2), v.getInt16(o - 2, LE)));
  const u32 = () => (need(4), ((o += 4), v.getUint32(o - 4, LE)));
  const f64 = () => (need(8), ((o += 8), v.getFloat64(o - 8, LE)));

  const tick = u32();
  const ackSeq = u32();
  const alive = u8() & 1;
  const own = { alive: Boolean(alive) };
  if (alive) {
    own.x = f64();
    own.y = f64();
    own.vx = f64();
    own.vy = f64();
    own.angle = f64();
    own.thrust = u8();
    own.cooldownMs = u16();
    own.hp = u8();
    own.shield = u8();
    own.rapid = u8();
    own.homing = u8();
    own.invuln = u8();
  }
  own.score = u32();
  own.deaths = u16();
  own.respawn = u8();

  const list = (decodeOne) => {
    const n = u8();
    const out = [];
    for (let i = 0; i < n; i++) out.push(decodeOne());
    return out;
  };
  const ships = list(() => {
    const slot = u8();
    const x = dx(u16());
    const y = dy(u16());
    const angle = int16ToAngle(i16());
    const flags = u8();
    return {
      slot,
      x,
      y,
      angle,
      thrust: flags & 1,
      invuln: (flags >> 1) & 1,
      shield: (flags >> 2) & 1,
      hp: u8(),
    };
  });
  const bullets = list(() => ({
    id: u16(),
    x: dx(u16()),
    y: dy(u16()),
    vx: i16(),
    vy: i16(),
    slot: u8(),
    fireSeq: u16(),
    homing: u8() & 1,
  }));
  const asteroids = list(() => {
    const id = u16();
    const x = dx(u16());
    const y = dy(u16());
    const f = u8();
    return { id, x, y, size: f & 15, hunter: (f >> 4) & 1 };
  });
  const pickups = list(() => ({ id: u16(), x: dx(u16()), y: dy(u16()), type: u8() }));
  const events = list(() => {
    const k = u8();
    return { kind: k & 15, param: k >> 4, x: dx(u16()), y: dy(u16()) };
  });
  if (o !== v.byteLength) throw new DecodeError('trailing bytes');
  return {
    type: 'snapshot',
    tick,
    ackSeq,
    own,
    ships,
    bullets,
    asteroids,
    pickups,
    events,
  };
}

function asView(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data))
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new DecodeError('not binary');
}

// ---------------------------------------------------------------------------------------------
// JSON flavour of the same messages (for the size comparison and for ?format=json)
// ---------------------------------------------------------------------------------------------
export const encodeSnapshotJson = (s) => JSON.stringify({ v: 1, type: 'snap', ...s });
export const encodeInputJson = (firstSeq, bits) =>
  JSON.stringify({ v: 1, type: 'input', seq: firstSeq, bits });
export const encodePingJson = (t) => JSON.stringify({ v: 1, type: 'ping', t });
export const encodePongJson = (t, tick) =>
  JSON.stringify({ v: 1, type: 'pong', t, tick });
