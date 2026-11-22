import { isKind } from './kinds.ts';
import { SHIP } from './ship.ts';
import { PICKUP_TYPES, type AsteroidSize, type PickupType } from './entities.ts';
import type { EntityId, Seq, Tick } from './brand.ts';
import type { Game } from './game.ts';

/** Cosmetic events that ride along with a snapshot (sound + particles in the browser). */
export const EVENT = Object.freeze({
  FIRED: 1,
  HIT_SHIP: 2,
  HIT_ROCK: 3,
  SHIP_DESTROYED: 4,
  ROCK_DESTROYED: 5, // param = asteroid size
  COLLECTED: 6, // param = pickup type index
});
export type EventKind = (typeof EVENT)[keyof typeof EVENT];

/** Pickup type <-> its number on the wire. The array's order IS the wire format. */
export const PICKUP_NAMES: readonly PickupType[] = PICKUP_TYPES;

export interface WireEvent {
  kind: EventKind;
  param: number;
  x: number;
  y: number;
}

// ---- the player's own ship: full precision, because the browser re-simulates from it ----------
interface OwnBase {
  score: number;
  deaths: number;
  respawn: number; // tenths of a second until the respawn
}
export interface OwnAlive extends OwnBase {
  alive: true;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  thrust: number;
  cooldownMs: number;
  hp: number;
  shield: number; // effect time left, tenths of a second
  rapid: number;
  homing: number;
  invuln: number;
}
export interface OwnDead extends OwnBase {
  alive: false;
}
/** `alive` is the discriminant: `x` exists only after you have checked it. */
export type Own = OwnAlive | OwnDead;

// ---- everything else: quantised, only drawn. `kind` tells the entities apart --------------------
export interface ShipView {
  kind: 'ship';
  slot: number;
  x: number;
  y: number;
  angle: number;
  thrust: number;
  invuln: number;
  shield: number;
  hp: number;
}
export interface BulletView {
  kind: 'bullet';
  id: EntityId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  slot: number;
  /** Low 16 bits of the input number that fired it (so NOT a Seq: it wraps). */
  fireSeq: number;
  homing: number;
}
export interface AsteroidView {
  kind: 'asteroid';
  id: EntityId;
  x: number;
  y: number;
  size: AsteroidSize;
  hunter: number;
}
export interface PickupView {
  kind: 'pickup';
  id: EntityId;
  x: number;
  y: number;
  type: PickupType;
}
export type SnapshotEntity = ShipView | BulletView | AsteroidView | PickupView;

/**
 * Plain-data picture of the world as ONE player should see it. This object is what the codec
 * packs (binary or JSON). Nothing in it is a class instance, so it survives any wire.
 *
 *   own        the player's own ship in FULL precision (the browser replays inputs from it)
 *   ships      the OTHER ships (quantised: they are only drawn, never simulated)
 *   ackSeq     the last input of this player that the server has applied
 */
export interface Snapshot {
  tick: Tick;
  ackSeq: Seq;
  own: Own;
  ships: ShipView[];
  bullets: BulletView[];
  asteroids: AsteroidView[];
  pickups: PickupView[];
  events: WireEvent[];
}

const tenths = (seconds: number): number =>
  Math.min(255, Math.max(0, Math.round(seconds * 10)));

export interface CaptureOptions {
  tick: Tick;
  slot: number;
  ackSeq: Seq;
  events?: WireEvent[];
}

/** Read the game (never write it) and describe it for player `slot`. */
export function captureSnapshot(
  game: Game,
  { tick, slot, ackSeq, events = [] }: CaptureOptions,
): Snapshot {
  const record = game.player(slot);
  const ship = record?.ship ?? null;
  const base = {
    score: record?.score ?? 0,
    deaths: record?.deaths ?? 0,
    respawn: tenths(record && !ship ? record.respawnIn : 0),
  };
  const own: Own = ship
    ? {
        ...base,
        alive: true,
        x: ship.pos.x,
        y: ship.pos.y,
        vx: ship.vel.x,
        vy: ship.vel.y,
        angle: ship.angle,
        thrust: ship.thrust,
        cooldownMs: Math.round(ship.cooldown * 1000),
        hp: ship.hp,
        shield: tenths(ship.effects.get('shield') ?? 0),
        rapid: tenths(ship.effects.get('rapid') ?? 0),
        homing: tenths(ship.effects.get('homing') ?? 0),
        invuln: tenths(ship.invulnerableLeft),
      }
    : { ...base, alive: false };

  const ships: ShipView[] = [];
  const bullets: BulletView[] = [];
  const asteroids: AsteroidView[] = [];
  const pickups: PickupView[] = [];
  for (const e of game.world.liveEntities()) {
    if (isKind(e, 'ship')) {
      if (e.slot !== slot)
        ships.push({
          kind: 'ship',
          slot: e.slot,
          x: e.pos.x,
          y: e.pos.y,
          angle: e.angle,
          thrust: e.thrust ? 1 : 0,
          invuln: e.invulnerable ? 1 : 0,
          shield: e.hasEffect('shield') ? 1 : 0,
          hp: e.hp,
        });
    } else if (isKind(e, 'bullet')) {
      bullets.push({
        kind: 'bullet',
        id: e.id,
        x: e.pos.x,
        y: e.pos.y,
        vx: e.vel.x,
        vy: e.vel.y,
        slot: e.ownerSlot,
        fireSeq: e.fireSeq,
        homing: e.hasBehavior('homing') ? 1 : 0,
      });
    } else if (isKind(e, 'asteroid')) {
      asteroids.push({
        kind: 'asteroid',
        id: e.id,
        x: e.pos.x,
        y: e.pos.y,
        size: e.size,
        hunter: e.hunter ? 1 : 0,
      });
    } else if (isKind(e, 'pickup')) {
      pickups.push({ kind: 'pickup', id: e.id, x: e.pos.x, y: e.pos.y, type: e.type });
    }
    // explosions are decoration: the server does not even create them (cosmetics: false)
  }
  return { tick, ackSeq, own, ships, bullets, asteroids, pickups, events };
}

export const MAX_HP = SHIP.maxHp;
