// Property-based tests (fast-check): instead of 3 hand-picked examples, hundreds of random inputs
// per property, and a SHRUNK counter-example when one fails. Each run prints its seed; to replay a
// failure: fc.assert(property, { seed: <seed>, path: '<path>' }).
import { expect, test } from 'vitest';
import fc from 'fast-check';
import { ARENA, angleDelta } from '../src/arena.ts';
import {
  DecodeError,
  angleToInt16,
  decodeClient,
  decodeServer,
  encodeInput,
  encodeSnapshot,
  int16ToAngle,
} from '../src/codec.ts';
import { Game } from '../src/game.ts';
import { DT, inputFromBits } from '../src/input.ts';
import {
  asteroidView,
  bulletView,
  inputBits,
  pickupView,
  shipView,
  snapshot,
} from './arbitraries.ts';
import { seq } from '../src/brand.ts';

const QUANT_X = ARENA.width / 65535; // positions are u16 over the arena
const QUANT_Y = ARENA.height / 65535;
const QUANT_ANGLE = Math.PI / 32767; // angles are Int16 over [-pi, pi)

/** The size the format description (README, "Binary format") promises for a snapshot. */
function expectedBytes(s: ReturnType<typeof decodeSnapshot>): number {
  const fixed =
    10 /* ver, type, tick, ackSeq */ +
    1 /* alive flag */ +
    7 /* score, deaths, respawn */ +
    5; /* five counts */
  return (
    fixed +
    (s.own.alive ? 48 : 0) +
    9 * s.ships.length +
    14 * s.bullets.length +
    7 * s.asteroids.length +
    7 * s.pickups.length +
    5 * s.events.length
  );
}
function decodeSnapshot(buffer: ArrayBuffer) {
  const message = decodeServer(buffer);
  if (message.type !== 'snapshot') throw new Error('not a snapshot');
  return message;
}

test('property: decode(encode(snapshot)) gives the snapshot back, up to the rounding the format promises', () => {
  fc.assert(
    fc.property(snapshot(), (original) => {
      const back = decodeSnapshot(encodeSnapshot(original));

      expect(back.tick).toBe(original.tick);
      expect(back.ackSeq).toBe(original.ackSeq);
      expect(back.own).toEqual(original.own); // own ship: float64, bit-exact
      expect(back.ships).toHaveLength(original.ships.length);
      original.ships.forEach((s, i) => {
        const b = back.ships[i]!;
        expect(b.slot).toBe(s.slot);
        expect(Math.abs(b.x - s.x)).toBeLessThanOrEqual(QUANT_X / 2 + 1e-9);
        expect(Math.abs(b.y - s.y)).toBeLessThanOrEqual(QUANT_Y / 2 + 1e-9);
        // The ANGLE is rounded to 1/32767 of pi AND wrapped: compare on the circle, not on the line.
        expect(Math.abs(angleDelta(s.angle, b.angle))).toBeLessThanOrEqual(
          QUANT_ANGLE / 2 + 1e-9,
        );
        expect([b.thrust, b.invuln, b.shield, b.hp]).toEqual([
          s.thrust,
          s.invuln,
          s.shield,
          s.hp,
        ]);
      });
      expect(
        back.bullets.map((b) => [b.id, b.vx, b.vy, b.slot, b.fireSeq, b.homing]),
      ).toEqual(
        original.bullets.map((b) => [b.id, b.vx, b.vy, b.slot, b.fireSeq, b.homing]),
      );
      expect(back.asteroids.map((a) => [a.id, a.size, a.hunter])).toEqual(
        original.asteroids.map((a) => [a.id, a.size, a.hunter]),
      );
      expect(back.pickups.map((p) => [p.id, p.type])).toEqual(
        original.pickups.map((p) => [p.id, p.type]),
      );
      expect(back.events.map((e) => [e.kind, e.param])).toEqual(
        original.events.map((e) => [e.kind, e.param]),
      );
    }),
    { numRuns: 300 },
  );
});

test('property: an angle survives the Int16 round trip to within half a step, whatever the input', () => {
  fc.assert(
    fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (a) => {
      const back = int16ToAngle(angleToInt16(a));
      expect(Math.abs(angleDelta(a, back))).toBeLessThanOrEqual(QUANT_ANGLE / 2 + 1e-9);
      expect(angleToInt16(a)).toBeGreaterThanOrEqual(-32767);
      expect(angleToInt16(a)).toBeLessThanOrEqual(32767);
    }),
    { numRuns: 500 },
  );
});

