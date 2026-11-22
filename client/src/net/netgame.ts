import { ARENA, angleDelta, wrap, wrappedDelta } from '@dogfight/shared/arena.ts';
import {
  assertNever,
  seq as toSeq,
  type Seq,
  type Tick,
} from '@dogfight/shared/brand.ts';
import { ASTEROID_RADIUS, BULLET, Explosion } from '@dogfight/shared/entities.ts';
import { isKind } from '@dogfight/shared/kinds.ts';
import { GameEvents } from '@dogfight/shared/events.ts';
import {
  decodeServer,
  type ServerMessage,
  encodeInput,
  encodeInputJson,
  encodePing,
  encodePingJson,
} from '@dogfight/shared/codec.ts';
import { BIT, DT, inputFromBits, type InputBits } from '@dogfight/shared/input.ts';
import { createRng, type Rng } from '@dogfight/shared/rng.ts';
import { SHIP, integrate, type ShipState } from '@dogfight/shared/ship.ts';
import {
  EVENT,
  PICKUP_NAMES,
  type Snapshot,
  type WireEvent,
} from '@dogfight/shared/snapshot.ts';
import { Vector2 } from '@dogfight/shared/vector.ts';
import { World } from '@dogfight/shared/world.ts';
import type {
  Drawable,
  DrawableAsteroid,
  DrawableBullet,
  DrawablePickup,
  DrawableShip,
  EffectName,
} from '../render/drawable.ts';
import { Conditioner } from './conditioner.ts';
import { DrawablePool } from '../render/drawable-pool.ts';

const REDUNDANCY = 8; // every packet repeats the last 8 inputs: one lost packet costs nothing
const MAX_PENDING = 120; // 4 s of unconfirmed input: the server is gone, stop remembering
const SNAP_DISTANCE = 120; // a correction bigger than this is a teleport, not a drift: no smoothing
const SMOOTH_TAU_MS = 33; // the correction fades with this time constant: ~95 % gone in 100 ms
const CLOCK_WINDOW_MS = 2000;
const PING_EVERY_MS = 1000;
const MAX_SNAPSHOTS = 40;

type Wire = ArrayBuffer | string;
export interface NetGameOptions {
  slot: number;
  send: (data: Wire) => void;
  format?: 'binary' | 'json';
  predict?: boolean;
  interp?: boolean;
  interpDelayMs?: number;
  conditioner?: Conditioner;
  now?: () => number;
}
interface PendingInput {
  seq: Seq;
  bits: InputBits;
}
interface LocalBullet {
  seq: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  ttl: number;
  homing: boolean;
}
interface SnapshotEntry {
  tick: Tick;
  tickMs: number;
  at: number;
  snap: Snapshot;
}
interface QueuedEvent extends WireEvent {
  tickMs: number;
}
interface Offset {
  x: number;
  y: number;
}
/** What the HUD and the effects bar need from the last snapshot (the own ship's non-physics). */
interface Meta {
  alive: boolean;
  hp: number;
  shield: number;
  rapid: number;
  homing: number;
  invuln: number;
  score: number;
  deaths: number;
  respawn: number;
}
export interface HudView {
  score: number;
  deaths: number;
  hp: number;
  effects: [EffectName, number][];
  respawnIn: number;
}
export interface NetStats {
  rtt: number;
  rttMin: number;
  rttMax: number;
  snapshotAge: number;
  snapshotAgeMax: number;
  correction: number;
  correctionMax: number;
  corrections: number;
  snaps: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  snapshotsPerSec: number;
  lateOrDuplicate: number;
  extrapolating: number;
  history: { rtt: number[]; correction: number[]; age: number[] };
}
const NO_OFFSET: Offset = { x: 0, y: 0 };

interface SnapshotIndex {
  ships: Map<number, Snapshot['ships'][number]>;
  bullets: Map<number, Snapshot['bullets'][number]>;
  asteroids: Map<number, Snapshot['asteroids'][number]>;
  pickups: Map<number, Snapshot['pickups'][number]>;
}

