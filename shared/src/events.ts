import type { EntityKind } from './entity.ts';
import type { PickupType } from './entities.ts';

/**
 * Everything the simulation announces, and the exact shape of each announcement. The browser's
 * audio, HUD and effects subscribe to these; the simulation imports none of them.
 */
export interface GameEventMap {
  fired: { x: number; y: number; by: EntityKind; slot: number };
  hit: { x: number; y: number; target: EntityKind; slot: number; by: EntityKind | null };
  collected: { x: number; y: number; type: PickupType; by: EntityKind };
  exploded: ExplodedShip | ExplodedAsteroid;
}
export interface ExplodedShip {
  x: number;
  y: number;
  kind: 'ship';
  slot: number;
  points: number;
}
export interface ExplodedAsteroid {
  x: number;
  y: number;
  kind: 'asteroid';
  size: number;
  slot: number;
  points: number;
}

type Listener<K extends keyof GameEventMap> = (detail: GameEventMap[K]) => void;

/**
 * A tiny typed event bus: `events.on('hit', (d) => d.target)` knows what `d` is, and
 * `events.on('hti', ...)` does not compile. It is written by hand (not EventTarget) because the
 * shared package may not touch DOM or Node globals; EventTarget is in both, but in neither lib.
 * Listeners run synchronously, in the order they subscribed.
 */
export class GameEvents {
  // One set per event type, typed per type (a mapped type), so no cast is needed anywhere.
  #listeners: { [K in keyof GameEventMap]: Set<Listener<K>> } = {
    fired: new Set(),
    hit: new Set(),
    collected: new Set(),
    exploded: new Set(),
  };

  emit<K extends keyof GameEventMap>(type: K, detail: GameEventMap[K]): void {
    const set: Set<Listener<K>> = this.#listeners[type];
    for (const listener of [...set]) listener(detail); // copy: a listener may unsubscribe
  }

  /** Returns the unsubscribe function. */
  on<K extends keyof GameEventMap>(type: K, listener: Listener<K>): () => void {
    const set: Set<Listener<K>> = this.#listeners[type];
    set.add(listener);
    return () => set.delete(listener);
  }
}
