/**
 * Branded types: a `number` that the compiler refuses to confuse with another `number`.
 *
 * An entity id, an input sequence number and a tick number are all plain numbers at run time,
 * and mixing them up (`ackSeq` where a tick belongs) is exactly the bug that stays invisible
 * until two players fight. At compile time each carries a phantom tag, so
 * `const t: Tick = seq` is an error. The tag does not exist at run time: no cost, no wrapper.
 */
declare const tag: unique symbol;
export type Brand<T, B extends string> = T & { readonly [tag]: B };

export type EntityId = Brand<number, 'EntityId'>;
/** Sequence number of one client input (1, 2, 3, ...). */
export type Seq = Brand<number, 'Seq'>;
/** Number of a server simulation step. */
export type Tick = Brand<number, 'Tick'>;

/**
 * The ONLY place a plain number becomes a branded one (one `as`: TypeScript cannot know where a
 * number came from). Everything else gets branded values from here, from the codec or from Zod.
 */
export const brand = <B extends string>(n: number): Brand<number, B> =>
  n as Brand<number, B>; // the single cast that mints every branded number

export const entityId = (n: number): EntityId => brand<'EntityId'>(n);
export const seq = (n: number): Seq => brand<'Seq'>(n);
export const tick = (n: number): Tick => brand<'Tick'>(n);

/** Exhaustiveness check: `default: return assertNever(x)` fails to COMPILE if a case is missing. */
export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
