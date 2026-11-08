// Lab 02: the `this` bug, reproduced and fixed. Run with: npm run this-bug
//
// Ship.fire() needs `this` (cooldown, pose, world). Pass it somewhere as a bare function
// reference — an event listener, setTimeout, a callback — and the object to the left of the dot
// is gone, so `this` is no longer the ship.
import { Ship } from '../src/sim/ship.js';
import { World } from '../src/sim/world.js';

const world = new World();
const ship = world.spawn(new Ship());
const bullets = () => [...world.ofKind('bullet')].length;
const cool = () => {
  for (let i = 0; i < 20; i++) ship.update(1 / 60); // let the fire cooldown expire
};
const show = (label, text) => console.log(`${label.padEnd(44)} ${text}`);

console.log('--- the bug ---');

// 1. Bare call: default binding. Modules/classes are strict => this === undefined.
const loose = ship.fire;
try {
  loose();
} catch (error) {
  show('const f = ship.fire; f()', `${error.constructor.name}: ${error.message}`);
}

// 2. DOM-style listener: the browser calls listener.call(currentTarget, event), so `this` is the
//    element (here a stand-in object). `this.alive` is undefined => the guard returns early.
//    No error, no bullet: the silent version of the bug.
const fakeElement = { tagName: 'CANVAS' };
const result = loose.call(fakeElement);
show(
  'listener called with this = <canvas>',
  `returned ${result}, bullets in world: ${bullets()}`,
);

// 3. setTimeout(ship.fire, 0): `this` is a Timeout object in Node (window in a browser).
await new Promise((resolve) => {
  setTimeout(function () {
    const outcome = loose.call(this);
    show(
      'setTimeout(ship.fire, 0)',
      `returned ${outcome}, bullets in world: ${bullets()}`,
    );
    resolve();
  }, 0);
});

console.log('\n--- three fixes ---');

// Fix 1: wrap in an arrow. The call site keeps the `ship.` to the left of the dot.
const viaArrow = () => ship.fire();
show('fix 1  () => ship.fire()', `bullets after call: ${(viaArrow(), bullets())}`);

// Fix 2: bind. Permanently attaches `this`, but creates a NEW function each time.
cool();
const bound = ship.fire.bind(ship);
show('fix 2  ship.fire.bind(ship)', `bullets after call: ${(bound(), bullets())}`);
show(
  '        bind makes a new function',
  `ship.fire.bind(ship) === ship.fire.bind(ship): ${ship.fire.bind(ship) === ship.fire.bind(ship)}`,
);

// Fix 3: arrow-function class field. `this` is captured lexically when the instance is created.
class FieldShip {
  alive = true;
  fire = () => this.alive; // own property of EVERY instance, not on the prototype
}
class FieldBase {
  fire = () => 'base fire';
}
class FieldChild extends FieldBase {
  fire = () => `child + ${super.fire?.() ?? 'no super.fire (undefined)'}`;
}
const a = new FieldShip();
const b = new FieldShip();
const detachedField = a.fire;
show('fix 3  arrow class field, detached call', `works: ${detachedField()}`);
show('        one function per instance', `a.fire === b.fire: ${a.fire === b.fire}`);
show(
  '        lives on the prototype?',
  `FieldShip.prototype.fire: ${FieldShip.prototype.fire}`,
);
try {
  show('        subclass calls super.fire()', new FieldChild().fire());
} catch (error) {
  show(
    '        subclass calls super.fire()',
    `${error.constructor.name}: ${error.message}`,
  );
}
show(
  'Ship (normal method) on the prototype?',
  `${typeof Ship.prototype.fire}, own property: ${Object.hasOwn(ship, 'fire')}`,
);
