# Dogfight — Lab 01: The Event Loop Is the Game Loop

A spaceship you fly on a canvas at 60 simulation steps per second on any monitor, rendered with
interpolation. Vanilla JavaScript (ES modules) + Vite. This is step 1 of the multiplayer arena
game built across the course.

## Run

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
npm run dev        # open the printed URL
npm run lint       # ESLint (flat config) + eslint-config-prettier
npm run format     # Prettier
npm run determinism  # headless version of experiment 3 (Node, no browser)
```

Controls: **← → / A D** rotate, **↑ / W** thrust, **R** reset. The HUD (top-left) shows
steps/s, frames/s, frame time (mean, σ, max) and CPU work per frame.

## Structure

```
index.html            <canvas> + <script type="module">
src/main.js           wires everything; reads experiment switches from the URL
src/loop.js           createLoop({ step, simulate, render }) — rAF + clamped accumulator
src/input.js          createInput(target) — closure over key state (isDown / justPressed)
src/sim/ship.js       createShip(), integrate(ship, input, dt) — pure, no DOM
src/sim/arena.js      arena size, wrap-around, shortest-path helpers
src/render/canvas.js  DPR-aware canvas setup + resize
src/render/draw.js    arena/starfield, ship (translate/rotate), HUD
src/render/interpolate.js  wrap-aware position lerp + shortest-angle lerp
scripts/determinism.mjs    experiment 3 without a browser
```

## Design notes

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

## Tuning notes

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

## Experiments

Open the game with the URL parameter shown for each experiment (`http://localhost:5173/?exp=…`).
All numbers are read from the in-game HUD (500 ms averaging window).

Machine used: Windows, Google Chrome, display refresh ≈ 105 Hz (the normal run shows 105.4
frames/s and a 9.5 ms mean frame time). <!-- TODO: add CPU model and the exact Chrome version -->
Experiments 1 and 2 were run with the final tuning; the tuning does not affect loop timing.

### Experiment 1 — blocking the frame (`?exp=block`)

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

### Experiment 2 — `setInterval(frame, 16)` instead of rAF (`?exp=interval`)

Record 10 s in the foreground, then 5 s in a background tab and back.

| Metric                        | rAF (normal)       | `setInterval(16)`   |
| ----------------------------- | ------------------ | ------------------- |
| frames/s (foreground)         | 105.4              | 62.5                |
| steps/s (foreground)          | 59.7               | 58.6                |
| frame time mean / σ / max, ms | 9.53 / 2.95 / 15.0 | 15.98 / 0.49 / 17.0 |
| after 5 s in background tab   | not measured       | TODO                |

What differed: with rAF the frame rate follows the display (≈ 105 frames/s); with `setInterval(16)`
it is pinned to the timer, **62.5 frames/s = 1000 / 16**, no matter what the monitor can do, so
about 40% of the display's refresh opportunities show nothing new and the motion looks less smooth
on a fast display. In this run the frame-time jitter was actually _lower_ with the timer (σ 0.49 vs
2.95 ms): a timer fires at a regular 16 ms, whereas rAF frames land on the display's own refresh
grid. So the cost of `setInterval` here is not noise in the frame time but the wrong rate and the
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

### Experiment 3 — variable timestep (`?exp=variable&autopilot=1`)

`simulate(dt)` once per frame with the real elapsed time. With `&autopilot=1` the ship holds
thrust and the HUD (and console) show its position after 5 s of simulated time. Compare in Chrome
DevTools → Performance → CPU: **No throttling** vs **6× slowdown**; repeat with plain
`?autopilot=1` (fixed step).

| Run                             | Position after 5 s (x, y)                                                  |
| ------------------------------- | -------------------------------------------------------------------------- |
| variable step, no throttling    | 640.000, 117.004 (HUD: 102.9 steps/s = 102.9 frames/s, one step per frame) |
| variable step, CPU 6× slowdown  | TODO                                                                       |
| **fixed step**, no throttling   | TODO (expected 640.000, 125.726, see below)                                |
| **fixed step**, CPU 6× slowdown | TODO (expected the same)                                                   |

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

The browser measurement fits the headless table: on this ≈ 103 Hz display the variable-step ship
ended at y = 117.004, between the 60 Hz (114.293) and 120 Hz (121.401) rows, while the fixed step
gives 125.726 on every row.

With a fixed step the trajectory is bit-identical regardless of frame rate. With a variable step it
depends on how the frames happened to fall: the integration error grows with `dt`, so a slow machine
literally simulates a different game. That is fatal for multiplayer (Lab 5), where client and server
must compute the same result from the same inputs, and for collisions (a 250 ms frame can tunnel
through a wall).

## Lab status

- [x] Vite project, `"type": "module"`, ESLint + Prettier, `.nvmrc`
- [x] `createLoop` (rAF + clamped accumulator) with steps/s, frames/s, frame time, HUD
- [x] `createInput` closure with `isDown` and `justPressed`
- [x] Pure `integrate`, wrap-around, no DOM in `src/sim/`
- [x] Interpolated rendering (wrap-aware, angle-aware), DPR-aware resizable canvas
- [x] Tuning notes written
- [x] Experiment 1 measured; experiment 2 foreground measured (background tab still to do)
- [ ] Experiment 3: remaining three browser runs (variable + throttle, fixed ± throttle)
- [ ] Tag `lab-01`
