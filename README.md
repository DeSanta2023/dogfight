# Dogfight

A multiplayer-ready space dogfight built step by step in a JavaScript course (vanilla JS, ES
modules, Vite; the server comes in later labs).

| Lab | Topic                                    | Tag      | Where to look                       |
| --- | ---------------------------------------- | -------- | ----------------------------------- |
| 01  | Event loop, fixed-timestep game loop     | `lab-01` | [Lab 01](#lab-01--the-game-loop)    |
| 02  | Objects, prototypes, `this`, composition | `lab-02` | [Lab 02](#lab-02--the-entity-model) |

## Run

```bash
nvm use              # Node 22 (see .nvmrc)
npm install
npm run dev          # open the printed URL
npm test             # 35 tests (node:test), no browser needed
npm run lint         # ESLint (flat config) + eslint-config-prettier
npm run format       # Prettier
npm run determinism  # Lab 01 experiment 3, headless
npm run this-bug     # Lab 02: the `this` bug and its three fixes, printed
npm run prototypes   # Lab 02: delegation / `this` / Map-vs-object / prototype chain
```

Controls: **← → / A D** rotate, **↑ / W** thrust, **Space** fire, **R** restart. The HUD at the top
left shows steps/s, frames/s, frame time and CPU work per frame (Lab 01); the one at the top right
shows score, hp, deaths and active pickup effects. Add `?seed=123` to the URL to get the same
asteroids and pickups every run.

## Structure

```
index.html                  <canvas> + <script type="module">
src/main.js                 wires loop + input + Game + rendering; reads URL switches
src/loop.js                 createLoop({ step, simulate, render }) — rAF + clamped accumulator
src/input.js                createInput(target) — closure over key state (isDown / justPressed)
src/sim/                    the simulation: NO DOM, NO canvas, NO Math.random — runs in Node
  vector.js                 Vector2: immutable, pure methods
  entity.js                 Entity base class (private static #nextId, composed behaviors)
  ship.js                   Ship extends Entity; Lab 01's pure integrate() lives here too
  entities.js               Bullet, Asteroid, Pickup, Explosion (all extend Entity)
  behaviors.js              homing(): a composed capability, not a class
  world.js                  World over Map<id, Entity>: spawn / despawn / iterator / *ofKind / step
  collision.js              findCollisions(world) -> [a, b] pairs (swappable system)
  game.js                   match rules: score, respawn, refills, pickups (seeded rng)
  arena.js, rng.js          arena size + edge rules; seeded PRNG closure
src/render/                 canvas, interpolation, drawing (reads sim state, never writes it)
test/                       35 tests for the above
scripts/                    determinism.mjs (Lab 01), this-bug.mjs, prototype-chain.mjs (Lab 02)
```

## Lab 02 — the entity model

One ship became a world: ships, bullets, asteroids, pickups and explosions, an entity manager,
collisions, shooting, respawn and a score. Inheritance stays one level deep; everything else is
composed.

### The game

- Fly, shoot with **Space**. Asteroids come in sizes 1–3 (hp = size); small ones are sometimes
  _hunters_ that slowly steer toward you. Ships have 3 hp and are invulnerable for 1.5 s after a hit.
- A destroyed ship explodes into particles and respawns after 2 s at a random safe spot, protected
  for 2 s. Score: 50 × size for every asteroid destroyed by a bullet.
- Pickups (stationary rings, collected by flying into them): **S** shield, **R** rapid fire (8 s each),
  **H** homing bullets (10 s).

### Class tree (one level, on purpose)

```
Entity            id (private static counter), pose, vel, radius, kind, alive, behaviors[], update()
├── Ship          private #hp + `get hp()`, fire(), effects: Map<name, secondsLeft>
├── Bullet        ttl, damage, ownerId
├── Asteroid      size, hp, optional `homing` behavior
├── Pickup        stationary + collidable, apply(collector)
└── Explosion     a burst of short-lived particles
```

### The `this` bug (encountered on purpose, then fixed)

`Ship.fire()` reads `this` (cooldown, pose, world). It works as `ship.fire()` because the call site
puts the ship to the left of the dot (implicit binding). Inside the game it is always called that
way (`this.fire()` from `Ship.update`), so the bug only appears when someone wires it up naively:

```js
canvas.addEventListener('click', ship.fire); // passes the function, loses the ship
```

`npm run this-bug` reproduces it (and `test/entities.test.js` pins it down):

| Call site                       | `this` inside `fire`                     | What happens                                                       |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `const f = ship.fire; f()`      | `undefined` (class bodies are strict)    | `TypeError: Cannot read properties of undefined (reading 'alive')` |
| DOM listener (`f.call(canvas)`) | the element                              | **silently** returns `null`, no bullet                             |
| `setTimeout(ship.fire, 0)`      | `Timeout` in Node, `window` in a browser | **silently** returns `null`, no bullet                             |

The silent variants are the dangerous ones: no error, the ship just stops shooting.

Three fixes, with what each one costs (all measured in `npm run this-bug`):

| Fix                        | Code                   | Downside                                                                                                                                                                                    |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrapper arrow              | `() => ship.fire()`    | a new function each time you write it (keep the reference if you need `removeEventListener`)                                                                                                |
| `bind`                     | `ship.fire.bind(ship)` | creates a new function on every call (`bind(x) === bind(x)` is `false`); permanently tied to that one object                                                                                |
| Arrow function class field | `fire = () => { … }`   | one function per instance (`a.fire !== b.fire`), not on the prototype (`Ship.prototype.fire` is `undefined`), so a subclass cannot `super.fire()` and it cannot be stubbed on the prototype |

**Chosen: the wrapper arrow, resolving the ship at call time**, e.g.
`() => game.ship?.fire()`. In this game the ship _object_ is replaced on every respawn
(`game.ship` is a new `Ship` after each death). A `bind(ship)` or an arrow field captured at start-up
would keep pointing at the dead ship and silently stop shooting after the first death; the wrapper
looks up the current ship each time. It also keeps `fire` as one shared method on the prototype.

### Design note: composition instead of a deep hierarchy

The two features that break a class tree: **(a)** _homing_ that can steer a bullet or an asteroid,
**(b)** a _pickup_ that is stationary and collidable but is not a ship.

**The inheritance version I did not build.** `Bullet → HomingBullet` and
`Asteroid → HomingAsteroid` copy the same steering code; hoisting it into a shared parent needs a
class that is both a "projectile" and a "rock" (an asteroid is not a projectile), or puts homing into
`Entity` so every entity carries it. JavaScript has single inheritance, so "homing + shielded +
rapid" would need a class per combination (kinds × capabilities). And the pickup would have to
extend `Ship` (inheriting hp, `fire()` and input handling it never uses) or re-implement position,
radius and collision.

**What I built instead.**

- `Entity` keeps only what every entity really shares: id, pose, velocity, radius, `kind`, `alive`
  and `update()`. One level of `extends`, no more.
- Capabilities are **behavior objects** `{ name, update(entity, dt, world) }` kept in
  `entity.behaviors`. `homing({ targetKind, turnRate, range })` is a single function that steers
  whatever it is attached to. Hunter asteroids get it at construction; a bullet gets it in
  `Ship.fire()` while the _homing_ effect is active. One behavior, two kinds of entity
  (`test/world.test.js`: "homing steers one behavior object onto BOTH a bullet and an asteroid").
  Ships run their behaviors too (even though `Ship.update` does not call `super.update()`).
- `Pickup` is its own `Entity` subclass: `update()` only counts down its time-to-live, it is `solid`,
  and when a ship touches it, `pickup.apply(ship)` calls `ship.addEffect(type, seconds)`
  (duck-typed: anything with `addEffect` can collect it). The effects themselves (`shield`,
  `rapid`, `homing`) are plain data in a `Map<name, secondsLeft>` on the ship, not subclasses.

**Why not the other options.** Mixins (`Object.assign` onto a prototype) apply to a whole class,
but homing is a _per-instance, runtime_ decision (only bullets fired during the pickup).
Behavior-as-data with a `switch (kind)` pushes all the logic into one function that grows with every
feature. An array of behavior objects can be attached, detached and tested one at a time.

**What it costs.** An extra loop and indirection per entity; behaviors are found by string name
(`hasBehavior('homing')`) rather than by type; if several behaviors change the velocity, their order
matters; `homing` scans every target each step (O(n) per homing entity — fine for a few dozen
entities, Lab 7 will measure it).

### Other design decisions

- **`World` is a `Map<id, Entity>`.** Numeric ids stay numbers (an object would turn them into
  strings), iteration follows insertion order, `.size` is O(1), there are no inherited keys like
  `"constructor"`, and add/delete is what `Map` is built for. `World` is iterable
  (`[Symbol.iterator]`) and `*ofKind(kind)` is a generator, so no intermediate arrays.
- **Deferred despawn.** `despawn()` and `kill()` only mark an entity dead; one sweep at the end of
  `step()` deletes it, so nothing is removed from the `Map` while it is being iterated. A step is:
  snapshot → update → edge rule → collisions → sweep. Entities spawned during a step (bullets)
  start updating on the next one.
- **Mutation vs new state.** Entities are mutated in place (no garbage per step); `Vector2` is
  immutable and frozen, so `pos = pos.add(…)` allocates. The previous pose is kept as an explicit
  copy (`prevPos`, `prevAngle`) for the renderer's interpolation. Lab 7 decides whether the
  allocations matter.
- **Collisions are a separate system**: `findCollisions(world)` returns `[a, b]` pairs (naive
  O(n²), circle against circle) and decides nothing; `World` takes it as a constructor argument so a
  spatial hash can replace it. Known limitation: distances are not wrap-aware, so a ship straddling
  an edge does not collide with something on the other side of the seam.
- **Private state.** `#hp` can only change through `takeDamage()`; `ship.hp = 99` throws in strict
  mode, and a test checks it never leaves `0..maxHp`.
- **Determinism.** The simulation never calls `Math.random()`; the seed is chosen in `main.js`, and
  the same seed + inputs give an identical world (tested). Lab 01's pure `integrate()` is still what
  moves the ship, and a regression test reproduces the Lab 01 trajectory (the autopilot still ends
  at y = 114.293).
- **Not done / simplifications.** Bullets do not hit pickups, asteroids do not hit each other, and
  asteroids do not split.

### Console experiments (`npm run prototypes`)

**1. Delegation.** With `b = Object.create(a)`, `b.hello()` finds the method on `a`; nothing is
copied. After `a.hello = …`, `b.hello()` returns the new value. After `b.hello = …` the own property
**shadows** the inherited one, and `delete b.hello` makes the lookup fall through to `a` again.

**2. `this`.** For `class A { m() { return this; } }` with `const m = a.m`:

| Expression                    | Result      | Rule                                                           |
| ----------------------------- | ----------- | -------------------------------------------------------------- |
| `a.m() === a`                 | `true`      | implicit binding (object left of the dot)                      |
| `m()`                         | `undefined` | default binding; class bodies are strict, so not `globalThis`  |
| `m.call(a) === a`             | `true`      | explicit binding                                               |
| `new A() instanceof A`        | `true`      | `new` binding                                                  |
| `A()`                         | `TypeError` | a class cannot be called without `new`                         |
| `arrow.call({})` (module top) | `undefined` | arrow functions take `this` lexically and ignore `call`/`bind` |

**3. Keys.** `{ "1": "x" }[1]` is `"x"`: the object turns the key into the string `"1"`.
`new Map([[1, "x"]]).get("1")` is `undefined`: the `Map` key is the number `1`, and `"1"` is a
different key. Also, `{}["constructor"] === Object` (an inherited key shows up in a plain object)
while `map.get("constructor")` is `undefined`.

**The prototype chain of a real ship** (`const ship = new Ship()`):

```
ship ──► Ship.prototype ──► Entity.prototype ──► Object.prototype ──► null
         update (override)   snapshot, move, …     toString, …
```

`Object.hasOwn(ship, "update")` is `false`; `update` is found on `Ship.prototype` (the override).
`ship.snapshot === Entity.prototype.snapshot` is `true`: it is looked up, not copied.
`Object.getPrototypeOf(Ship) === Entity`, so static members are inherited too.

### Tests

`npm test` runs 35 tests (`node --test`, no dependencies) covering `Vector2` purity, the one-level
class tree, private `#id` and `#hp`, the `this` bug and its fixes, `World` (iteration, `ofKind`,
deferred despawn, safe removal during iteration, edge rules, swappable collisions), damage,
pickups, explosions, respawn, score, the shared `homing` behavior and the determinism of a whole
match.

## Lab 01 — the game loop

### Design notes

- **Fixed timestep.** `simulate(1/60)` is called zero or more times per rendered frame from an
  accumulator; the frame delta is clamped to 0.25 s so a hitch can't cause a spiral of death.
  The renderer receives `alpha = accumulator / step` and blends `previous` → `current`.
- **`integrate(ship, input, dt)` is pure.** It returns a new ship, touches no DOM/canvas/globals,
  and only needs `input.isDown(code)`, so it runs unchanged in Node (see `scripts/determinism.mjs`).
- **Closures, not classes.** `createInput` and `createLoop` keep their state in private variables;
  the returned object is the only API.
- **`justPressed` is cleared per _simulation step_, not per frame** (`endStep()` after each
  `simulate`). A frame can contain 0, 1 or several steps; clearing per frame would lose or
  duplicate presses.
- **Interpolation corner cases.** Position is lerped along the shortest _wrapped_ path (otherwise
  the ship streaks across the arena for one frame when it crosses an edge), and the heading is
  lerped with the shortest signed angle (otherwise 359° → 1° spins the long way round). The ship
  is also drawn as a ghost on the opposite edge so it slides through the border.
- **DPR.** Backing store = CSS size × `devicePixelRatio`; the transform is re-applied every frame
  (`setTransform`), and the logical 1280×720 arena is letterboxed into the window.

### Tuning notes

Starting values (`TUNING` in `src/sim/ship.js`) → final values:

| Parameter     | Before | After | Why                                                                                                       |
| ------------- | ------ | ----- | --------------------------------------------------------------------------------------------------------- |
| `turnRate`    | 3.6    | 3.8   | slightly snappier turning, easier to line the nose up for a new heading                                   |
| `thrustAccel` | 340    | 380   | the ship builds speed faster, less sluggish at the start of a burn                                        |
| `drag`        | 0.9    | 0.5   | with 0.9 the ship slowed down too quickly; 0.5 gives a longer glide and a more "space" feeling of inertia |
| `maxSpeed`    | 460    | 686   | with lower drag the old cap was reached too early and flattened the acceleration, so it was raised        |

Drag and the speed cap are linked: terminal speed without a cap is roughly `thrustAccel / drag`
(380 / 0.5 = 760 units/s), so a cap of 686 is where thrust still feels responsive but the ship
cannot run away.

### Experiments

Open the game with the URL parameter shown for each experiment (`http://localhost:5173/?exp=…`).
All numbers are read from the in-game HUD (500 ms averaging window).

Machine used: Windows, Google Chrome, a high-refresh display (rAF runs show 103–118 frames/s
depending on the run, i.e. a ≈ 120 Hz panel that does not hold its maximum under load).
<!-- TODO: add CPU model, exact Chrome version and the refresh rate from Windows display settings -->

Experiments were run with the final tuning; the tuning does not affect loop timing.

#### Experiment 1 — blocking the frame (`?exp=block`)

`render` busy-waits 100 ms every 60th frame (`while (performance.now() < t + 100) {}`).

| Metric (HUD)                  | Normal             | `?exp=block`          |
| ----------------------------- | ------------------ | --------------------- |
| frames/s                      | 105.4              | 87.4                  |
| steps/s                       | 59.7               | 59.6                  |
| frame time mean / σ / max, ms | 9.53 / 2.95 / 15.0 | 11.36 / 14.48 / 105.0 |
| work/frame, ms                | 0.25               | 2.47                  |

What the HUD shows: the worst frame jumped from 15 ms to **105 ms** (the 100 ms busy-wait plus a
normal frame), and σ of the frame time grew about 5× (2.95 → 14.48). Work per frame rose from 0.25
to 2.47 ms on average because one 100 ms block falls into each 500 ms window (≈ 0.25 + 100 / 40
frames). Frames/s dropped from 105 to 87 because those 100 ms are spent in one frame instead of
~10 normal ones. Steps/s stayed at ≈ 60: after the long frame the accumulator runs ≈ 6 simulation
steps in a row to catch up, so the simulation does not lose time, but the player sees the ship
freeze for about a tenth of a second roughly every 0.7 s and then jump forward.

**Why it can't be worked around.** JavaScript on the page runs on one thread and every callback
runs to completion. While the busy-wait is on the call stack, the event loop cannot take the next
task, the microtask queue is not drained, and the browser cannot run its rendering step (rAF
callbacks → style → layout → paint), so nothing is painted and no input is processed. Timers,
promises, `requestAnimationFrame`, `await` — all of them are _queues the loop reads after the stack
is empty_, so none of them can interrupt the running function. The only options are to make the
work shorter, split it across frames, or move it to another thread (Web Worker — Lab 7).
The accumulator then sees one frame of ≈100 ms and compensates by running ≈6 simulation steps in
the next frame: the game state stays correct, but the player still perceives the freeze.

#### Experiment 2 — `setInterval(frame, 16)` instead of rAF (`?exp=interval`)

Record 10 s in the foreground, then 5 s in a background tab and back.

| Metric                        | rAF (normal)       | `setInterval(16)`                         |
| ----------------------------- | ------------------ | ----------------------------------------- |
| frames/s (foreground)         | 105.4              | 62.5                                      |
| steps/s (foreground)          | 59.7               | 58.6                                      |
| frame time mean / σ / max, ms | 9.53 / 2.95 / 15.0 | 15.98 / 0.49 / 17.0                       |
| after 5 s in background tab   | not measured       | 62.5 / 58.6 steps/s / 15.98 / 0.85 / 17.7 |

A second foreground run of `?exp=interval` gave the same picture: 62.5 frames/s, 58.6 steps/s,
16.00 / 0.68 / 17.5 ms.

Background tab: the HUD read right after returning (about 5 s in another tab) is practically
identical to the foreground one: 62.5 frames/s, σ 0.85 and max 17.7 ms against 0.49 and 17.0 ms. The
pause itself is not visible in the numbers, because the HUD averages over 500 ms and the window had
already refreshed by the time of the screenshot, so the loop had recovered immediately. What
happens while the tab is hidden is therefore described from theory below, not from a measurement.

What differed: with rAF the frame rate follows the display (103–118 frames/s in my runs); with
`setInterval(16)` it is pinned to the timer, **62.5 frames/s = 1000 / 16**, no matter what the
monitor can do, so roughly 40% of the display's refresh opportunities show nothing new and the
motion looks less smooth on a fast display. In these runs the frame-time jitter was actually _lower_
with the timer (σ 0.49–0.85 vs 2.95 ms): a timer fires at a regular 16 ms, whereas rAF frames land
on the display's own refresh grid. So the cost of `setInterval` here is not noise in the frame time but the wrong rate and the
lack of synchronisation with the display. Steps/s stays ≈ 60 either way (58.6 vs 59.7, within the
±1 step quantisation of a 500 ms window), which is exactly what the fixed-timestep accumulator is
for: the simulation does not care how often frames arrive.

Explanation: `setInterval` is a **task** scheduled by a timer, not a rendering step. 16 ms ≠
16.667 ms, so even on a 60 Hz display the timer slowly drifts against the refresh: some ticks come
twice between two paints and some paints get no tick (judder), and on a 105 Hz display the timer
simply under-delivers. The browser decides separately when to paint, so the callback is not aligned
with it. Background tabs clamp timers (to roughly 1 Hz, or even less after a while) but still run
them, while rAF is paused completely. The accumulator's 0.25 s clamp is what keeps the game sane
when the tab comes back: it catches up at most 0.25 s (15 steps) instead of simulating the whole gap.
`requestAnimationFrame` runs _right before the next paint_, receives the frame timestamp, follows
the actual refresh rate (60/120/144 Hz) and stops when the page is hidden.

#### Experiment 3 — variable timestep (`?exp=variable&autopilot=1`)

`simulate(dt)` once per frame with the real elapsed time. With `&autopilot=1` the ship holds
thrust and the HUD (and console) show its position after 5 s of simulated time. Compare in Chrome
DevTools → Performance → CPU: **No throttling** vs **6× slowdown**; repeat with plain
`?autopilot=1` (fixed step).

| Run                             | Position after 5 s (x, y)                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| variable step, no throttling    | 640.000, 117.004 (HUD: 102.9 steps/s = 102.9 frames/s, one step per frame)                                 |
| variable step, CPU 6× slowdown  | not captured in the browser; headless equivalent at the throttled frame time of 31.56 ms: 640.000, 121.605 |
| **fixed step**, no throttling   | 640.000, **114.293** (HUD: 59.9 steps/s, 117.8 frames/s)                                                   |
| **fixed step**, CPU 6× slowdown | 640.000, **114.293** (HUD: 59.5 steps/s, **31.7 frames/s**, frame time 31.56 ms, max 50.2)                 |

The fixed-step ship ended at exactly the same point with 117.8 frames/s and with 31.7 frames/s: the
CPU slowdown cut the rendered frames almost 4×, but the simulation still ran at ≈ 59.5–59.9 steps/s
and produced an identical trajectory. With the variable step the result depends on the frame times
(117.004 at ≈ 103 frames/s, 121.605 expected at 31.56 ms per frame).

Why 114.293 and not the 125.726 of the table below: the 5-second check in `main.js` is
`simTime >= 5` on a floating-point sum of 1/60 s. After 300 steps the sum is slightly below 5, so
one more step (the 301st, 5.0167 s) is taken before the position is printed. The headless table
below stops after exactly 300 steps; running 301 steps in Node gives the same 114.293 as the
browser (and as the "60 Hz" variable row, which is also 301 steps of 1/60 s).

Headless confirmation (`npm run determinism`: the same `integrate()` in Node, 5 s of held thrust,
different frame-time patterns, final tuning; x is always 640 because the ship points up and wraps
around the arena, so y is the position modulo the 720-unit height):

| Frame pattern     | Fixed step (y) | Variable step (y) |
| ----------------- | -------------- | ----------------- |
| 60 Hz             | 125.726        | 114.293           |
| 120 Hz            | 125.726        | 121.401           |
| 144 Hz            | 125.726        | 120.699           |
| jittery 10–30 ms  | 125.726        | 126.031           |
| throttled ~100 ms | 125.726        | 109.325           |

The browser measurement fits the headless table: on this ≈ 103 Hz run the variable-step ship ended
at y = 117.004, between the 60 Hz (114.293) and 120 Hz (121.401) rows, while the fixed step gives
the same position on every row (125.726 after 300 steps, 114.293 after the 301 steps the browser
takes).

With a fixed step the trajectory is bit-identical regardless of frame rate. With a variable step it
depends on how the frames happened to fall: the integration error grows with `dt`, so a slow machine
literally simulates a different game. That is fatal for multiplayer (Lab 5), where client and server
must compute the same result from the same inputs, and for collisions (a 250 ms frame can tunnel
through a wall).

## Lab status

**Lab 01**

- [x] Vite project, `"type": "module"`, ESLint + Prettier, `.nvmrc`
- [x] `createLoop` (rAF + clamped accumulator) with steps/s, frames/s, frame time, HUD
- [x] `createInput` closure with `isDown` and `justPressed`
- [x] Pure `integrate`, wrap-around, no DOM in `src/sim/`
- [x] Interpolated rendering (wrap-aware, angle-aware), DPR-aware resizable canvas
- [x] Tuning notes, experiments 1–3 measured (tag `lab-01`)

**Lab 02**

- [x] `Vector2` (pure, immutable), `Entity` with private static id counter, `Ship extends Entity`
- [x] `World` over `Map`: iterable, `*ofKind`, deferred despawn sweep
- [x] `Bullet` (TTL), `Asteroid`, `Explosion`, `Pickup`; `Ship.fire()`
- [x] `this` bug documented with three fixes and the chosen one
- [x] Collision system as a swappable function; damage via `#hp`; respawn; score HUD
- [x] Homing and pickups by composition; design note
- [x] Console experiments (`npm run prototypes`), 35 tests
- [ ] Tag `lab-02`
