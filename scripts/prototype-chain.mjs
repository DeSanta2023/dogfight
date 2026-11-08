// Lab 02 console experiments (notes §§1-3 of the lab). Run with: npm run prototypes
import { Ship } from '../src/sim/ship.js';
import { Entity } from '../src/sim/entity.js';

const show = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

console.log(
  '--- 1. delegation: lookup goes up the prototype chain, nothing is copied ---',
);
const a = { hello: () => 'hello from a' };
const b = Object.create(a);
show('b.hello()', b.hello());
show('Object.hasOwn(b, "hello")', Object.hasOwn(b, 'hello'));
a.hello = () => 'a changed its mind';
show('after a.hello = ... ; b.hello()', b.hello());
b.hello = () => 'b shadows it';
show('after b.hello = ... ; b.hello()', b.hello());
show('a.hello() (untouched by the shadow)', a.hello());
delete b.hello;
show('after delete b.hello ; b.hello()', b.hello());

console.log('\n--- 2. `this` is decided by the call site ---');
class A {
  m() {
    return this;
  }
}
const inst = new A();
const m = inst.m;
show('inst.m() === inst  (implicit binding)', inst.m() === inst);
show('m()  (default binding, class = strict)', m());
show('m.call(inst) === inst  (explicit binding)', m.call(inst) === inst);
const arrow = () => typeof this;
show('arrow.call({}) (arrows ignore call/bind)', arrow.call({}));
show('new A() instanceof A  (new binding)', new A() instanceof A);
try {
  A();
} catch (error) {
  show('A()  (a class cannot be called without new)', `${error.constructor.name}`);
}

console.log('\n--- 3. keys: object turns keys into strings, Map keeps them ---');
const o = { 1: 'x' };
const map = new Map([[1, 'x']]);
show('o[1]', o[1]);
show('o["1"]', o['1']);
show('Object.keys(o)', JSON.stringify(Object.keys(o)));
show('map.get(1)', map.get(1));
show('map.get("1")', map.get('1'));
show('o["constructor"] === Object (inherited key!)', o['constructor'] === Object);
show('map.get("constructor")', map.get('constructor'));

console.log('\n--- the prototype chain of a real Ship ---');
const ship = new Ship();
const proto = Object.getPrototypeOf;
show('proto(ship) === Ship.prototype', proto(ship) === Ship.prototype);
show(
  'proto(Ship.prototype) === Entity.prototype',
  proto(Ship.prototype) === Entity.prototype,
);
show(
  'proto(Entity.prototype) === Object.prototype',
  proto(Entity.prototype) === Object.prototype,
);
show('proto(Object.prototype)', proto(Object.prototype));
show('proto(Ship) === Entity  (statics inherit too)', proto(Ship) === Entity);
show('Object.hasOwn(ship, "update")', Object.hasOwn(ship, 'update'));
show(
  'Object.hasOwn(Ship.prototype, "update")  (override)',
  Object.hasOwn(Ship.prototype, 'update'),
);
show(
  'Object.hasOwn(Entity.prototype, "snapshot")',
  Object.hasOwn(Entity.prototype, 'snapshot'),
);
show(
  'Object.hasOwn(Ship.prototype, "snapshot")',
  Object.hasOwn(Ship.prototype, 'snapshot'),
);
show(
  'ship.snapshot === Entity.prototype.snapshot',
  ship.snapshot === Entity.prototype.snapshot,
);
