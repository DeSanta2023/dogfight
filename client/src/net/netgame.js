import { ARENA, angleDelta, wrap, wrappedDelta } from '@dogfight/shared/arena.js';
import { ASTEROID_RADIUS, BULLET, Explosion } from '@dogfight/shared/entities.js';
import {
  decodeServer,
  encodeInput,
  encodeInputJson,
  encodePing,
  encodePingJson,
} from '@dogfight/shared/codec.js';
import { BIT, DT, inputFromBits } from '@dogfight/shared/input.js';
import { createRng } from '@dogfight/shared/rng.js';
import { SHIP, integrate } from '@dogfight/shared/ship.js';
import { EVENT, PICKUP_NAMES } from '@dogfight/shared/snapshot.js';
import { Vector2 } from '@dogfight/shared/vector.js';
import { World } from '@dogfight/shared/world.js';
import { Conditioner } from './conditioner.js';

const REDUNDANCY = 8; // every packet repeats the last 8 inputs: one lost packet costs nothing
const MAX_PENDING = 120; // 4 s of unconfirmed input: the server is gone, stop remembering
const SNAP_DISTANCE = 120; // a correction bigger than this is a teleport, not a drift: no smoothing
const SMOOTH_TAU_MS = 33; // the correction fades with this time constant: ~95 % gone in 100 ms
const CLOCK_WINDOW_MS = 2000;
const PING_EVERY_MS = 1000;
const MAX_SNAPSHOTS = 40;

