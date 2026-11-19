import { z } from 'zod';
import { entityId, seq as toSeq, tick as toTick } from './brand.ts';
import type { ServerMessage } from './codec.ts';

/**
 * The JSON side of the wire protocol, written ONCE as Zod schemas. Types are DERIVED from them
 * (`z.infer`), so the checker at run time and the type at compile time cannot drift apart: that
 * is the point of Lab 06. The binary side (inputs, snapshots) has its own checked decoder in
 * codec.ts; this file is everything that is JSON.
 *
 * Types vanish when the code is compiled, but bytes from a network are `unknown` whatever the
 * compiler believes. So every message that enters a process goes through `.safeParse()` first.
 */
export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({ nameMax: 24, textMax: 300, roomIdMax: 40 });

const v = z.literal(PROTOCOL_VERSION);
const NAME = /^[\p{L}\p{N} _.-]+$/u;
const ROOM_ID = /^[a-z0-9][a-z0-9-]*$/;

/** A whole number from the wire becomes a branded `Seq`: one of the few places that mint one. */
const seqSchema = z
  .number()
  .int()
  .min(1)
  .max(0xffffffff)
  .transform((n) => toSeq(n));
const bitsSchema = z.number().int().min(0).max(15);

// ---- client -> server ----------------------------------------------------------------------
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v,
    type: z.literal('join'),
    room: z.string().max(LIMITS.roomIdMax).regex(ROOM_ID),
    name: z.string().trim().min(1).max(LIMITS.nameMax).regex(NAME),
    format: z.enum(['binary', 'json']).default('binary'),
  }),
  z.object({
    v,
    type: z.literal('chat'),
    text: z.string().trim().min(1).max(LIMITS.textMax),
  }),
  z.object({ v, type: z.literal('leave') }),
  // ?format=json: the game messages travel as text. (Binary ones are decoded by codec.ts.)
  z.object({
    v,
    type: z.literal('input'),
    seq: seqSchema,
    bits: z.array(bitsSchema).min(1).max(32),
  }),
  z.object({ v, type: z.literal('ping'), t: z.number().finite() }),
]);
/** What the server gets after validation. Derived, never written by hand. */
export type ClientJsonMessage = z.infer<typeof clientMessageSchema>;
export type JoinMessage = Extract<ClientJsonMessage, { type: 'join' }>;
export type WireFormat = JoinMessage['format'];

// ---- server -> client ----------------------------------------------------------------------
const playerSchema = z.object({
  id: z.string(),
  name: z.string(),
  slot: z.number().int().min(0),
});
export type PlayerInfo = z.infer<typeof playerSchema>;

const roomSchema = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
  arena: z
    .object({
      asteroids: z.number().int().min(0).optional(),
      pickups: z.boolean().optional(),
      hunterChance: z.number().min(0).max(1).optional(),
      seed: z.number().int().optional(),
    })
    .default({}),
});
export type RoomInfo = z.infer<typeof roomSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v,
    type: z.literal('welcome'),
    id: z.string(),
    limits: z.object({
      text: z.number().int(),
      name: z.number().int(),
      message: z.number().int(),
    }),
  }),
  z.object({
    v,
    type: z.literal('joined'),
    room: roomSchema,
    you: z.string(),
    slot: z.number().int().min(0),
    tickHz: z.number().positive(),
    format: z.enum(['binary', 'json']),
    players: z.array(playerSchema),
  }),
  z.object({ v, type: z.literal('roster'), players: z.array(playerSchema) }),
  z.object({
    v,
    type: z.literal('chat'),
    from: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({ v, type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerJsonMessage = z.infer<typeof serverMessageSchema>;
/** Omit that works on every member of a union (plain Omit would merge them into one). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ServerMessageInput = DistributiveOmit<ServerJsonMessage, 'v'>;

/** Server side: the only way a control message is written (no `v` to forget). */
export const encode = (message: ServerMessageInput): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, ...message });

// ---- the JSON flavour of a snapshot (?format=json) -------------------------------------------
const num = z.number().finite();
const id = z
  .number()
  .int()
  .transform((n) => entityId(n));
const pickupType = z.enum(['shield', 'rapid', 'homing']);
const asteroidSize = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const eventKind = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
const base = { score: z.number(), deaths: z.number(), respawn: z.number() };

const ownSchema = z.discriminatedUnion('alive', [
  z.object({
    alive: z.literal(true),
    ...base,
    x: num,
    y: num,
    vx: num,
    vy: num,
    angle: num,
    thrust: num,
    cooldownMs: num,
    hp: num,
    shield: num,
    rapid: num,
    homing: num,
    invuln: num,
  }),
  z.object({ alive: z.literal(false), ...base }),
]);

export const snapshotSchema = z.object({
  type: z.literal('snapshot'),
  tick: z
    .number()
    .int()
    .min(0)
    .transform((n) => toTick(n)),
  ackSeq: z
    .number()
    .int()
    .min(0)
    .transform((n) => toSeq(n)),
  own: ownSchema,
  ships: z.array(
    z.object({
      kind: z.literal('ship'),
      slot: z.number().int(),
      x: num,
      y: num,
      angle: num,
      thrust: num,
      invuln: num,
      shield: num,
      hp: num,
    }),
  ),
  bullets: z.array(
    z.object({
      kind: z.literal('bullet'),
      id,
      x: num,
      y: num,
      vx: num,
      vy: num,
      slot: z.number().int(),
      fireSeq: z.number().int(),
      homing: num,
    }),
  ),
  asteroids: z.array(
    z.object({
      kind: z.literal('asteroid'),
      id,
      x: num,
      y: num,
      size: asteroidSize,
      hunter: num,
    }),
  ),
  pickups: z.array(
    z.object({ kind: z.literal('pickup'), id, x: num, y: num, type: pickupType }),
  ),
  events: z.array(z.object({ kind: eventKind, param: num, x: num, y: num })),
});

export const pongSchema = z.object({
  type: z.literal('pong'),
  t: num,
  tick: z
    .number()
    .int()
    .transform((n) => toTick(n)),
});

/** A JSON game frame from the server (`?format=json`): snapshot or pong, or null if it is neither. */
export function parseServerGameJson(data: unknown): ServerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const kind = (data as { type?: unknown }).type;
  if (kind === 'snapshot') {
    const parsed = snapshotSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
  if (kind === 'pong') {
    const parsed = pongSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
  return null;
}
