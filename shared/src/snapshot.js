import { SHIP } from './ship.js';

/** Cosmetic events that ride along with a snapshot (sound + particles in the browser). */
export const EVENT = Object.freeze({
  FIRED: 1,
  HIT_SHIP: 2,
  HIT_ROCK: 3,
  SHIP_DESTROYED: 4,
  ROCK_DESTROYED: 5, // param = asteroid size
  COLLECTED: 6, // param = pickup type index
});

export const PICKUP_INDEX = Object.freeze({ shield: 0, rapid: 1, homing: 2 });
export const PICKUP_NAMES = Object.freeze(['shield', 'rapid', 'homing']);

const tenths = (seconds) => Math.min(255, Math.max(0, Math.round(seconds * 10)));

/**
 * Plain-data picture of the world as ONE player should see it. This object is what the codec
 * packs (binary or JSON). Nothing in it is a class instance, so it survives any wire.
 *
 *   own        the player's own ship in FULL precision (the browser replays inputs from it)
 *   ships      the OTHER ships (quantised: they are only drawn, never simulated)
 *   ackSeq     the last input of this player that the server has applied
 */
export function captureSnapshot(game, { tick, slot, ackSeq, events = [] }) {
  const record = game.player(slot);
  const ship = record?.ship ?? null;
  const own = {
    alive: Boolean(ship),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    thrust: 0,
    cooldownMs: 0,
    hp: 0,
    shield: 0,
    rapid: 0,
    homing: 0,
    invuln: 0,
    score: record?.score ?? 0,
    deaths: record?.deaths ?? 0,
    respawn: tenths(record && !ship ? record.respawnIn : 0),
  };
  if (ship) {
    own.x = ship.pos.x;
    own.y = ship.pos.y;
    own.vx = ship.vel.x;
    own.vy = ship.vel.y;
    own.angle = ship.angle;
    own.thrust = ship.thrust;
    own.cooldownMs = Math.round(ship.cooldown * 1000);
    own.hp = ship.hp;
    own.shield = tenths(ship.effects.get('shield') ?? 0);
    own.rapid = tenths(ship.effects.get('rapid') ?? 0);
    own.homing = tenths(ship.effects.get('homing') ?? 0);
    own.invuln = tenths(ship.invulnerableLeft);
  }

  const ships = [];
  const bullets = [];
  const asteroids = [];
  const pickups = [];
  for (const e of game.world) {
    switch (e.kind) {
      case 'ship':
        if (e.slot !== slot)
          ships.push({
            slot: e.slot,
            x: e.pos.x,
            y: e.pos.y,
            angle: e.angle,
            thrust: e.thrust ? 1 : 0,
            invuln: e.invulnerable ? 1 : 0,
            shield: e.hasEffect('shield') ? 1 : 0,
            hp: e.hp,
          });
        break;
      case 'bullet':
        bullets.push({
          id: e.id,
          x: e.pos.x,
          y: e.pos.y,
          vx: e.vel.x,
          vy: e.vel.y,
          slot: e.ownerSlot,
          fireSeq: e.fireSeq,
          homing: e.hasBehavior('homing') ? 1 : 0,
        });
        break;
      case 'asteroid':
        asteroids.push({
          id: e.id,
          x: e.pos.x,
          y: e.pos.y,
          size: e.size,
          hunter: e.hunter ? 1 : 0,
        });
        break;
      case 'pickup':
        pickups.push({ id: e.id, x: e.pos.x, y: e.pos.y, type: PICKUP_INDEX[e.type] });
        break;
    }
  }
  return { tick, ackSeq, own, ships, bullets, asteroids, pickups, events };
}

export const MAX_HP = SHIP.maxHp;
