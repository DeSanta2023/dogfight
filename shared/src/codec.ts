import { ARENA } from './arena.ts';
import { entityId, seq as toSeq, tick as toTick, type Seq, type Tick } from './brand.ts';
import type { InputBits } from './input.ts';
import {
  EVENT,
  PICKUP_NAMES,
  type AsteroidView,
  type BulletView,
  type EventKind,
  type Own,
  type PickupView,
  type ShipView,
  type Snapshot,
  type WireEvent,
} from './snapshot.ts';
import type { AsteroidSize } from './entities.ts';

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

/** A frame that is not what the protocol allows. The server closes the socket; the client drops it. */
export class DecodeError extends Error {
  override name = 'DecodeError';
}

export type ClientMessage =
  { type: 'input'; seq: Seq; bits: InputBits[] } | { type: 'ping'; t: number };
export type ServerMessage =
  ({ type: 'snapshot' } & Snapshot) | { type: 'pong'; t: number; tick: Tick };

const U16 = 65535;
const I16 = 32767;
const qx = (x: number): number =>
  Math.max(0, Math.min(U16, Math.round((x / ARENA.width) * U16)));
const qy = (y: number): number =>
  Math.max(0, Math.min(U16, Math.round((y / ARENA.height) * U16)));
const dx = (q: number): number => (q / U16) * ARENA.width;
const dy = (q: number): number => (q / U16) * ARENA.height;
const TWO_PI = Math.PI * 2;
/** any angle -> Int16: wrap to [-pi, pi), then scale. */
export function angleToInt16(a: number): number {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return Math.max(-I16, Math.min(I16, Math.round((w / Math.PI) * I16)));
}
export const int16ToAngle = (q: number): number => (q / I16) * Math.PI;
const clampI16 = (v: number): number => Math.max(-I16, Math.min(I16, Math.round(v)));
const clampU8 = (v: number): number => Math.max(0, Math.min(255, v | 0));

function asView(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Writes numbers at a moving offset. The byte order is chosen HERE, once: always LE. */
class Writer {
  readonly buffer: ArrayBuffer;
  #view: DataView;
  offset = 0;
  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.#view = new DataView(this.buffer);
  }
  u8(n: number): void {
    this.#view.setUint8(this.offset, n);
    this.offset += 1;
  }
  u16(n: number): void {
    this.#view.setUint16(this.offset, n, LE);
    this.offset += 2;
  }
  i16(n: number): void {
    this.#view.setInt16(this.offset, n, LE);
    this.offset += 2;
  }
  u32(n: number): void {
    this.#view.setUint32(this.offset, n >>> 0, LE);
    this.offset += 4;
  }
  f64(n: number): void {
    this.#view.setFloat64(this.offset, n, LE);
    this.offset += 8;
  }
}

/** Reads numbers at a moving offset; running past the end is a DecodeError, never a RangeError. */
class Reader {
  #view: DataView;
  offset = 0;
  constructor(view: DataView) {
    this.#view = view;
  }
  get left(): number {
    return this.#view.byteLength - this.offset;
  }
  #take(n: number): number {
    if (this.left < n) throw new DecodeError('truncated message');
    const at = this.offset;
    this.offset += n;
    return at;
  }
  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }
  u16(): number {
    return this.#view.getUint16(this.#take(2), LE);
  }
  i16(): number {
    return this.#view.getInt16(this.#take(2), LE);
  }
  u32(): number {
    return this.#view.getUint32(this.#take(4), LE);
  }
  f64(): number {
    const n = this.#view.getFloat64(this.#take(8), LE);
    if (!Number.isFinite(n)) throw new DecodeError('NaN or Infinity in a float');
    return n;
  }
}

/** Version byte + type byte. Every message starts like this, in both directions. */
function readHeader(r: Reader): number {
  const version = r.u8();
  if (version !== WIRE_VERSION)
    throw new DecodeError(`unsupported wire version ${version}`);
  return r.u8();
}

// ---------------------------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------------------------

/** Input packet: [ver u8][type u8][firstSeq u32][count u8][bits u8 x count]. 7 + count bytes. */
export function encodeInput(
  firstSeq: number,
  bitsList: readonly InputBits[],
): ArrayBuffer {
  const w = new Writer(7 + bitsList.length);
  w.u8(WIRE_VERSION);
  w.u8(C2S.INPUT);
  w.u32(firstSeq);
  w.u8(bitsList.length);
  for (const bits of bitsList) w.u8(bits & 15);
  return w.buffer;
}

export function encodePing(t: number): ArrayBuffer {
  const w = new Writer(10);
  w.u8(WIRE_VERSION);
  w.u8(C2S.PING);
  w.f64(t);
  return w.buffer;
}

