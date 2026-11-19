import type { AsteroidSize, Particle, PickupType } from '@dogfight/shared/entities.ts';

/**
 * What the renderer needs to know about a thing it draws. These are INTERFACES, not classes:
 * the offline game hands over its real Ship / Bullet / ... objects (they have all of these
 * fields), the networked game hands over small plain objects built from a snapshot. The renderer
 * cannot tell the difference, and `kind` is the discriminant: `switch (e.kind)` narrows.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}
interface DrawableBase {
  id: number;
  pos: Point;
  prevPos: Point;
  angle: number;
  prevAngle: number;
  radius: number;
}
export type EffectName = 'shield' | 'rapid' | 'homing';

export interface DrawableShip extends DrawableBase {
  kind: 'ship';
  slot: number;
  thrust: number;
  readonly invulnerable: boolean;
  hasEffect(name: EffectName): boolean;
}
export interface DrawableBullet extends DrawableBase {
  kind: 'bullet';
  hasBehavior(name: string): boolean;
}
export interface DrawableAsteroid extends DrawableBase {
  kind: 'asteroid';
  size: AsteroidSize;
  hunter: boolean;
}
export interface DrawablePickup extends DrawableBase {
  kind: 'pickup';
  type: PickupType;
}
export interface DrawableExplosion extends DrawableBase {
  kind: 'explosion';
  variant: 'rock' | 'ship';
  particles: readonly Particle[];
}
export type Drawable =
  DrawableShip | DrawableBullet | DrawableAsteroid | DrawablePickup | DrawableExplosion;