test('property: the length of an encoded frame is exactly what the format description says', () => {
  fc.assert(
    fc.property(snapshot(20), (s) => {
      const bytes = encodeSnapshot(s);
      expect(bytes.byteLength).toBe(expectedBytes(decodeSnapshot(bytes)));
      // ...and from the INPUT side: header + fixed part + 9/14/7/7/5 bytes per entity.
      expect(bytes.byteLength).toBe(
        23 +
          (s.own.alive ? 48 : 0) +
          9 * s.ships.length +
          14 * s.bullets.length +
          7 * s.asteroids.length +
          7 * s.pickups.length +
          5 * s.events.length,
      );
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2 ** 32 - 2 }),
      fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 1, maxLength: 32 }),
      (first, bits) => {
        expect(encodeInput(first, bits).byteLength).toBe(7 + bits.length); // 7 bytes + 1 per input
      },
    ),
  );
});

test('property: a corrupted buffer gives a DecodeError, never another kind of crash', () => {
  fc.assert(
    fc.property(
      snapshot(6),
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }),
      fc.option(fc.nat(), { nil: undefined }),
      (s, flips, cut) => {
        const bytes = new Uint8Array(encodeSnapshot(s));
        for (const [at, value] of flips) bytes[at % bytes.length] = value; // overwrite random bytes
        const damaged = cut === undefined ? bytes : bytes.slice(0, cut % bytes.length); // maybe truncate
        try {
          decodeServer(damaged); // damage may hit a harmless byte: decoding may succeed...
        } catch (error) {
          expect(error).toBeInstanceOf(DecodeError); // ...but if it fails it fails like THIS
        }
      },
    ),
    { numRuns: 500 },
  );
});

test('property: random garbage of any length is rejected cleanly (client and server decoders)', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 300 }), (garbage) => {
      for (const decode of [decodeServer, decodeClient]) {
        try {
          decode(garbage);
        } catch (error) {
          expect(error).toBeInstanceOf(DecodeError);
        }
      }
    }),
    { numRuns: 1000 },
  );
});

test('property: a client input packet round-trips, and its seq numbers are consecutive', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2 ** 32 - 40 }),
      fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 1, maxLength: 32 }),
      (first, bits) => {
        const message = decodeClient(encodeInput(first, bits));
        expect(message).toEqual({ type: 'input', seq: seq(first), bits });
      },
    ),
  );
});

test('property: whatever keys are pressed, a ship never leaves the arena and speed stays bounded', () => {
  fc.assert(
    fc.property(inputBits(400), fc.integer({ min: 1, max: 1000 }), (bitsList, seed) => {
      const game = new Game({ seed, asteroids: 0, pickups: false });
      for (const bits of bitsList) {
        game.step(DT, inputFromBits(bits));
        const ship = game.ship;
        if (!ship) continue;
        expect(ship.pos.x).toBeGreaterThanOrEqual(0);
        expect(ship.pos.x).toBeLessThan(ARENA.width);
        expect(ship.pos.y).toBeGreaterThanOrEqual(0);
        expect(ship.pos.y).toBeLessThan(ARENA.height);
        expect(Math.hypot(ship.vel.x, ship.vel.y)).toBeLessThanOrEqual(686 + 1e-6);
      }
    }),
    { numRuns: 100 },
  );
});

test('property: the same seed and the same inputs give the same world, twice (determinism)', () => {
  const run = (seed: number, bitsList: number[]) => {
    const game = new Game({ seed, players: 2, asteroids: 6 });
    const inputs = new Map();
    for (const bits of bitsList) {
      inputs.set(0, inputFromBits(bits));
      inputs.set(1, inputFromBits((bits * 7 + 3) & 15));
      game.stepInputs(DT, inputs);
    }
    return JSON.stringify(
      [...game.world].map((e) => [e.kind, e.id, e.pos.x, e.pos.y, e.vel.x, e.vel.y]),
    );
  };
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 99999 }), inputBits(250), (seed, bitsList) => {
      expect(run(seed, bitsList)).toBe(run(seed, bitsList));
    }),
    { numRuns: 40 },
  );
});

test('property: every entity kind keeps its wire fields inside the ranges the format has bits for', () => {
  fc.assert(
    fc.property(
      shipView,
      bulletView,
      asteroidView,
      pickupView,
      (ship, bullet, rock, pickup) => {
        const s = decodeSnapshot(
          encodeSnapshot({
            tick: 1 as never,
            ackSeq: 1 as never,
            own: { alive: false, score: 0, deaths: 0, respawn: 0 },
            ships: [ship],
            bullets: [bullet],
            asteroids: [rock],
            pickups: [pickup],
            events: [],
          }),
        );
        expect(s.ships[0]!.x).toBeGreaterThanOrEqual(0);
        expect(s.ships[0]!.x).toBeLessThanOrEqual(ARENA.width);
        expect(s.bullets[0]!.slot).toBe(bullet.slot);
        expect(s.asteroids[0]!.size).toBe(rock.size);
        expect(s.pickups[0]!.type).toBe(pickup.type);
      },
    ),
  );
});