export const MAX_INPUTS_PER_PACKET = 32;

/** Bytes -> a message, or a DecodeError. Length, version, ranges: all checked HERE. */
export function decodeClient(data: ArrayBuffer | ArrayBufferView): ClientMessage {
  const view = asView(data);
  const r = new Reader(view);
  const type = readHeader(r);
  switch (type) {
    case C2S.INPUT: {
      const first = r.u32();
      const count = r.u8();
      if (count < 1 || count > MAX_INPUTS_PER_PACKET)
        throw new DecodeError('input count out of range');
      if (r.left !== count) throw new DecodeError('bad input length');
      const bits: InputBits[] = [];
      for (let i = 0; i < count; i++) {
        const b = r.u8();
        if (b > 15) throw new DecodeError('input bits out of range');
        bits.push(b);
      }
      return { type: 'input', seq: toSeq(first), bits };
    }
    case C2S.PING: {
      const t = r.f64();
      if (r.left !== 0) throw new DecodeError('bad ping length');
      return { type: 'ping', t };
    }
    default:
      throw new DecodeError(`unknown client message type ${type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------------------------

export function encodePong(t: number, tick: number): ArrayBuffer {
  const w = new Writer(14);
  w.u8(WIRE_VERSION);
  w.u8(S2C.PONG);
  w.f64(t);
  w.u32(tick);
  return w.buffer;
}

// Sizes of the repeated records, bytes.
const SHIP_BYTES = 9;
const BULLET_BYTES = 14;
const ROCK_BYTES = 7;
const PICKUP_BYTES = 7;
const EVENT_BYTES = 5;
const OWN_ALIVE_BYTES = 5 * 8 + 8; // 5 x f64 + thrust, cooldown(2), hp, shield, rapid, homing, invuln
const cap = <T>(list: readonly T[]): readonly T[] =>
  list.length > 255 ? list.slice(0, 255) : list;

/** Snapshot -> ArrayBuffer. See the layout comment in README ("Binary format"). */
export function encodeSnapshot(s: Snapshot): ArrayBuffer {
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

  const w = new Writer(size);
  w.u8(WIRE_VERSION);
  w.u8(S2C.SNAPSHOT);
  w.u32(s.tick);
  w.u32(s.ackSeq);

  w.u8(own.alive ? 1 : 0);
  if (own.alive) {
    w.f64(own.x);
    w.f64(own.y);
    w.f64(own.vx);
    w.f64(own.vy);
    w.f64(own.angle);
    w.u8(own.thrust ? 1 : 0);
    w.u16(Math.min(U16, own.cooldownMs));
    w.u8(own.hp);
    w.u8(own.shield);
    w.u8(own.rapid);
    w.u8(own.homing);
    w.u8(own.invuln);
  }
  w.u32(own.score);
  w.u16(Math.min(U16, own.deaths));
  w.u8(clampU8(own.respawn));

  w.u8(ships.length);
  for (const e of ships) {
    w.u8(e.slot);
    w.u16(qx(e.x));
    w.u16(qy(e.y));
    w.i16(angleToInt16(e.angle));
    w.u8((e.thrust ? 1 : 0) | (e.invuln ? 2 : 0) | (e.shield ? 4 : 0));
    w.u8(e.hp);
  }
  w.u8(bullets.length);
  for (const e of bullets) {
    w.u16(e.id & U16);
    w.u16(qx(e.x));
    w.u16(qy(e.y));
    w.i16(clampI16(e.vx));
    w.i16(clampI16(e.vy));
    w.u8(e.slot & 255);
    w.u16(e.fireSeq & U16);
    w.u8(e.homing ? 1 : 0);
  }
  w.u8(asteroids.length);
  for (const e of asteroids) {
    w.u16(e.id & U16);
    w.u16(qx(e.x));
    w.u16(qy(e.y));
    w.u8((e.size & 15) | (e.hunter ? 16 : 0));
  }
  w.u8(pickups.length);
  for (const e of pickups) {
    w.u16(e.id & U16);
    w.u16(qx(e.x));
    w.u16(qy(e.y));
    w.u8(Math.max(0, PICKUP_NAMES.indexOf(e.type)));
  }
  w.u8(events.length);
  for (const e of events) {
    w.u8((e.kind & 15) | ((e.param & 15) << 4));
    w.u16(qx(e.x));
    w.u16(qy(e.y));
  }
  if (w.offset !== size)
    throw new Error(`snapshot size mismatch: wrote ${w.offset}, expected ${size}`);
  return w.buffer;
}

/** Read `n` records (n comes first, as one byte). */
function list<T>(r: Reader, readOne: () => T): T[] {
  const n = r.u8();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(readOne());
  return out;
}

function readSize(flags: number): AsteroidSize {
  const size = flags & 15;
  if (size === 1 || size === 2 || size === 3) return size;
  throw new DecodeError(`asteroid size ${size} out of range`);
}

function readEventKind(n: number): EventKind {
  for (const kind of Object.values(EVENT)) if (kind === n) return kind;
  throw new DecodeError(`event kind ${n} out of range`);
}

/** Bytes -> { type: 'snapshot', ...snapshot } | { type: 'pong', t, tick }, or a DecodeError. */
export function decodeServer(data: ArrayBuffer | ArrayBufferView): ServerMessage {
  const r = new Reader(asView(data));
  const type = readHeader(r);
  if (type === S2C.PONG) {
    const t = r.f64();
    const tick = r.u32();
    if (r.left !== 0) throw new DecodeError('bad pong length');
    return { type: 'pong', t, tick: toTick(tick) };
  }
  if (type !== S2C.SNAPSHOT) throw new DecodeError(`unknown server message type ${type}`);

  const tick = toTick(r.u32());
  const ackSeq = toSeq(r.u32());
  const alive = r.u8() === 1;
  let own: Own;
  if (alive) {
    const x = r.f64();
    const y = r.f64();
    const vx = r.f64();
    const vy = r.f64();
    const angle = r.f64();
    const thrust = r.u8();
    const cooldownMs = r.u16();
    const hp = r.u8();
    const shield = r.u8();
    const rapid = r.u8();
    const homing = r.u8();
    const invuln = r.u8();
    own = {
      alive: true,
      x,
      y,
      vx,
      vy,
      angle,
      thrust,
      cooldownMs,
      hp,
      shield,
      rapid,
      homing,
      invuln,
      score: 0,
      deaths: 0,
      respawn: 0,
    };
  } else {
    own = { alive: false, score: 0, deaths: 0, respawn: 0 };
  }
  own.score = r.u32();
  own.deaths = r.u16();
  own.respawn = r.u8();

  const ships = list<ShipView>(r, () => {
    const slot = r.u8();
    const x = dx(r.u16());
    const y = dy(r.u16());
    const angle = int16ToAngle(r.i16());
    const flags = r.u8();
    const hp = r.u8();
    return {
      kind: 'ship',
      slot,
      x,
      y,
      angle,
      thrust: flags & 1,
      invuln: (flags >> 1) & 1,
      shield: (flags >> 2) & 1,
      hp,
    };
  });
  const bullets = list<BulletView>(r, () => ({
    kind: 'bullet',
    id: entityId(r.u16()),
    x: dx(r.u16()),
    y: dy(r.u16()),
    vx: r.i16(),
    vy: r.i16(),
    slot: r.u8(),
    fireSeq: r.u16(),
    homing: r.u8() & 1,
  }));
  const asteroids = list<AsteroidView>(r, () => {
    const id = entityId(r.u16());
    const x = dx(r.u16());
    const y = dy(r.u16());
    const flags = r.u8();
    return {
      kind: 'asteroid',
      id,
      x,
      y,
      size: readSize(flags),
      hunter: (flags >> 4) & 1,
    };
  });
  const pickups = list<PickupView>(r, () => {
    const id = entityId(r.u16());
    const x = dx(r.u16());
    const y = dy(r.u16());
    const index = r.u8();
    const pickupType = PICKUP_NAMES[index]; // undefined when the index is out of range
    if (pickupType === undefined)
      throw new DecodeError(`pickup type ${index} out of range`);
    return { kind: 'pickup', id, x, y, type: pickupType };
  });
  const events = list<WireEvent>(r, () => {
    const packed = r.u8();
    return {
      kind: readEventKind(packed & 15),
      param: packed >> 4,
      x: dx(r.u16()),
      y: dy(r.u16()),
    };
  });
  if (r.left !== 0) throw new DecodeError('trailing bytes');
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

// ---------------------------------------------------------------------------------------------
// JSON flavour of the same messages (for the size comparison and for ?format=json)
// ---------------------------------------------------------------------------------------------
export const encodeSnapshotJson = (s: Snapshot): string =>
  JSON.stringify({ v: 1, type: 'snapshot', ...s });
export const encodeInputJson = (firstSeq: number, bits: readonly InputBits[]): string =>
  JSON.stringify({ v: 1, type: 'input', seq: firstSeq, bits });
export const encodePingJson = (t: number): string =>
  JSON.stringify({ v: 1, type: 'ping', t });
export const encodePongJson = (t: number, tick: number): string =>
  JSON.stringify({ v: 1, type: 'pong', t, tick });
