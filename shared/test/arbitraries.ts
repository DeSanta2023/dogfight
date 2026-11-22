// fast-check generators for the game's own data: snapshots, input lists, entity circles.
import fc from 'fast-check';
import { ARENA } from '../src/arena.ts';
import { entityId, seq, tick } from '../src/brand.ts';
import { EVENT, PICKUP_NAMES, type Snapshot } from '../src/snapshot.ts';

const x = fc.double({ min: 0, max: ARENA.width, noNaN: true });
const y = fc.double({ min: 0, max: ARENA.height, noNaN: true });
const flag = fc.constantFrom(0, 1);
const u8 = fc.integer({ min: 0, max: 255 });
const u16 = fc.integer({ min: 0, max: 65535 });
/** Any angle the simulation can produce (and then some): the codec must wrap it itself. */
const angle = fc.double({ min: -20, max: 20, noNaN: true });

export const shipView = fc.record({
  kind: fc.constant('ship' as const),
  slot: u8,
  x,
  y,
  angle,
  thrust: flag,
  invuln: flag,
  shield: flag,
  hp: u8,
});
export const bulletView = fc.record({
  kind: fc.constant('bullet' as const),
  id: u16.map(entityId),
  x,
  y,
  vx: fc.integer({ min: -700, max: 700 }),
  vy: fc.integer({ min: -700, max: 700 }),
  slot: u8,
  fireSeq: u16,
  homing: flag,
});
export const asteroidView = fc.record({
  kind: fc.constant('asteroid' as const),
  id: u16.map(entityId),
  x,
  y,
  size: fc.constantFrom(1 as const, 2 as const, 3 as const),
  hunter: flag,
});
export const pickupView = fc.record({
  kind: fc.constant('pickup' as const),
  id: u16.map(entityId),
  x,
  y,
  type: fc.constantFrom(...PICKUP_NAMES),
});
export const wireEvent = fc.record({
  kind: fc.constantFrom(...Object.values(EVENT)),
  param: fc.integer({ min: 0, max: 15 }),
  x,
  y,
});

const ownDead = fc.record({
  alive: fc.constant(false as const),
  score: fc.integer({ min: 0, max: 1_000_000 }),
  deaths: u16,
  respawn: u8,
});
const ownAlive = fc.record({
  alive: fc.constant(true as const),
  x,
  y,
  vx: fc.double({ min: -700, max: 700, noNaN: true }),
  vy: fc.double({ min: -700, max: 700, noNaN: true }),
  angle,
  thrust: flag,
  cooldownMs: u16,
  hp: u8,
  shield: u8,
  rapid: u8,
  homing: u8,
  invuln: u8,
  score: fc.integer({ min: 0, max: 1_000_000 }),
  deaths: u16,
  respawn: u8,
});

/** A whole snapshot, with 0..max entities of each kind. */
export const snapshot = (max = 12): fc.Arbitrary<Snapshot> =>
  fc.record({
    tick: fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(tick),
    ackSeq: fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(seq),
    own: fc.oneof(ownDead, ownAlive),
    ships: fc.array(shipView, { maxLength: max }),
    bullets: fc.array(bulletView, { maxLength: max }),
    asteroids: fc.array(asteroidView, { maxLength: max }),
    pickups: fc.array(pickupView, { maxLength: max }),
    events: fc.array(wireEvent, { maxLength: max }),
  });

/** A list of keyboard states: 4 bits each (LEFT, RIGHT, THRUST, FIRE). */
export const inputBits = (maxLength = 300) =>
  fc.array(fc.integer({ min: 0, max: 15 }), { maxLength });

/** A circle like the ones the collision system gets. */
export const circle = fc.record({
  solid: fc.constant(true),
  radius: fc.constantFrom(3, 12, 14, 16, 26, 40),
  pos: fc.record({ x, y }),
});
