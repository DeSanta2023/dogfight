import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, Room, RoomError, RoomManager } from '../rooms.js';

const room = (extra = {}) =>
  new Room({ id: 'r', name: 'R', maxPlayers: 2, arena: {}, ...extra });
const player = (id, name = id) => ({ id, name });

test('join and leave emit events with plain data, in order', () => {
  const r = room();
  const seen = [];
  r.on('joined', (e) => seen.push(['joined', e.player.name, e.players.length]));
  r.on('left', (e) => seen.push(['left', e.player.name, e.players.length]));
  r.on('empty', () => seen.push(['empty']));
  r.join(player('1', 'Ace'));
  r.join(player('2', 'Bolt'));
  r.leave('1');
  r.leave('2');
  assert.deepEqual(seen, [
    ['joined', 'Ace', 1],
    ['joined', 'Bolt', 2],
    ['left', 'Ace', 1],
    ['left', 'Bolt', 0],
    ['empty'],
  ]);
});

test('listeners run synchronously, inside emit()', () => {
  const r = room();
  let ran = false;
  r.on('joined', () => (ran = true));
  r.join(player('1'));
  assert.equal(ran, true); // no await needed: that is what EventEmitter guarantees
});

test('full room, duplicate name (case-insensitive), double join', () => {
  const r = room();
  r.join(player('1', 'Ace'));
  assert.throws(() => r.join(player('1', 'Other')), { code: 'already_joined' });
  assert.throws(() => r.join(player('2', 'ACE')), { code: 'name_taken' });
  r.join(player('2', 'Bolt'));
  assert.throws(() => r.join(player('3', 'Cy')), { code: 'room_full' });
});

test('chat from a stranger is refused', () => {
  assert.throws(
    () => room().chat('nobody', 'hi'),
    (e) => e instanceof RoomError && e.code === 'not_in_room',
  );
});

test('leave() of an unknown id is a harmless false', () =>
  assert.equal(room().leave('x'), false));

test('an emitted "error" without a listener THROWS (this is what crashes a process)', () => {
  assert.throws(() => room().emit('error', new Error('boom')), /boom/);
});

test('RoomManager: an empty room is deleted, a preset is created on demand', () => {
  const m = new RoomManager();
  const created = [];
  const removed = [];
  m.on('created', (r) => created.push(r.id));
  m.on('removed', (r) => removed.push(r.id));
  const r = m.getOrCreate('duel');
  assert.equal(m.size, 1);
  assert.equal(m.getOrCreate('duel'), r); // same room, not a second one
  r.join(player('1'));
  r.leave('1');
  assert.equal(m.size, 0);
  assert.deepEqual([created, removed], [['duel'], ['duel']]);
});

test('RoomManager: unknown room, cap on rooms', () => {
  const m = new RoomManager({ maxRooms: 1 });
  assert.throws(() => m.getOrCreate('nope'), { code: 'no_such_room' });
  m.create({ id: 'a', name: 'A', maxPlayers: 2, arena: {} });
  assert.throws(() => m.create({ id: 'b', name: 'B', maxPlayers: 2, arena: {} }), {
    code: 'too_many_rooms',
  });
  assert.throws(() => m.create({ id: 'a', name: 'A', maxPlayers: 2, arena: {} }), {
    code: 'room_exists',
  });
});

test('list(): presets first (0 players when not live), live counts, custom rooms last', () => {
  const m = new RoomManager();
  m.getOrCreate('duel').join(player('1'));
  m.create({ id: 'mine', name: 'Mine', maxPlayers: 3, arena: {}, custom: true });
  const list = m.list();
  assert.deepEqual(
    list.slice(0, PRESETS.length).map((r) => r.id),
    PRESETS.map((p) => p.id),
  );
  assert.equal(list.find((r) => r.id === 'duel').players, 1);
  assert.equal(list.find((r) => r.id === 'quiet-orbit').players, 0);
  assert.equal(list.at(-1).id, 'mine');
  m.closeAll();
});

test('a custom room nobody joins is removed after the idle time', async () => {
  const m = new RoomManager({ idleMs: 30 });
  m.create({ id: 'x', name: 'X', maxPlayers: 2, arena: {}, custom: true });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(m.size, 0);
});
