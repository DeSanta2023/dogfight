/**
 * Immutable 2D vector. Every method is pure: it returns a NEW Vector2 and never changes
 * `this` or its argument. `readonly` makes that a compile-time rule, and the instances are
 * also frozen, so a JavaScript caller that ignores the types still cannot change one.
 *
 * Trade-off: one small allocation per operation. For a few dozen entities at 30 steps/s that is
 * irrelevant; Lab 7 will profile it and decide whether hot paths need in-place variants.
 */
export class Vector2 {
  static readonly ZERO = new Vector2(0, 0);

  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  /** Direction of the vector in radians, atan2(y, x). */
  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  distanceTo(v: Vector2): number {
    return this.sub(v).length();
  }

  equals(v: Vector2): boolean {
    return this.x === v.x && this.y === v.y;
  }
}