/**
 * The browser's half of the networked game. The player's inputs go to the server, and the server's
 * snapshots come back; this class turns that into something that feels like a local game.
 *
 *  OWN SHIP   client-side PREDICTION: every step the input is applied at once with the same
 *             integrate() the server uses, and remembered in `pending` until a snapshot's `ackSeq`
 *             confirms it. A snapshot RECONCILES: take the server's state of the ship, replay the
 *             inputs it has not seen yet, and fade the visible difference away over ~100 ms.
 *  OTHERS     ENTITY INTERPOLATION: drawn `interpDelayMs` in the past, between the two snapshots
 *             that surround that moment (we never extrapolate someone else's ship).
 *  OWN BULLETS  shown immediately (predicted); when the server's copy arrives it takes over.
 *
 * Flags (constructor options): predict=false is "stage 1" (the ship only moves after a snapshot),
 * interp=false draws the newest snapshot as it is.
 *
 * No DOM: `send`, `now` and the timers are injected, so this runs in Node tests.
 */
export class NetGame {
  readonly events = new GameEvents(); // the same typed bus as the offline Game
  readonly fx = new World(); // explosion particles: decoration made here, never replicated

  readonly slot: number;
  readonly format: 'binary' | 'json';
  readonly predict: boolean;
  readonly interp: boolean;
  readonly interpDelayMs: number;
  readonly conditioner: Conditioner;
  readonly now: () => number;

  // --- own ship ---
  own: ShipState | null = null; // predicted state, or null (dead / no snapshot yet)
  prevOwn: ShipState | null = null;
  meta: Meta = {
    alive: false,
    hp: 0,
    shield: 0,
    rapid: 0,
    homing: 0,
    invuln: 0,
    score: 0,
    deaths: 0,
    respawn: 0,
  };
  pending: PendingInput[] = []; // inputs not yet confirmed
  seq = 0;
  cooldown = 0;
  localBullets: LocalBullet[] = [];
  offset: Offset = NO_OFFSET; // what the correction still owes the screen (always replaced, never mutated)
  #offsetAt = 0;
  // Lab 07: reused every frame, see view()
  readonly #pool = new DrawablePool();
  readonly #out: Drawable[] = [];
  /** id -> entry for each snapshot, built once when a snapshot is first used as "the older one". */
  readonly #indexes = new WeakMap<object, SnapshotIndex>();

  // --- world from the server ---
  snapshots: SnapshotEntry[] = []; // oldest first
  latest: SnapshotEntry | null = null;
  lastTick = -1;
  #clockSamples: { at: number; offset: number }[] = [];
  #queuedEvents: QueuedEvent[] = [];
  #rng: Rng = createRng(0xf1ee7);
  #lastPing = -Infinity;

  // --- numbers for the netgraph ---
  stats: NetStats = {
    rtt: 0,
    rttMin: Infinity,
    rttMax: 0,
    snapshotAge: 0,
    snapshotAgeMax: 0,
    correction: 0,
    correctionMax: 0,
    corrections: 0,
    snaps: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    snapshotsPerSec: 0,
    lateOrDuplicate: 0,
    extrapolating: 0,
    history: { rtt: [], correction: [], age: [] },
  };
  #bytes = { in: 0, out: 0, snaps: 0, since: 0 };
  #ageWindowAt = 0;
  #corrWindowAt = 0;

  constructor({
    slot,
    send,
    format = 'binary',
    predict = true,
    interp = true,
    interpDelayMs = 100,
    conditioner = new Conditioner(),
    now = () => performance.now(),
  }: NetGameOptions) {
    this.slot = slot;
    this.format = format;
    this.predict = predict;
    this.interp = interp;
    this.interpDelayMs = interpDelayMs;
    this.conditioner = conditioner;
    this.#send = send;
    this.now = now;
    this.#bytes.since = now();
  }

  readonly #send: (data: Wire) => void;

