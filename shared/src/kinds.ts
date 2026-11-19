import type { Entity, EntityKind } from './entity.ts';
import type { Ship } from './ship.ts';
import type { Asteroid, Bullet, Explosion, Pickup } from './entities.ts';

/** Which class goes with which `kind`. Type-only imports: this file adds nothing at run time. */
export interface KindMap {
  ship: Ship;
  bullet: Bullet;
  asteroid: Asteroid;
  pickup: Pickup;
  explosion: Explosion;
}

/**
 * Type guard: `if (isKind(e, 'ship'))` narrows `e` to Ship. The subclasses each declare their
 * `kind` literal, so the check below is the whole proof; no cast is needed.
 */
export function isKind<K extends EntityKind>(
  entity: Entity,
  kind: K,
): entity is KindMap[K] {
  return entity.kind === kind;
}

/** What World.emit() carries. One union, discriminated by `type`. */
export type WorldEvent =
  | { type: 'fired'; entity: Bullet; by: Ship }
  | { type: 'hit'; target: Ship | Asteroid; by: Entity | null }
  | { type: 'collected'; entity: Pickup; by: Ship }
  | { type: 'destroyed'; entity: Entity; by: Entity | null };
