import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../ratelimit.js';

test('a burst is allowed, then the bucket is empty', () => {
  const now = 0;
  const bucket = new TokenBucket({ perSecond: 10, burst: 5, now: () => now });
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(() => bucket.take()),
    [true, true, true, true, true, false],
  );
});

test('it refills with time, but never above the burst size', () => {
  let now = 0;
  const bucket = new TokenBucket({ perSecond: 10, burst: 5, now: () => now });
  for (let i = 0; i < 5; i++) bucket.take();
  now = 200; // 0.2 s = 2 tokens
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take()], [true, true, false]);
  now = 60_000; // a minute later: still only `burst` tokens
  const ok = Array.from({ length: 8 }, () => bucket.take()).filter(Boolean).length;
  assert.equal(ok, 5);
});

test('sustained rate above perSecond is refused, at-rate is fine', () => {
  let now = 0;
  const bucket = new TokenBucket({ perSecond: 10, burst: 1, now: () => now });
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    now += 50; // 20 messages per second
    if (bucket.take()) accepted++;
  }
  assert.ok(
    accepted >= 48 && accepted <= 52,
    `accepted ${accepted} of 100 (expected ~50)`,
  );
});
