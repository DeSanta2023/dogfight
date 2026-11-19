/**
 * `catch (error)` gives `unknown`: in JavaScript anything can be thrown (`throw 'oops'`). These
 * two helpers are the only places that look inside, so the rest of the server never casts.
 */
export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** The text to put in a log line for something that was thrown. */
export const describeError = (value: unknown): string => {
  const error = toError(value);
  return error.stack ?? error.message;
};

/** A Node system error ("ENOENT", "EADDRINUSE"...) carries a string `code`. */
export function errorCode(value: unknown): string | undefined {
  if (value instanceof Error && 'code' in value && typeof value.code === 'string')
    return value.code;
  return undefined;
}