const noEffect = () => false;

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
  events = new EventTarget(); // 'fired' | 'hit' | 'exploded' | 'collected' | 'ownhit' like Game
  fx = new World(); // explosion particles: decoration made here, never replicated

  // --- own ship ---
  own = null; // predicted state { x, y, vx, vy, angle, thrust } or null (dead / no snapshot yet)
  prevOwn = null;
  meta = {
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
  pending = []; // inputs not yet confirmed: { seq, bits }
  seq = 0;
  cooldown = 0;
  localBullets = [];
  offset = { x: 0, y: 0 }; // what the correction still owes the screen
  #offsetAt = 0;

  // --- world from the server ---
  snapshots = []; // { tick, tickMs, at, snap }, oldest first
  latest = null;
  lastTick = -1;
  #clockSamples = []; // { at, offset }
  #queuedEvents = [];
  #rng = createRng(0xf1ee7);
  #lastPing = -Infinity;

  // --- numbers for the netgraph ---
  stats = {
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
  }) {
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

  #send;

  // ===========================================================================================
  // outgoing
  // ===========================================================================================

  /** One fixed client step (30 per second, same DT as the server): read input, predict, send. */
  step(bits) {
    const now = this.now();
    this.seq++;
    this.pending.push({ seq: this.seq, bits });
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    if (this.predict && this.own) {
      this.prevOwn = this.own;
      this.own = integrate(this.own, inputFromBits(bits), DT);
      this.cooldown = Math.max(0, this.cooldown - DT);
      if (bits & BIT.FIRE && this.cooldown <= 0) this.#fireLocal();
    }
    this.#stepLocalBullets();
    this.fx.step(DT);
    this.#releaseEvents(now);

    // Redundancy: the packet carries the newest input and up to 7 older, still unconfirmed ones.
    const from = Math.max(0, this.pending.length - REDUNDANCY);
    const slice = this.pending.slice(from);
    this.#transmit(
      this.format === 'json'
        ? encodeInputJson(
            slice[0].seq,
            slice.map((p) => p.bits),
          )
        : encodeInput(
            slice[0].seq,
            slice.map((p) => p.bits),
          ),
    );
    if (now - this.#lastPing >= PING_EVERY_MS) {
      this.#lastPing = now;
      this.#transmit(this.format === 'json' ? encodePingJson(now) : encodePing(now));
    }
    this.#rollStats(now);
  }

  #transmit(data) {
    this.#bytes.out += typeof data === 'string' ? data.length : data.byteLength;
    this.conditioner.deliver(() => this.#send(data));
  }

  #fireLocal() {
    const rapid = this.meta.rapid > 0;
    this.cooldown = rapid ? SHIP.rapidCooldown : SHIP.fireCooldown;
    const o = this.own;
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
    this.events.dispatchEvent(
      new CustomEvent('fired', {
        detail: { x: o.x, y: o.y, by: 'ship', slot: this.slot },
      }),
    );
  }

  #stepLocalBullets() {
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
  receive(data, size) {
    this.#bytes.in += size;
    this.conditioner.deliver(() => this.#handle(data, size));
  }

  #handle(data) {
    let message;
    try {
      message = data instanceof ArrayBuffer ? decodeServer(data) : data;
    } catch {
      return; // a damaged frame is just a lost frame
    }
    if (message.type === 'snapshot' || message.type === 'snap') this.#onSnapshot(message);
    else if (message.type === 'pong') this.#onPong(message);
  }

  #onPong({ t }) {
    const rtt = this.now() - t;
    const s = this.stats;
    s.rtt = s.rtt ? s.rtt * 0.8 + rtt * 0.2 : rtt;
    s.rttMin = Math.min(s.rttMin, rtt);
    s.rttMax = Math.max(s.rttMax, rtt);
    this.#push(s.history.rtt, rtt);
  }

  #push(list, value) {
    list.push(value);
    if (list.length > 90) list.shift();
  }

  #onSnapshot(snap) {
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
    while (this.#clockSamples[0].at < now - CLOCK_WINDOW_MS) this.#clockSamples.shift();
    const entry = { tick: snap.tick, tickMs, at: now, snap };
    this.snapshots.push(entry);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    this.latest = entry;

    for (const e of snap.events ?? []) this.#queuedEvents.push({ tickMs, ...e });

    // Confirmed inputs are forgotten.
    while (this.pending.length && this.pending[0].seq <= snap.ackSeq)
      this.pending.shift();
    this.localBullets = this.localBullets.filter((b) => b.seq > snap.ackSeq);

    const o = snap.own;
    if (o.alive && this.meta.alive && o.hp < this.meta.hp)
      this.events.dispatchEvent(new CustomEvent('ownhit'));
    this.meta = { ...o };

    if (!o.alive) {
      this.own = this.prevOwn = null;
      this.localBullets = [];
      this.offset = { x: 0, y: 0 };
      return;
    }
    const server = {
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

    if (magnitude > SNAP_DISTANCE) {
      this.offset = { x: 0, y: 0 }; // teleport (respawn, a collision knock): just be there
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
  #releaseEvents(now) {
    if (!this.#queuedEvents.length) return;
    const due = this.interp ? this.#renderTime(now) : Infinity;
    const rest = [];
    for (const e of this.#queuedEvents) {
      if (e.tickMs > due) rest.push(e);
      else this.#playEvent(e);
    }
    this.#queuedEvents = rest;
  }

  #playEvent(e) {
    const emit = (type, detail) =>
      this.events.dispatchEvent(new CustomEvent(type, { detail }));
    const at = { x: e.x, y: e.y };
    switch (e.kind) {
      case EVENT.FIRED:
        // My own shots were already heard when I pressed the key.
        if (!(this.predict && e.param === this.slot))
          emit('fired', { ...at, by: 'ship', slot: e.param });
        break;
      case EVENT.HIT_SHIP:
        emit('hit', { ...at, target: 'ship', own: false });
        break;
      case EVENT.HIT_ROCK:
        emit('hit', { ...at, target: 'asteroid' });
        break;
      case EVENT.SHIP_DESTROYED:
        this.#explode(at, 30, 260, 1, 'ship');
        emit('exploded', { ...at, kind: 'ship', points: 0 });
        break;
      case EVENT.ROCK_DESTROYED:
        this.#explode(at, 8 + 4 * e.param, 140, 0.7, 'rock');
        emit('exploded', { ...at, kind: 'asteroid', size: e.param, points: 0 });
        break;
      case EVENT.COLLECTED:
        emit('collected', { ...at, type: PICKUP_NAMES[e.param] ?? 'shield' });
        break;
    }
  }

  #explode(pos, count, speed, life, variant) {
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
  #renderTime(now) {
    if (!this.#clockSamples.length) return -Infinity;
    // The sample with the smallest (arrival - tickTime) is the packet that was delayed least,
    // so it is the best estimate of the server clock. (A min filter over the last 2 s.)
    let offset = Infinity;
    for (const c of this.#clockSamples) offset = Math.min(offset, c.offset);
    return now - offset - this.interpDelayMs;
  }

  /** For the netgraph: how old (ms) the picture of the other ships is. */
  get hud() {
    const m = this.meta;
    const effects = [];
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

  get ownPose() {
    return this.own;
  }

  /**
   * Everything to draw this frame, as small objects drawEntity() understands.
   * alpha: how far we are between two client steps [0, 1).
   */
  view(alpha, now = this.now()) {
    const out = [];
    this.#decayOffset(now);
    const latest = this.latest;
    if (latest) {
      this.#viewWorld(out, latest, alpha, now);
      this.#viewOwn(out, alpha);
    }
    for (const b of this.localBullets)
      out.push(
        entity('bullet', 0, b.x + b.vx * DT * alpha, b.y + b.vy * DT * alpha, b.angle, {
          radius: BULLET.radius,
          homing: b.homing,
        }),
      );
    for (const e of this.fx) out.push(e);
    return out;
  }

  #decayOffset(now) {
    const dt = this.#offsetAt ? now - this.#offsetAt : 0;
    this.#offsetAt = now;
    const k = Math.exp(-dt / SMOOTH_TAU_MS);
    this.offset.x *= k;
    this.offset.y *= k;
    if (Math.abs(this.offset.x) < 0.01 && Math.abs(this.offset.y) < 0.01)
      this.offset = { x: 0, y: 0 };
  }

  #viewOwn(out, alpha) {
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
    out.push(
      entity('ship', 1000 + this.slot, x, y, a.angle + angleDelta(a.angle, b.angle) * t, {
        radius: SHIP.radius,
        slot: this.slot,
        thrust: b.thrust,
        invulnerable: m.invuln > 0,
        hasEffect: (name) => (m[name] ?? 0) > 0,
        mine: true,
      }),
    );
  }

  #viewWorld(out, latest, alpha, now) {
    // Pick the two snapshots around the render time (or just the newest one).
    let a = latest;
    let b = latest;
    let t = 0;
    if (this.interp && this.snapshots.length > 1) {
      const rt = this.#renderTime(now);
      const list = this.snapshots;
      if (rt >= list.at(-1).tickMs) {
        this.stats.extrapolating++; // we ran out of snapshots: hold the newest (no extrapolation)
        a = b = list.at(-1);
      } else if (rt <= list[0].tickMs) {
        a = b = list[0];
      } else {
        for (let i = list.length - 1; i > 0; i--) {
          if (list[i - 1].tickMs <= rt) {
            a = list[i - 1];
            b = list[i];
            t = (rt - a.tickMs) / (b.tickMs - a.tickMs);
            break;
          }
        }
      }
    }
    const A = a.snap;
    const B = b.snap;
    const lerp = (list, prevList, key, make) => {
      const prev = new Map(prevList.map((e) => [e[key], e]));
      for (const e of list) {
        const p = prev.get(e[key]) ?? e;
        out.push(
          make(e, {
            x: wrap(p.x + wrappedDelta(p.x, e.x, ARENA.width) * t, ARENA.width),
            y: wrap(p.y + wrappedDelta(p.y, e.y, ARENA.height) * t, ARENA.height),
            angle: p.angle === undefined ? 0 : p.angle + angleDelta(p.angle, e.angle) * t,
          }),
        );
      }
    };

    lerp(B.ships, A.ships, 'slot', (e, p) =>
      entity('ship', 1000 + e.slot, p.x, p.y, p.angle, {
        radius: SHIP.radius,
        slot: e.slot,
        thrust: e.thrust,
        invulnerable: Boolean(e.invuln),
        hasEffect: (name) => name === 'shield' && Boolean(e.shield),
      }),
    );
    lerp(
      B.bullets.filter((e) => !(this.predict && e.slot === this.slot)),
      A.bullets,
      'id',
      (e, p) =>
        entity('bullet', e.id, p.x, p.y, Math.atan2(e.vy, e.vx), {
          radius: BULLET.radius,
          homing: Boolean(e.homing),
        }),
    );
    lerp(B.asteroids, A.asteroids, 'id', (e, p) =>
      entity('asteroid', e.id, p.x, p.y, 0, {
        radius: ASTEROID_RADIUS[e.size] ?? 26,
        size: e.size,
        hunter: Boolean(e.hunter),
      }),
    );
    lerp(B.pickups, A.pickups, 'id', (e, p) =>
      entity('pickup', e.id, p.x, p.y, 0, { radius: 14, type: PICKUP_NAMES[e.type] }),
    );

    // My own bullets: the server's copy, from the NEWEST snapshot, moved forward by the time the
    // server has not seen yet (my unconfirmed inputs). That is where the bullet is "now" for me.
    if (this.predict) {
      const ahead = Math.max(0, this.pending.length - 1 + alpha) * DT;
      for (const e of latest.snap.bullets) {
        if (e.slot !== this.slot) continue;
        out.push(
          entity(
            'bullet',
            e.id,
            wrap(e.x + e.vx * ahead, ARENA.width),
            wrap(e.y + e.vy * ahead, ARENA.height),
            Math.atan2(e.vy, e.vx),
            { radius: BULLET.radius, homing: Boolean(e.homing) },
          ),
        );
      }
    }
  }

  // ===========================================================================================
  #rollStats(now) {
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

/** A tiny stand-in for an Entity, with just what drawEntity() and the sprites read. */
function entity(kind, id, x, y, angle, props) {
  const pos = { x, y };
  return {
    kind,
    id,
    pos,
    prevPos: pos,
    angle,
    prevAngle: angle,
    thrust: 0,
    invulnerable: false,
    hasEffect: noEffect,
    hasBehavior: (name) => name === 'homing' && Boolean(props.homing),
    ...props,
  };
}
