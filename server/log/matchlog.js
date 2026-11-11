import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Match log = one JSON object per line (NDJSON), written to disk through a stream pipeline:
 *
 *   events (objects) -> Transform (object in, "line\n" out) -> fs.WriteStream (file)
 *
 * Why streams and not appendFile per event: the file is opened once, writes are batched by the
 * stream, and when the disk is slower than the producer the pipeline pushes back (write()
 * returns false -> the producer waits for 'drain') instead of buffering without limit.
 * stream.pipeline also wires up errors and cleanup: if the file stream fails, the Transform is
 * destroyed too, and the returned promise rejects.
 */
export function createNdjsonTransform() {
  return new Transform({
    writableObjectMode: true, // we write objects...
    readableObjectMode: false, // ...and read bytes/strings
    transform(event, _encoding, callback) {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error) {
        callback(error); // e.g. a circular structure: fail the stream, do not crash the process
      }
    },
  });
}

export const LOG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;

export function logPath(dir, id) {
  if (!LOG_ID.test(id)) throw new Error(`Bad log id: ${id}`);
  return join(dir, `${id}.ndjson`);
}

/**
 * Starts a log for one room/match. Returns { id, path, write(event), end(), done }.
 * `done` settles when the file is completely flushed and closed (or rejects on I/O error); it
 * always has a catch attached so a disk failure is reported, never an unhandled rejection.
 */
export async function createMatchLog(dir, id, { onError = () => {} } = {}) {
  await mkdir(dir, { recursive: true });
  const path = logPath(dir, id);
  const transform = createNdjsonTransform();
  const file = createWriteStream(path, { flags: 'a' });
  const done = pipeline(transform, file);
  done.catch(onError);
  let ended = false;
  return {
    id,
    path,
    done,
    /** Returns false when the internal buffer is full (backpressure); callers may wait for 'drain'. */
    write(event) {
      if (ended || transform.destroyed) return true;
      return transform.write({ t: Date.now(), ...event });
    },
    drained: () => new Promise((resolve) => transform.once('drain', resolve)),
    end() {
      if (!ended) {
        ended = true;
        transform.end();
      }
      return done.catch(() => {});
    },
  };
}
