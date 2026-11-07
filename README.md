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

<!-- TODO (required by the lab): write down what YOU changed while tuning and why.
     Starting values are in TUNING in src/sim/ship.js: turnRate 3.6, thrustAccel 340,
     drag 0.9, maxSpeed 460. Example of the format:
     - drag 0.5 -> 0.9: ship felt like it was on ice, hard to stop; now it settles in ~2 s. -->

## Experiments

Open the game with the URL parameter shown for each experiment (`http://localhost:5173/?exp=…`).
Machine used: <!-- TODO: CPU, browser + version, display refresh rate, OS -->

### Experiment 1 — blocking the frame (`?exp=block`)

`render` busy-waits 100 ms every 60th frame (`while (performance.now() < t + 100) {}`).

| Metric (HUD)                  | Normal | `?exp=block` |
| ----------------------------- | ------ | ------------ |
| frames/s                      | TODO   | TODO         |
| steps/s                       | TODO   | TODO         |
| frame time mean / σ / max, ms | TODO   | TODO         |
| work/frame, ms                | TODO   | TODO         |

What the player sees: <!-- TODO: e.g. a visible hitch once per second; screenshot of the HUD -->

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

| Metric                        | rAF (normal) | `setInterval(16)` |
| ----------------------------- | ------------ | ----------------- |
| frames/s (foreground)         | TODO         | TODO              |
| frame time mean / σ / max, ms | TODO         | TODO              |
| after 5 s in background tab   | TODO         | TODO              |

What differed: <!-- TODO. Expected explanation below. -->

Explanation: `setInterval` is a **task** scheduled by a timer. 16 ms ≠ 16.667 ms, so it drifts
against the display refresh; the callback can fire right after a paint or right before one, so some
frames are shown twice and others skipped (higher σ, visible judder). A timer task also is not
tied to the rendering step: the browser decides separately when to paint. Background tabs throttle
timers (≈1 Hz) but may still run them, while rAF is paused entirely. The accumulator's
0.25 s clamp is what keeps the game sane when the tab comes back.
`requestAnimationFrame` runs _right before the next paint_, receives the frame timestamp, follows
the actual refresh rate (60/120/144 Hz) and stops when the page is hidden.

### Experiment 3 — variable timestep (`?exp=variable&autopilot=1`)

`simulate(dt)` once per frame with the real elapsed time. With `&autopilot=1` the ship holds
thrust and the console logs its position after 5 s of simulated time. Compare in Chrome DevTools
→ Performance → CPU: **No throttling** vs **6× slowdown**; repeat with plain `?autopilot=1`
(fixed step).

| Run                             | Position after 5 s (x, y) |
| ------------------------------- | ------------------------- |
| variable step, no throttling    | TODO                      |
| variable step, CPU 6× slowdown  | TODO                      |
| **fixed step**, no throttling   | TODO                      |
| **fixed step**, CPU 6× slowdown | TODO                      |

Headless confirmation (`npm run determinism`: the same `integrate()` in Node, 5 s of held thrust,
different frame-time patterns; x is always 640 because the ship points up):

| Frame pattern     | Fixed step (y) | Variable step (y) |
| ----------------- | -------------- | ----------------- |
| 60 Hz             | 342.327        | 336.191           |
| 120 Hz            | 342.327        | 334.242           |
| 144 Hz            | 342.327        | 332.899           |
| jittery 10–30 ms  | 342.327        | 346.157           |
| throttled ~100 ms | 342.327        | 391.498           |

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
- [ ] Experiments 1–3 measured on my machine and filled in above
- [ ] Tag `lab-01`
