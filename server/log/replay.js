import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LOG_ID, logPath } from './matchlog.js';

/**
 * Reading a log back is also a stream: bytes from the file are re-cut into lines, and each line
 * becomes an object. Nothing here holds more than one chunk and one partial line in memory, so a
 * 200 MB log costs the same RAM as a 2 KB one.
 */
export function createNdjsonParser() {
  let rest = '';
  return new Transform({
    readableObjectMode: true,
    transform(chunk, _enc, callback) {
      // A chunk can end in the middle of a line (and, for UTF-8, in the middle of a character:
      // setEncoding below keeps characters whole), so keep the tail for the next chunk.
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      try {
        for (const line of lines) if (line) this.push(JSON.parse(line));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        if (rest.trim()) this.push(JSON.parse(rest));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

/** Async iterable of events from a log file: `for await (const event of replayEvents(file))`. */
export async function* replayEvents(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const parser = createNdjsonParser();
  const done = pipeline(input, parser);
  done.catch(() => {}); // errors surface through the iterator below
  yield* parser;
  await done;
}

/** Streams the raw file into a writable (an HTTP response). Never reads it into memory. */
export function streamReplay(dir, id, destination) {
  return pipeline(createReadStream(logPath(dir, id)), destination);
}

export async function listReplays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.ndjson'))) {
    const id = name.slice(0, -'.ndjson'.length);
    if (!LOG_ID.test(id)) continue;
    const { size, mtimeMs } = await stat(logPath(dir, id));
    out.push({ id, bytes: size, modified: new Date(mtimeMs).toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}
