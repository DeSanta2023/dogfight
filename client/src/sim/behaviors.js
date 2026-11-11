import { Vector2 } from './vector.js';
import { angleDelta } from './arena.js';

/**
 * Behaviors are small, independent capabilities attached to ANY entity
 * (`entity.addBehavior(...)`). They are plain objects with `update(entity, dt, world)`.
 * This is the composition alternative to a `HomingBullet`/`HomingAsteroid` class hierarchy.
 */

/**
 * Steer the velocity toward the nearest entity of `targetKind` within `range`,
 * turning at most `turnRate` rad/s and keeping the current speed.
 */
export function homing({ targetKind, turnRate = 3, range = 450 }) {
  return {
    name: 'homing',
    update(entity, dt, world) {
      if (!world) return;
      const speed = entity.vel.length();
      if (speed === 0) return;

      let target = null;
      let bestSq = range * range;
      for (const candidate of world.ofKind(targetKind)) {
        const dSq = candidate.pos.sub(entity.pos).lengthSq();
        if (dSq < bestSq) {
          bestSq = dSq;
          target = candidate;
        }
      }
      if (!target) return;

      const heading = entity.vel.angle();
      const wanted = target.pos.sub(entity.pos).angle();
      const maxTurn = turnRate * dt;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDelta(heading, wanted)));

      entity.vel = Vector2.fromAngle(heading + turn, speed);
      entity.angle = heading + turn;
    },
  };
}
