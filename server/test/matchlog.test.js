import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMatchLog, createNdjsonTransform, logPath } from '../log/matchlog.js';
import { createNdjsonParser, listReplays, replayEvents } from '../log/replay.js';

const tmp = () => mkdtemp(join(tmpdir(), 'dogfight-log-'));

test('the Transform turns objects into NDJSON lines', async () => {
  const t = createNdjsonTransform();
  const out = [];
  t.on('data', (c) => out.push(c.toString()));
  t.write({ a: 1 });
  t.end({ b: 'é' });
  await new Promise((r) => t.on('end', r));
  assert.equal(out.join(''), '{"a":1}\n{"b":"é"}\n');
});

test('a circular event fails the stream, it does not crash the process', async () => {
  const t = createNdjsonTransform();
  const circular = {};
  circular.self = circular;
  const failed = new Promise((resolve) => t.on('error', resolve));
  t.write(circular);
  assert.match((await failed).message, /circular/i);
});

test('write -> file -> replay returns the same events, in order', async () => {
  const dir = await tmp();
  try {
    const log = await createMatchLog(dir, 'm1');
    for (let i = 0; i < 1000; i++) log.write({ type: 'chat', n: i, text: 'привіт' });
    await log.end();
    const back = [];
    for await (const e of replayEvents(logPath(dir, 'm1'))) back.push(e);
    assert.equal(back.length, 1000);
    assert.deepEqual(
      back.map((e) => e.n),
      Array.from({ length: 1000 }, (_, i) => i),
    );
    assert.equal(back[0].text, 'привіт');
    assert.equal(typeof back[0].t, 'number'); // timestamp added by the log
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the parser copes with lines cut at arbitrary chunk boundaries', async () => {
  const parser = createNdjsonParser();
  const got = [];
  parser.on('data', (e) => got.push(e));
  const text = '{"a":1}\n{"b":"x"}\n{"c":3}';
  for (let i = 0; i < text.length; i += 3) parser.write(text.slice(i, i + 3)); // 3 chars at a time
  parser.end();
  await new Promise((r) => parser.on('end', r));
  assert.deepEqual(got, [{ a: 1 }, { b: 'x' }, { c: 3 }]);
});

test('a corrupt line makes the replay iterator throw (and not hang)', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 'bad.ndjson');
    await writeFile(file, '{"ok":1}\n{broken\n{"ok":2}\n');
    const got = [];
    await assert.rejects(async () => {
      for await (const e of replayEvents(file)) got.push(e);
    }, SyntaxError);
    // (events from the same chunk, before the bad line, may or may not have been delivered:
    // a stream that fails is destroyed, and only the error is guaranteed)
    assert.ok(got.length <= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('log ids cannot escape the directory', () => {
  assert.throws(() => logPath('/tmp/x', '../evil'), /Bad log id/);
  assert.throws(() => logPath('/tmp/x', 'a/b'), /Bad log id/);
});

test('listReplays: missing directory = empty list, files are listed with sizes', async () => {
  assert.deepEqual(await listReplays('/definitely/not/here'), []);
  const dir = await tmp();
  try {
    const log = await createMatchLog(dir, 'm2');
    log.write({ type: 'x' });
    await log.end();
    const [first] = await listReplays(dir);
    assert.equal(first.id, 'm2');
    assert.equal(first.bytes, (await readFile(logPath(dir, 'm2'))).length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write() reports backpressure (false) when the buffer is full, and drained() resolves', async () => {
  const dir = await tmp();
  try {
    const log = await createMatchLog(dir, 'm3');
    let sawFalse = false;
    for (let i = 0; i < 5000 && !sawFalse; i++)
      sawFalse = !log.write({ pad: 'x'.repeat(1000) });
    assert.equal(sawFalse, true);
    await log.drained();
    await log.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
