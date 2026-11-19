import { Game, type GameOptions } from '@dogfight/shared/game.ts';
import { DT, TICK_HZ, inputFromBits, type InputBits } from '@dogfight/shared/input.ts';
import {
  EVENT,
  PICKUP_NAMES,
  captureSnapshot,
  type Snapshot,
  type WireEvent,
} from '@dogfight/shared/snapshot.ts';
import { seq as toSeq, tick as toTick, type Seq } from '@dogfight/shared/brand.ts';
import { Ticker, type TickerOptions } from './ticker.ts';

const MAX_QUEUE = 6; // inputs a player may have waiting. More = the client runs ahead: drop the oldest
const KEEP_ON_OVERFLOW = 3;
const MAX_GAP_FILL = 8;

/**
 * The authoritative game of one room. It owns a Game (from @dogfight/shared, the same code the
 * browser predicts with), one INPUT QUEUE per player and a Ticker that runs 30 steps per second.
 *
 * Players send inputs (bits + seq), never positions. Every tick the match takes ONE input per
 * player from its queue, steps the world once and tells `onSnapshot(slot, snapshot)` what each
 * player may see. It knows nothing about sockets (ws.js wires them), so it runs in plain tests.
 *
 * What a queue does when it is not "exactly one per tick":
 *   empty    the player's last input is repeated (a held key stays held); counted as `starved`
 *   > 6      the OLDEST are dropped; a client cannot move faster by sending more than 30 inputs/s
 *   gap      packets were lost and the redundant copies did not cover it: the missing seqs are
 *            filled with the previous bits so seq numbers stay aligned with ticks
 *   old seq  duplicate (the redundancy) or reordered packet: ignored
 */
interface QueuedInput {
  seq: number;
  bits: InputBits;
}
/** Everything the match remembers about one player's input stream. */
interface InputStream {
  queue: QueuedInput[];
  lastSeq: number; // the newest seq that was ever queued
  applied: number; // the newest seq the simulation has used: this is what the snapshot acks
  lastBits: InputBits;
  starved: number;
  dropped: number;
}

export interface MatchOptions extends Partial<Omit<TickerOptions, 'hz' | 'onTick'>> {
  arena?: Omit<GameOptions, 'players' | 'cosmetics'>;
  onSnapshot: (slot: number, snapshot: Snapshot) => void;
}

export class Match {
  #game: Game;
  #ticker: Ticker;
  #players = new Map<number, InputStream>();
  #events: WireEvent[] = [];
  #onSnapshot: MatchOptions['onSnapshot'];
  tickNumber = 0;

  constructor({ arena = {}, onSnapshot, ...tickerOptions }: MatchOptions) {
    const seed = arena.seed ?? Date.now() & 0x7fffffff; // chosen HERE, at the edge: the sim has no clock
    this.#game = new Game({ ...arena, seed, players: 0, cosmetics: false });
    this.#onSnapshot = onSnapshot;
    this.#ticker = new Ticker({
      hz: TICK_HZ,
      onTick: () => this.tick(),
      ...tickerOptions,
    });
    this.#listen();
  }

  get game(): Game {
    return this.#game;
  }
  get size(): number {
    return this.#players.size;
  }
  get running(): boolean {
    return this.#ticker.running;
  }

  #listen(): void {
    const events = this.#game.events;
    const push = (kind: WireEvent['kind'], at: { x: number; y: number }, param = 0) =>
      this.#events.push({ kind, param, x: at.x, y: at.y });
    events.on('fired', (d) => push(EVENT.FIRED, d, d.slot & 15)); // param = who fired
    events.on('hit', (d) =>
      push(d.target === 'ship' ? EVENT.HIT_SHIP : EVENT.HIT_ROCK, d),
    );
    events.on('exploded', (d) =>
      d.kind === 'ship'
        ? push(EVENT.SHIP_DESTROYED, d)
        : push(EVENT.ROCK_DESTROYED, d, d.size),
    );
    events.on('collected', (d) =>
      push(EVENT.COLLECTED, d, Math.max(0, PICKUP_NAMES.indexOf(d.type))),
    );
  }

  join(slot: number): void {
    if (this.#players.has(slot)) return;
    this.#players.set(slot, {
      queue: [],
      lastSeq: 0,
      applied: 0,
      lastBits: 0,
      starved: 0,
      dropped: 0,
    });
    this.#game.addPlayer(slot);
    if (!this.#ticker.running) this.#ticker.start();
  }

  leave(slot: number): void {
    this.#players.delete(slot);
    this.#game.removePlayer(slot);
    if (this.#players.size === 0) this.#ticker.stop();
  }

  stop(): void {
    this.#ticker.stop();
  }

  /** Accepts the redundant packet [firstSeq .. firstSeq + bits.length - 1]. */
  input(slot: number, firstSeq: number, bitsList: readonly InputBits[]): void {
    const p = this.#players.get(slot);
    if (!p) return;
    bitsList.forEach((bits, i) => {
      const seq = firstSeq + i;
      if (seq <= p.lastSeq) return; // duplicate or late: already have it
      const missing = seq - p.lastSeq - 1;
      if (p.lastSeq > 0 && missing > 0 && missing <= MAX_GAP_FILL) {
        const fill = p.queue.at(-1)?.bits ?? p.lastBits;
        for (let s = p.lastSeq + 1; s < seq; s++) p.queue.push({ seq: s, bits: fill });
      }
      p.queue.push({ seq, bits });
      p.lastSeq = seq;
    });
    if (p.queue.length > MAX_QUEUE) {
      const drop = p.queue.length - KEEP_ON_OVERFLOW;
      p.queue.splice(0, drop);
      p.dropped += drop;
    }
  }

  /** One simulation step for everybody, then one snapshot per player. */
  tick(): void {
    const inputs = new Map<number, ReturnType<typeof inputFromBits>>();
    for (const [slot, p] of this.#players) {
      const next = p.queue.shift();
      if (next) {
        p.lastBits = next.bits;
        p.applied = next.seq;
        const ship = this.#game.player(slot)?.ship;
        if (ship) ship.inputSeq = next.seq;
      } else {
        p.starved++;
      }
      inputs.set(slot, inputFromBits(p.lastBits));
    }
    this.#game.stepInputs(DT, inputs);
    this.tickNumber++;

    const events = this.#events;
    this.#events = [];
    for (const [slot, p] of this.#players) {
      this.#onSnapshot(
        slot,
        captureSnapshot(this.#game, {
          tick: toTick(this.tickNumber),
          slot,
          ackSeq: toSeq(p.applied),
          events,
        }),
      );
    }
  }

  stats() {
    let starved = 0;
    let dropped = 0;
    let queued = 0;
    for (const p of this.#players.values()) {
      starved += p.starved;
      dropped += p.dropped;
      queued += p.queue.length;
    }
    return {
      players: this.#players.size,
      ...this.#ticker.stats(),
      starved,
      dropped,
      queued,
    };
  }
}
