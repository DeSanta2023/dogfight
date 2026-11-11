import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../config.js';

test('defaults are valid', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.pingIntervalMs, 15_000);
  assert.equal(c.maxMissedPongs, 2);
  assert.equal(c.joinTimeoutMs, 5000);
  assert.ok(Object.isFrozen(c));
});

test('values come from the environment and are converted to numbers', () => {
  const c = loadConfig({ PORT: '8080', MAX_ROOMS: '7', ENABLE_SLOW_ROUTE: '0' });
  assert.deepEqual([c.port, c.maxRooms, c.enableSlowRoute], [8080, 7, false]);
});

test('every bad value is reported at once, by name', () => {
  assert.throws(
    () =>
      loadConfig({
        PORT: '30o0',
        MAX_ROOMS: '0',
        LOG_DIR: ' ',
        ENABLE_SLOW_ROUTE: 'yes',
      }),
    (e) =>
      e instanceof ConfigError &&
      e.problems.length === 4 &&
      /PORT/.test(e.message) &&
      /MAX_ROOMS/.test(e.message) &&
      /LOG_DIR/.test(e.message) &&
      /ENABLE_SLOW_ROUTE/.test(e.message),
  );
});

test('port out of range', () => {
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
});