  // ===========================================================================================
  // outgoing
  // ===========================================================================================

  /** One fixed client step (30 per second, same DT as the server): read input, predict, send. */
  step(bits: InputBits): void {
    const now = this.now();
    this.seq++;
    this.pending.push({ seq: toSeq(this.seq), bits });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    if (this.predict && this.own) {
      this.prevOwn = this.own;
      this.own = integrate(this.own, inputFromBits(bits), DT);
      this.cooldown = Math.max(0, this.cooldown - DT);
      if (bits & BIT.FIRE && this.cooldown <= 0) this.#fireLocal(this.own);
    }
    this.#stepLocalBullets();
    this.fx.step(DT);
    this.#releaseEvents(now);

    // Redundancy: the packet carries the newest input and up to 7 older, still unconfirmed ones.
    const from = Math.max(0, this.pending.length - REDUNDANCY);
    const slice = this.pending.slice(from);
    const first = slice[0]; // never empty: we pushed one above
    if (first) {
      const list = slice.map((p) => p.bits);
      this.#transmit(
        this.format === 'json'
          ? encodeInputJson(first.seq, list)
          : encodeInput(first.seq, list),
      );
    }
    if (now - this.#lastPing >= PING_EVERY_MS) {
      this.#lastPing = now;
      this.#transmit(this.format === 'json' ? encodePingJson(now) : encodePing(now));
    }
    this.#rollStats(now);
  }

  #transmit(data: Wire): void {
    this.#bytes.out += typeof data === 'string' ? data.length : data.byteLength;
    this.conditioner.deliver(() => this.#send(data));
  }

  #fireLocal(o: ShipState): void {
    const rapid = this.meta.rapid > 0;
    this.cooldown = rapid ? SHIP.rapidCooldown : SHIP.fireCooldown;
    const hx = Math.cos(o.angle);
    const hy = Math.sin(o.angle);
    this.localBullets.push({
      seq: this.seq,
      x: o.x + hx * (SHIP.radius + 4),
      y: o.y + hy * (SHIP.radius + 4),
      vx: o.vx + hx * SHIP.bulletSpeed,
      vy: o.vy + hy * SHIP.bulletSpeed,
      angle: o.angle,
      ttl: BULLET.ttl,
      homing: this.meta.homing > 0,
    });
    this.events.emit('fired', { x: o.x, y: o.y, by: 'ship', slot: this.slot });
  }

  #stepLocalBullets(): void {
    for (const b of this.localBullets) {
      b.x = wrap(b.x + b.vx * DT, ARENA.width);
      b.y = wrap(b.y + b.vy * DT, ARENA.height);
      b.ttl -= DT;
    }
    this.localBullets = this.localBullets.filter((b) => b.ttl > 0);
  }

  // ===========================================================================================
  // incoming (through the conditioner: it may delay, reorder or drop)
  // ===========================================================================================

  /** `data`: ArrayBuffer (binary) or an already parsed JSON message. `size`: bytes on the wire. */
  receive(data: ArrayBuffer | ServerMessage, size: number): void {
    this.#bytes.in += size;
    this.conditioner.deliver(() => this.#handle(data));
  }

  #handle(data: ArrayBuffer | ServerMessage): void {
    let message: ServerMessage;
    try {
      message = data instanceof ArrayBuffer ? decodeServer(data) : data;
    } catch {
      return; // a damaged frame is just a lost frame
    }
    switch (message.type) {
      case 'snapshot':
        this.#onSnapshot(message);
        break;
      case 'pong':
        this.#onPong(message.t);
        break;
      default:
        return assertNever(message);
    }
  }

  #onPong(t: number): void {
    const rtt = this.now() - t;
    const s = this.stats;
    s.rtt = s.rtt ? s.rtt * 0.8 + rtt * 0.2 : rtt;
    s.rttMin = Math.min(s.rttMin, rtt);
    s.rttMax = Math.max(s.rttMax, rtt);
    this.#push(s.history.rtt, rtt);
  }

  #push(list: number[], value: number): void {
    list.push(value);
    if (list.length > 90) list.shift();
  }

  #onSnapshot(snap: Snapshot): void {
    const now = this.now();
    if (snap.tick <= this.lastTick) {
      this.stats.lateOrDuplicate++; // reordered or duplicated by the network: ignore
      return;
    }
    this.lastTick = snap.tick;
    this.stats.snaps++;
    this.#bytes.snaps++;
    this.stats.snapshotAge = 0;

    const tickMs = snap.tick * DT * 1000;
    this.#clockSamples.push({ at: now, offset: now - tickMs });
    while ((this.#clockSamples[0]?.at ?? Infinity) < now - CLOCK_WINDOW_MS)
      this.#clockSamples.shift();
    const entry: SnapshotEntry = { tick: snap.tick, tickMs, at: now, snap };
    this.snapshots.push(entry);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.latest = entry;

    for (const e of snap.events) this.#queuedEvents.push({ tickMs, ...e });

    // Confirmed inputs are forgotten.
    while ((this.pending[0]?.seq ?? Infinity) <= snap.ackSeq) this.pending.shift();
    this.localBullets = this.localBullets.filter((b) => b.seq > snap.ackSeq);

    const o = snap.own;
    if (!o.alive) {
      this.meta = { ...EMPTY_META, score: o.score, deaths: o.deaths, respawn: o.respawn };
      this.own = this.prevOwn = null;
      this.localBullets = [];
      this.offset = NO_OFFSET;
      return;
    }
    if (this.meta.alive && o.hp < this.meta.hp)
      // My own damage: `slot` says whose ship it was, so the HUD flashes only for me.
      this.events.emit('hit', {
        x: o.x,
        y: o.y,
        target: 'ship',
        slot: this.slot,
        by: null,
      });
    this.meta = {
      alive: true,
      hp: o.hp,
      shield: o.shield,
      rapid: o.rapid,
      homing: o.homing,
      invuln: o.invuln,
      score: o.score,
      deaths: o.deaths,
      respawn: o.respawn,
    };
    const server: ShipState = {
      x: o.x,
      y: o.y,
      vx: o.vx,
      vy: o.vy,
      angle: o.angle,
      thrust: o.thrust,
    };
    if (!this.predict) {
      // Stage 1: the ship is wherever the server last said it was.
      this.prevOwn = this.own ?? server;
      this.own = server;
      return;
    }

    // --- RECONCILIATION: server state + the inputs the server has not applied yet ---
    let state = server;
    let cooldown = o.cooldownMs / 1000;
    for (const p of this.pending) {
      state = integrate(state, inputFromBits(p.bits), DT);
      cooldown = Math.max(0, cooldown - DT);
    }
    this.cooldown = cooldown;
    const before = this.own;
    if (!before) {
      this.own = state;
      this.prevOwn = state;
      return;
    }
    const cx = wrappedDelta(before.x, state.x, ARENA.width); // how far the server pulled us
    const cy = wrappedDelta(before.y, state.y, ARENA.height);
    const magnitude = Math.hypot(cx, cy);
    const s = this.stats;
    s.correction = magnitude;
    s.correctionMax = Math.max(s.correctionMax, magnitude);
    if (magnitude > 0.01) s.corrections++;
    this.#push(s.history.correction, magnitude);

    if (magnitude > SNAP_DISTANCE || !this.prevOwn) {
      this.offset = NO_OFFSET; // teleport (respawn, a collision knock): just be there
      this.prevOwn = state;
    } else {
      // The ship snaps to the right place instantly, but what is DRAWN stays where it was and
      // glides over: offset = -(correction), decayed in view(). prevOwn moves with the state so
      // that the frame-to-frame interpolation is not disturbed.
      this.offset = { x: this.offset.x - cx, y: this.offset.y - cy };
      this.prevOwn = { ...this.prevOwn, x: this.prevOwn.x + cx, y: this.prevOwn.y + cy };
    }
    this.own = state;
  }

  // ===========================================================================================
  // events: sound and particles, released when the picture they belong to is on screen
  // ===========================================================================================
  #releaseEvents(now: number): void {
    if (!this.#queuedEvents.length) return;
    const due = this.interp ? this.#renderTime(now) : Infinity;
    const rest: QueuedEvent[] = [];
    for (const e of this.#queuedEvents) {
      if (e.tickMs > due) rest.push(e);
      else this.#playEvent(e);
    }
    this.#queuedEvents = rest;
  }

  #playEvent(e: WireEvent): void {
    const at = { x: e.x, y: e.y };
    switch (e.kind) {
      case EVENT.FIRED:
        // My own shots were already heard when I pressed the key.
        if (!(this.predict && e.param === this.slot))
          this.events.emit('fired', { ...at, by: 'ship', slot: e.param });
        break;
      case EVENT.HIT_SHIP:
        // slot -1: "somebody else's ship" (the wire event does not say whose). My own damage
        // is announced from the snapshot's hp, above, with my slot.
        this.events.emit('hit', { ...at, target: 'ship', slot: -1, by: null });
        break;
      case EVENT.HIT_ROCK:
        this.events.emit('hit', { ...at, target: 'asteroid', slot: -1, by: null });
        break;
      case EVENT.SHIP_DESTROYED:
        this.#explode(at, 30, 260, 1, 'ship');
        this.events.emit('exploded', { ...at, kind: 'ship', slot: -1, points: 0 });
        break;
      case EVENT.ROCK_DESTROYED:
        this.#explode(at, 8 + 4 * e.param, 140, 0.7, 'rock');
        this.events.emit('exploded', {
          ...at,
          kind: 'asteroid',
          size: e.param,
          slot: -1,
          points: 0,
        });
        break;
      case EVENT.COLLECTED:
        this.events.emit('collected', {
          ...at,
          type: PICKUP_NAMES[e.param] ?? 'shield',
          by: 'ship',
        });
        break;
      default:
        return assertNever(e.kind);
    }
  }

  #explode(
    pos: { x: number; y: number },
    count: number,
    speed: number,
    life: number,
    variant: 'rock' | 'ship',
  ): void {
    this.fx.spawn(
      new Explosion({
        pos: new Vector2(pos.x, pos.y),
        rng: this.#rng,
        count,
        speed,
        life,
        variant,
      }),
    );
  }

  // ===========================================================================================
  // what to draw
  // ===========================================================================================

  /** Server time (ms, in tick units) that is being shown right now. */
  #renderTime(now: number): number {
    if (!this.#clockSamples.length) return -Infinity;
    // The sample with the smallest (arrival - tickTime) is the packet that was delayed least,
    // so it is the best estimate of the server clock. (A min filter over the last 2 s.)
    let offset = Infinity;
    for (const c of this.#clockSamples) offset = Math.min(offset, c.offset);
    return now - offset - this.interpDelayMs;
  }

  /** For the netgraph: how old (ms) the picture of the other ships is. */
  get hud(): HudView {
    const m = this.meta;
    const effects: [EffectName, number][] = [];
    if (m.shield) effects.push(['shield', m.shield / 10]);
    if (m.rapid) effects.push(['rapid', m.rapid / 10]);
    if (m.homing) effects.push(['homing', m.homing / 10]);
    return {
      score: m.score,
      deaths: m.deaths,
      hp: m.hp,
      effects,
      respawnIn: m.alive ? 0 : m.respawn / 10,
    };
  }

  get ownPose(): ShipState | null {
    return this.own;
  }

  /**
   * Everything to draw this frame, as small objects drawEntity() understands.
   * alpha: how far we are between two client steps [0, 1).
   */
  view(alpha: number, now: number = this.now()): Drawable[] {
    // Lab 07: nothing is allocated here. `#out` and the objects in `#pool` live as long as the
    // game; the caller must not keep them after the frame (main.ts draws them straight away).
    const out = this.#out;
    out.length = 0;
    this.#pool.begin();
    this.#decayOffset(now);
    const latest = this.latest;
    if (latest) {
      this.#viewWorld(out, latest, alpha, now);
      this.#viewOwn(out, alpha);
    }
    for (const b of this.localBullets)
      out.push(
        this.#pool.bullet(
          0,
          b.x + b.vx * DT * alpha,
          b.y + b.vy * DT * alpha,
          b.angle,
          b.homing,
          BULLET.radius,
        ),
      );
    for (const e of this.fx) if (isKind(e, 'explosion')) out.push(e);
    return out;
  }

  #index(snap: Snapshot): SnapshotIndex {
    let index = this.#indexes.get(snap);
    if (!index) {
      index = {
        ships: new Map(snap.ships.map((e) => [e.slot, e])),
        bullets: new Map(snap.bullets.map((e) => [e.id, e])),
        asteroids: new Map(snap.asteroids.map((e) => [e.id, e])),
        pickups: new Map(snap.pickups.map((e) => [e.id, e])),
      };
      this.#indexes.set(snap, index);
    }
    return index;
  }

  #decayOffset(now: number): void {
    const dt = this.#offsetAt ? now - this.#offsetAt : 0;
    this.#offsetAt = now;
    const k = Math.exp(-dt / SMOOTH_TAU_MS);
    const x = this.offset.x * k;
    const y = this.offset.y * k;
    this.offset = Math.abs(x) < 0.01 && Math.abs(y) < 0.01 ? NO_OFFSET : { x, y };
  }

  #viewOwn(out: Drawable[], alpha: number): void {
    if (!this.own) return;
    const a = this.predict ? (this.prevOwn ?? this.own) : this.own;
    const b = this.own;
    const t = this.predict ? alpha : 1;
    const x = wrap(
      a.x + wrappedDelta(a.x, b.x, ARENA.width) * t + this.offset.x,
      ARENA.width,
    );
    const y = wrap(
      a.y + wrappedDelta(a.y, b.y, ARENA.height) * t + this.offset.y,
      ARENA.height,
    );
    const m = this.meta;
    const own = this.#pool.ship(
      this.slot,
      x,
      y,
      a.angle + angleDelta(a.angle, b.angle) * t,
      SHIP.radius,
    );
    own.thrust = b.thrust;
    own.invulnerable = m.invuln > 0;
    own.shield = m.shield > 0;
    own.rapid = m.rapid > 0;
    own.homing = m.homing > 0;
    out.push(own);
  }

  #viewWorld(out: Drawable[], latest: SnapshotEntry, alpha: number, now: number): void {
    // Pick the two snapshots around the render time (or just the newest one).
    let a = latest;
    let b = latest;
    let t = 0;
    const list = this.snapshots;
    const first = list[0];
    if (this.interp && first && list.length > 1) {
      const rt = this.#renderTime(now);
      if (rt >= latest.tickMs) {
        this.stats.extrapolating++; // we ran out of snapshots: hold the newest (no extrapolation)
      } else if (rt <= first.tickMs) {
        a = b = first;
      } else {
        for (let i = list.length - 1; i > 0; i--) {
          const older = list[i - 1];
          const newer = list[i];
          if (older && newer && older.tickMs <= rt) {
            a = older;
            b = newer;
            t = (rt - a.tickMs) / (b.tickMs - a.tickMs);
            break;
          }
        }
      }
    }
    const A = this.#index(a.snap);
    const B = b.snap;
    const pool = this.#pool;
    // blendX/blendY: functions at the bottom of the file (module level: no closure per frame).

    for (const e of B.ships) {
      const p = A.ships.get(e.slot);
      const s = pool.ship(
        e.slot,
        blendX(e.x, p ? p.x : e.x, t),
        blendY(e.y, p ? p.y : e.y, t),
        p ? p.angle + angleDelta(p.angle, e.angle) * t : e.angle,
        SHIP.radius,
      );
      s.thrust = e.thrust;
      s.invulnerable = e.invuln > 0;
      s.shield = e.shield > 0;
      out.push(s);
    }
    for (const e of B.bullets) {
      if (this.predict && e.slot === this.slot) continue; // mine: drawn below, from the newest
      const p = A.bullets.get(e.id);
      out.push(
        pool.bullet(
          e.id,
          blendX(e.x, p ? p.x : e.x, t),
          blendY(e.y, p ? p.y : e.y, t),
          Math.atan2(e.vy, e.vx),
          e.homing > 0,
          BULLET.radius,
        ),
      );
    }
    for (const e of B.asteroids) {
      const p = A.asteroids.get(e.id);
      out.push(
        pool.asteroid(
          e.id,
          blendX(e.x, p ? p.x : e.x, t),
          blendY(e.y, p ? p.y : e.y, t),
          e.size,
          e.hunter > 0,
        ),
      );
    }
    for (const e of B.pickups) {
      const p = A.pickups.get(e.id);
      out.push(
        pool.pickup(
          e.id,
          blendX(e.x, p ? p.x : e.x, t),
          blendY(e.y, p ? p.y : e.y, t),
          e.type,
        ),
      );
    }

    // My own bullets: the server's copy, from the NEWEST snapshot, moved forward by the time the
    // server has not seen yet (my unconfirmed inputs). That is where the bullet is "now" for me.
    if (this.predict) {
      const ahead = Math.max(0, this.pending.length - 1 + alpha) * DT;
      for (const e of latest.snap.bullets) {
        if (e.slot !== this.slot) continue;
        out.push(
          this.#pool.bullet(
            e.id,
            wrap(e.x + e.vx * ahead, ARENA.width),
            wrap(e.y + e.vy * ahead, ARENA.height),
            Math.atan2(e.vy, e.vx),
            e.homing > 0,
            BULLET.radius,
          ),
        );
      }
    }
  }

  // ===========================================================================================
  #rollStats(now: number): void {
    const s = this.stats;
    if (this.latest) {
      s.snapshotAge = now - this.latest.at;
      s.snapshotAgeMax = Math.max(s.snapshotAgeMax, s.snapshotAge);
    }
    if (now - this.#ageWindowAt > 100) {
      this.#ageWindowAt = now;
      this.#push(s.history.age, s.snapshotAge);
    }
    if (now - this.#corrWindowAt > 2000) {
      this.#corrWindowAt = now;
      s.correctionMax = s.correction; // the "max" is the max of the last ~2 s
      s.snapshotAgeMax = s.snapshotAge;
      s.rttMax = s.rtt;
      s.rttMin = s.rtt || Infinity;
    }
    const elapsed = now - this.#bytes.since;
    if (elapsed >= 1000) {
      s.bytesInPerSec = (this.#bytes.in * 1000) / elapsed;
      s.bytesOutPerSec = (this.#bytes.out * 1000) / elapsed;
      s.snapshotsPerSec = (this.#bytes.snaps * 1000) / elapsed;
      this.#bytes = { in: 0, out: 0, snaps: 0, since: now };
    }
  }
}

const EMPTY_META: Meta = {
  alive: false,
  hp: 0,
  shield: 0,
  rapid: 0,
  homing: 0,
  invuln: 0,
  score: 0,
  deaths: 0,
  respawn: 0,
};

// Position between the same thing in the older (o) and newer (n) snapshot. Plain functions that
// return a number: nothing is allocated (the object-returning `blend` closure it replaces was).
function blendX(n: number, o: number, t: number): number {
  return wrap(o + wrappedDelta(o, n, ARENA.width) * t, ARENA.width);
}
function blendY(n: number, o: number, t: number): number {
  return wrap(o + wrappedDelta(o, n, ARENA.height) * t, ARENA.height);
}
