/**
 * Immutable 2D vector. Every method is pure: it returns a NEW Vector2 and never changes
 * `this` or its argument (instances are frozen, so an accidental `v.x += 1` throws in strict mode).
 *
 * Trade-off: one small allocation per operation. For a few dozen entities at 60 steps/s that is
 * irrelevant; Lab 7 will profile it and decide whether hot paths need in-place variants.
 */
export class Vector2 {
  static ZERO = new Vector2(0, 0);

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : this.scale(1 / len);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  /** Direction of the vector in radians, atan2(y, x). */
  angle() {
    return Math.atan2(this.y, this.x);
  }

  distanceTo(v) {
    return this.sub(v).length();
  }

  equals(v) {
    return this.x === v.x && this.y === v.y;
  }
}
