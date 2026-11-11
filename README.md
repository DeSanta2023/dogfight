# Dogfight

A multiplayer-ready space dogfight built step by step in a JavaScript course (vanilla JS, ES
modules, Vite on the client, Node + `ws` on the server).

| Lab | Topic                                     | Tag      | Where to look                                             |
| --- | ----------------------------------------- | -------- | --------------------------------------------------------- |
| 01  | Event loop, fixed-timestep game loop      | `lab-01` | [Lab 01](#lab-01--the-game-loop)                          |
| 02  | Objects, prototypes, `this`, composition  | `lab-02` | [Lab 02](#lab-02--the-entity-model)                       |
| 03  | Promises, async/await, loading, lobby     | `lab-03` | [Lab 03](#lab-03--asynchronous-javascript)                |
| 04  | Node.js: EventEmitter, streams, WebSocket | `lab-04` | [Lab 04](#lab-04--nodejs-eventemitter-streams-websockets) |

## Run

```bash
nvm use              # Node 22.9 or newer (see .nvmrc)
npm install          # installs both workspaces (client/, server/) from the root

# development: TWO terminals
npm run dev:server   # terminal 1: game server on http://localhost:3000 (restarts on file change)
npm run dev          # terminal 2: Vite on http://localhost:5173, proxies /api and /ws to the server

# production-like: ONE process serves the built client and the API/WebSocket
npm run build        # client -> client/dist
npm start            # http://localhost:3000

npm test             # 170 tests (node:test) in both workspaces, no browser needed
npm run lint         # ESLint (flat config) + eslint-config-prettier
npm run format       # Prettier
```

Experiments (each prints its result; the README quotes them):

```bash
npm run determinism       # Lab 01: fixed vs variable timestep, headless
npm run this-bug          # Lab 02: the `this` bug and its three fixes
npm run prototypes        # Lab 02: delegation / `this` / Map-vs-object / prototype chain
npm run puzzles           # Lab 03: four microtask/task ordering puzzles (5th: /puzzles.html)
npm run load-timing       # Lab 03: sequential vs concurrent loading
npm run event-loop-order  # Lab 04: nextTick / promise / timeout / immediate
npm run blocking-demo     # Lab 04: a 300 ms handler freezes every client
npm run error-crash       # Lab 04: 'error' without a listener, unhandled rejection
npm run rss-experiment    # Lab 04: 200 MB log, slow client, rss over time (writes docs/rss.*)
```

Controls: **← → / A D** rotate, **↑ / W** thrust, **Space** fire, **R** restart, **Enter** chat,
**Esc** back to the lobby, **M** mute. The HUD at the top left shows steps/s, frames/s, frame time
and CPU work per frame (Lab 01); the one at the top right shows score, hp, deaths and active pickup
effects. Add `?seed=123` to the URL to get the same asteroids and pickups every run.

## Structure

```
package.json                npm workspaces: client, server; one lockfile, one ESLint/Prettier setup
client/                     everything that runs in the browser (Labs 01-03, plus the socket in Lab 04)
  index.html, vite.config.js
  src/main.js               wires loop + input + Game + rendering + lobby + room session
  src/loop.js, input.js     rAF + clamped accumulator; keyboard as a closure
  src/sim/                  the simulation: NO DOM, NO canvas, NO Math.random, no audio
  src/render/               canvas, interpolation, sprites, loading screen
  src/assets/               loader.js (fetch/retry/abort/loadAll), chaos.js (failure injection)
  src/net/connection.js     WebSocket wrapper: send queue + reconnect with jittered backoff   (Lab 04)
  src/net/session.js        RoomSession: roster, chat, join/rejoin protocol, events            (Lab 04)
  src/lobby.js, src/ui/     lobby model (EventTarget) and the DOM for lobby, room panel, errors
  test/, scripts/, tools/   100 tests; experiments; dev helper plugin (?delay=, real 404s)
server/                     Node, ESM, one dependency (ws)                                      (Lab 04)
  index.js                  entry: config, logger, signals (SIGINT/SIGTERM), last-resort handlers
  app.js                    createApp(): http + ws + rooms + match logs; start()/stop() (testable)
  config.js                 the ONLY reader of process.env; validates every value at start-up
  http.js                   node:http routes, static files with a traversal guard, body limit
  rooms.js                  Room / RoomManager extend EventEmitter (no sockets inside)
  protocol.js               the wire protocol and server-side validation of every message
  ws.js                     WebSocket lifecycle: join timeout, heartbeat, rate limit, slow clients
  ratelimit.js              token bucket
  log/matchlog.js, replay.js  NDJSON Transform -> file; replay as async generator / HTTP stream
  scripts/, test/           four experiments; 70 tests (unit + real sockets + real processes)
docs/                       rss.svg + rss.csv (Lab 04 graph)
```

## Lab 04 — Node.js: EventEmitter, streams, WebSockets

The game now has a **server**. It keeps the list of rooms, lets players join and leave, relays chat,
writes every room's history to disk and shuts down cleanly. Ship coordinates are _not_ sent yet
(Lab 05): the server only knows who is in which room. The client from Labs 01-03 stays as it was;
its lobby now reads the real `GET /api/rooms`, and **Join** opens a WebSocket.

```
browser ── GET /api/rooms ─────────────┐
   │                                   ▼
   │  ws://…/ws  (JSON, v1)      ┌── server/index.js ── config.js (env, validated)
   └────────────────────────────►│     app.js ── http.js   routes + static files
                                 │             └ ws.js     sockets: join timeout, heartbeat, limits
                                 │             └ rooms.js  Room / RoomManager (EventEmitter)
                                 └─ rooms emit events ──► ws.js (broadcast) + log/matchlog.js (NDJSON file)
```

### Try it (two windows)

```bash
npm run dev:server        # terminal 1
npm run dev               # terminal 2, open http://localhost:5173 in TWO windows
```

Pick a callsign and a room in both windows; each sees the other in the roster, chat with **Enter**,
**Esc** goes back to the lobby. To see reconnect: stop the server (Ctrl+C), watch the yellow
"Connection lost. Reconnecting in …" banner, type a message (it is queued), start the server again.
Everything the server wrote is in `server/logs/*.ndjson`; `GET /api/replays` lists them.

### What was built, milestone by milestone

**M1 - HTTP, config, shutdown** (`server/http.js`, `config.js`, `index.js`)

- Plain `node:http`, no framework. `GET /health`; `GET`/`POST /api/rooms` (JSON validated field by
  field, 400 lists every problem; 415 wrong content type; 413 body over `MAX_BODY_BYTES`; 405 with
  `Allow`). Everything else under `/api/` is a JSON 404. The built client is served from
  `client/dist` with correct MIME types.
- **Path traversal**: `..` (also `%2e%2e`, double-encoded, `\`, NUL) is rejected _before_ the disk
  is touched, and the resolved path must still start with the static root. Tested with raw sockets,
  because `fetch` normalises `..` away before sending.
- **Config**: `config.js` is the only file that reads `process.env`. Every value has a parser and a
  range; a bad value stops the server at start-up with _all_ problems listed (`PORT: "30o0" is not a
whole number`), not at 3 a.m. `npm run dev:server` uses `--env-file`, `npm start` an optional
  `server/.env`.
- **Graceful shutdown**: SIGINT/SIGTERM -> stop accepting, close every socket with 1001, close rooms,
  wait until every match log is flushed, exit with code **0** (tested by spawning the real process).
  A second signal exits immediately.

**M2 - rooms, protocol, WebSockets** (`rooms.js`, `protocol.js`, `ws.js`, `client/src/net/`)

- `Room extends EventEmitter` and knows nothing about sockets: `join`/`leave`/`chat` change the
  roster and _emit_ `joined`, `left`, `chat`, `empty`. `RoomManager` deletes a room when it becomes
  empty (a room created over HTTP that nobody joins is removed after `ROOM_IDLE_MS`). `ws.js`,
  the match log and the tests are all just listeners.
- **Protocol v1** (`protocol.js`), JSON text frames `{ "v": 1, "type": …, … }`:

  | direction | type      | fields                 | notes                                                  |
  | --------- | --------- | ---------------------- | ------------------------------------------------------ |
  | c -> s    | `join`    | `room`, `name`         | must come within 5 s of connecting                     |
  | c -> s    | `chat`    | `text` (1-300)         |                                                        |
  | c -> s    | `leave`   |                        | leaves the room, socket stays open                     |
  | s -> c    | `welcome` | `id`, `limits`         | right after connecting                                 |
  | s -> c    | `joined`  | `room` (with arena), … | the client starts the game now                         |
  | s -> c    | `roster`  | `players`              | someone came or went                                   |
  | s -> c    | `chat`    | `from`, `text`, `at`   |                                                        |
  | s -> c    | `error`   | `code`, `message`      | recoverable (room full, name taken): socket stays open |

- **Every incoming message is validated** (`parseClientMessage`): binary frame, size in _bytes_,
  JSON syntax, object shape, version, `type` (looked up with `Object.hasOwn`, so `"constructor"` is
  not a type), then each field. Unknown type / wrong shape -> close **1008**; not JSON -> **1007**;
  binary -> **1003**; too big -> **1009** (set by `ws` itself through `maxPayload` before the message
  is even parsed). Extra fields are dropped, so a client cannot smuggle `admin: true` through.
- **Join timeout** 5 s -> close 4001. **Heartbeat**: one timer pings everybody every 15 s; a socket
  that missed two pongs is `terminate()`d (a closed laptop lid is invisible to TCP for minutes).
- Every socket gets `ws.on('error', …)` as its **first** listener (see "crash and fix").
- **Client** (`net/connection.js`): a `WebSocket` wrapper with a **send queue** (messages written
  while offline go out, in order, after the next connect; capped at 50, oldest dropped) and
  **reconnect** with exponential backoff and jitter (`500 ms * 2^n`, capped at 15 s, "equal
  jitter" so the delay is never 0 and a restarted server is not hit by everyone at once). Closes that
  mean "you sent something wrong" (1003/1007/1008/1009) are _not_ retried. `net/session.js` re-sends
  `join` after every reconnect and copes with the server still holding the old socket
  (`name_taken` -> retry, instead of an error). Typing in the chat box never steers the ship.
- The DOM is built with `textContent` only: `<img src=x onerror=alert(1)>` in chat is shown as text.

**M3 - match log as a stream pipeline** (`log/matchlog.js`, `log/replay.js`)

- `events -> Transform (objects in, "line\n" out) -> fs.WriteStream`, joined by `stream.pipeline`.
  Every room gets a log (`room_created`, `joined`, `left`, `chat`, `room_closed`), flushed when the
  room is removed or the server stops. `write()` returns `false` when the buffer is full;
  `drained()` waits for the file (the experiment below hit that 3541 times for 220 MB).
- **Replay** is the same idea backwards: `createReadStream -> parser Transform (lines -> objects)`,
  exposed as an **async generator** (`for await (const event of replayEvents(file))`), and over HTTP as
  `GET /api/replays/:id`, which is just `pipeline(createReadStream(file), res)`. A corrupt line makes
  the iterator throw instead of hanging.

**M4 - abuse controls** (`ratelimit.js`, `ws.js`, `http.js`)

| Threat                       | Control                                                                                         | Where               |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| message flood                | token bucket, 10 msg/s, burst 20 -> close 1008                                                  | `ratelimit.js`      |
| giant frame                  | `maxPayload` 2 KB (ws closes with 1009)                                                         | `ws.js`             |
| giant HTTP body              | `Content-Length` checked early, running total checked too; 413; at most `limit` bytes ever held | `http.js`           |
| silent / dead connection     | join timeout 5 s, heartbeat, 2 missed pongs                                                     | `ws.js`             |
| too many connections / rooms | 200 sockets (close 1013), 50 rooms, room size, unique callsign                                  | `ws.js`, `rooms.js` |
| slow reader (2G phone)       | `bufferedAmount`: above 64 KB skip droppable chat, above 256 KB terminate                       | `safeSend`          |
| path traversal               | rejected before the disk, plus "still inside the root" check                                    | `http.js`           |
| slow-loris headers           | `headersTimeout` 10 s                                                                           | `app.js`            |

### Event loop

`npm run event-loop-order` (Node 22, Linux):

```
1. sync > nextTick > promise > queueMicrotask > setImmediate > setTimeout
2. setTimeout(0) vs setImmediate from the MAIN module, 200 fresh processes:
   timeout first 9 times, immediate first 191 times  -> not deterministic
3. the same pair inside an I/O callback, 200 runs: immediate first 200 of 200 -> deterministic
```

`nextTick` and promise callbacks run between phases, before the loop moves on; `nextTick` is drained
before promise jobs. From the main module the order of `setTimeout(0)` and `setImmediate` depends on
whether 1 ms had passed by the time the loop started. Inside an I/O callback (poll phase) the next
phase is _check_, where `setImmediate` runs, so it always wins.

**What if an HTTP handler takes 300 ms of CPU?** `GET /api/slow` (dev only, `ENABLE_SLOW_ROUTE`)
spins for 300 ms. `npm run blocking-demo`: 8 clients ask `GET /health` every 50 ms for 3 s, from a
_separate process_ (clients in the server's own thread would freeze with it and see nothing):

| run                                          | requests | p50    | p99        | max        |
| -------------------------------------------- | -------- | ------ | ---------- | ---------- |
| quiet                                        | 471      | 0.9 ms | 16.4 ms    | 19.1 ms    |
| a client also calls the blocking route (4 x) | 336      | 1.6 ms | **279 ms** | **280 ms** |
| same 300 ms as `await sleep(300)`            | 456      | 1.7 ms | 45 ms      | 57 ms      |

JavaScript runs on one thread, so while a handler computes, _nobody_ is served - not `/health`, not
chat, not the heartbeat (a long enough freeze makes healthy clients look dead and get terminated).
Waiting is free (`await`); computing is not. CPU-heavy work belongs in a worker thread or another
process. (The 3 s runs are short, so p99 of the last two rows is noisy; the maximum of the blocking
row is the point.)

### Backpressure: memory while a slow client downloads a 200 MB log

`npm run rss-experiment` writes a 221 MB log through the Transform pipeline (waiting for `drain`
3541 times; rss stayed at 78-103 MB), then serves it to a client that reads 25 MB/s, two ways, each in
its own process, rss sampled every 100 ms:

![rss while a 200 MB log is downloaded](docs/rss.svg)

| way                                     | time  | rss start -> max     | after the first second                 |
| --------------------------------------- | ----- | -------------------- | -------------------------------------- |
| `pipeline(createReadStream(file), res)` | 7.5 s | 54.9 -> **101.3** MB | flat (95.7 -> 101.3, +5.6 MB in 6.5 s) |
| `res.end(await readFile(file))`         | 8.2 s | 54.8 -> **321.8** MB | flat at the file size + overhead       |

The streaming curve is **flat**: the first second is process warm-up (about 40 MB: V8 heap, HTTP
buffers), then it moves by a few MB while 200 MB passes through. The naive curve jumps by the size
of the file before the first byte leaves and stays there, _per download_: ten slow clients would
need 2 GB. `pipeline` does the bookkeeping: `res.write()` returning `false` pauses the file reader
until `drain`, so at most one 64 KB chunk plus the socket buffers are in flight, and if the client
disconnects, both streams are destroyed and the file descriptor is closed. (Raw data in
`docs/rss.csv`; the client of the experiment lives in the same process as the server's end of the
socket, which is why the absolute numbers include a little client overhead.)

### Crash and fix: `'error'` without a listener

`npm run error-crash` runs each case in a child process:

```
# emit('error') with NO listener           exit code 1   Error: socket exploded
# emit('error') WITH a listener            exit code 0   handled: socket exploded / still alive
# rejected promise nobody awaits           exit code 1   Error: disk full
# …with a process 'unhandledRejection'     exit code 1   logged: disk full
```

`EventEmitter.emit('error')` is special: with no `'error'` listener it **throws** the error from
`emit()`, and a throw nobody catches ends the process. Sockets, streams and rooms are all emitters,
so one flaky client (reset connection, bad frame) whose socket has no `'error'` handler would take
every room down. The Promise twin is a rejected promise nobody awaits: since Node 15 that is also a
crash. What the server does about it:

- `ws.on('error', …)` is the first listener of every socket (`server/ws.js`) and there is a test that
  emits an error on a live socket and checks the server keeps working;
- every `ws.send` has a callback, and a failed send terminates only that socket;
- `pipeline` is used instead of bare `.pipe()` (which does not forward errors or clean up); the match
  log's `done` promise always has a `.catch`;
- as the last line of defence `index.js` logs `uncaughtException` / `unhandledRejection` and exits
  with 1: after an unknown exception the process state is unknown, so the honest move is to let a
  supervisor restart it, not to keep serving.

**Bugs found while building this (and kept as tests)**

- The shutdown timers were `unref()`ed, so after the HTTP server closed there was nothing left to keep
  the process alive: it exited with code 0 _in the middle of_ flushing the logs and never printed
  "bye". Those two timers must keep the loop alive. (`test/process.test.js`.)
- `readBody` destroyed the request on an oversized upload, which also killed the socket, so the client
  got a connection error instead of `413`. Now it stops collecting at the limit, answers 413 and closes
  the connection afterwards. (`test/http.test.js`, the chunked-upload test.)
- `fetch` and the browser normalise `..` out of a URL, so traversal tests that use them prove nothing;
  they send raw request lines through `net.connect`.

### Tests

`npm test`: **170** (client 100, server 70). The server tests use no mocks for the interesting
parts: a real server on port 0 in a temp directory, real `ws` clients, and real child processes for
signals and bad config. Highlights: validation of every kind of bad message and the close code it
earns; join timeout (4001), heartbeat with a client that never pongs, rate limit, `maxPayload`,
connection cap, name taken / room full leave the socket open, an emitted socket `'error'` does not
crash, graceful shutdown (1001 for clients, complete log on disk, exit code 0 for SIGINT and
SIGTERM), config errors listed together, path traversal over raw sockets, chunked body cap, log
round-trip and replay of lines cut at arbitrary chunk boundaries. The client tests drive
`Connection`/`RoomSession` with a fake WebSocket: queue order, handshake first, backoff values with
a fixed random, no retry for 1008, retry for 1001/1006, stale events of a replaced socket ignored.

### Defence (5 minutes)

1. `npm run build && npm start`, open `http://localhost:3000` in two windows; join the same room;
   chat both ways; Esc in one window and watch the roster change in the other.
2. Ctrl+C in the server terminal: it prints `shutting down`, `bye`, exit code 0; the log file is in
   `server/logs`.
3. Show `docs/rss.svg` and say why the green line is flat; show `npm run error-crash`.

### Not done (stretch goals)

Gzip of the log, an SSE spectator endpoint and a Fastify port were not attempted.

## Lab 03 — asynchronous JavaScript

The game no longer starts instantly. It **loads** (manifest → sprites, sounds, arena config, with a
real progress bar), shows a **lobby** (room list polled from `/api/rooms`), and only then starts a
local match with the chosen room's arena settings. Everything that waits goes through Promises /
`async`/`await`, and every wait can be cancelled.

> Since Lab 04 the browser code lives in `client/`: read every path in this section as
> `client/<path>`. `/api/rooms` is no longer a static JSON; it comes from the real server.

### Flow

```
boot() ─ fetch manifest (withRetry) ─ loadAll (Promise.all, progress bar) ─ lobby ─ Join ─ game
                                         │ fails          │ rooms unreachable
                                         ▼                ▼
                                   Retry button      "Retrying automatically…" + Retry now
```

### Where things are

| File                         | Job                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `src/assets/loader.js`       | `fetchJson` (checks `ok`), `loadImage/Audio/Json`, `withRetry`, `loadAll`         |
| `src/render/loading.js`      | canvas loading screen, eased real progress                                        |
| `src/render/sprites.js`      | sprite sheet + atlas, `drawImage` with a source rect                              |
| `src/audio.js`, `src/hud.js` | Web Audio and HUD; they **listen** to game events                                 |
| `src/lobby.js`               | `class Lobby extends EventTarget`: no DOM, tested in Node                         |
| `src/ui/*.js`, `ui.css`      | the DOM for lobby and retry screens                                               |
| `tools/dev-api.js`           | Vite plugin: `?delay=N`, real 404s for `/assets/*` (rooms API moved to `server/`) |
| `public/assets/…`            | manifest, sprites, sounds, arena config (generated by `tools/make-assets.py`)     |

### Decisions

- **`fetch` does not reject on 404/500.** One `fetchJson` wraps it and throws `HttpError` when
  `!response.ok`; every loader goes through it.
- **Retry policy (`withRetry`).** Exponential backoff with full jitter. It retries only _transient_
  errors: 5xx, timeouts, network errors. It never retries 4xx (the file is not going to appear),
  aborts, or corrupt JSON (`SyntaxError`).
- **Cancellation.** One `AbortSignal` per load; each request also gets `AbortSignal.timeout(4000)`
  combined with `AbortSignal.any`. If a required asset fails, its siblings are aborted too.
- **Per-asset policy in the manifest:** `onError: "fail" | "fallback" | "skip"`. The sprite sheet is
  `fallback` (the game draws vector shapes), arena config is `fallback` (defaults), sounds are `skip`.
- **Audio.** Sounds are downloaded and decoded _during loading_ with an `OfflineAudioContext`
  (no gesture needed). The real `AudioContext` is created on the first click/key, because browsers
  block audio before a user gesture. The Join click is that gesture.
- **The simulation never imports audio.** `Game.events` is an `EventTarget`; the game dispatches
  `CustomEvent("fired" | "hit" | "exploded" | "collected")` with plain-data `detail`. `audio.js` and
  `hud.js` subscribe from `main.js`. Delete both and the sim and its tests are unchanged
  (`test/events.test.js`).
- **Lobby.** `refresh()` never rejects; it reports through events (`status`, `rooms`). A sequence
  number discards a late answer from an older request, and the previous in-flight request is
  aborted. Polling is a chain of `sleep`s (not `setInterval`), so requests never overlap.
  `join()` stops polling, which aborts anything in flight (no leaked timers after leaving).
  The lobby keeps showing the last good list when a refresh fails.

### Sequential vs concurrent loading

`npm run load-timing` (7 assets, +300 ms latency per request, median of 5 runs, real HTTP):

| mode                         | Node    | Chromium (`?load=sequential`) |
| ---------------------------- | ------- | ----------------------------- |
| sequential `await` in a loop | 2124 ms | 2143 ms                       |
| `Promise.all`                | 312 ms  | 611 ms                        |

Sequential ≈ the **sum** (7 × 300). `Promise.all` ≈ the **slowest**. In the browser concurrent is
~2×300, not 1×300: Chromium opens at most **6 connections per host** over HTTP/1.1, so the 7th
request waits for a free slot. I checked it directly: 5 parallel requests → 311 ms, 6 → 316,
7 → 615, 8 → 616, 12 → 622.

Try it: `?latency=300` (adds delay to every asset) and `?load=sequential`.

### Five ordering puzzles

Each prediction was written before running (`npm run puzzles`; #5 in the browser at `/puzzles.html`).

**1.** `log('A'); Promise.resolve().then(B).then(C); queueMicrotask(D); log('E')`
→ **A E B D C**. Sync code first. Then the microtask queue is FIFO: B and D were queued before C,
because C is queued only after B finishes.

**2.** `async f(){ log('f1'); await g(); log('f2') }` with `g` logging `g1`; then
`Promise.resolve().then(p1).then(p2); log('sync')`
→ **f1 g1 sync f2 p1 p2**. `f` runs synchronously up to the `await`; the rest of `f` is a
microtask queued before `p1`.

**3.** `setTimeout(T1); Promise.resolve().then(()=>{M1; setTimeout(T2)}).then(M2); setTimeout(T3); log('S')`
→ **S M1 M2 T1 T3 T2**. All microtasks (even chained ones) drain before the next task. T2 was
scheduled later than T1 and T3, so it runs last.

**4.** `async a(){return 1}`, `async b(){return Promise.resolve(2)}`, plus a three-step `.then` chain
→ **a 1, t1, t2, b 2, t3**. Returning a promise from an async function costs two extra microtask
ticks (the promise is adopted via a thenable job), so `b` is later than `t2`.

**5.** (browser) `setTimeout(timeout); rAF(raf → microtask in raf); rAF(raf 2); .then(microtask); sync`
→ **sync, microtask**, then `raf → microtask in raf → raf 2` (each rAF callback gets its own
microtask checkpoint). Whether `timeout` runs before or after `raf` is **not specified**: they
are different task sources. I saw both: raf first 9 of 12 runs in one batch, 16 vs 14 of 30 in
another. Lesson: never rely on that order.

### Failure gallery

Reproduce with `?chaos=` (dev only; `?chaos=404,json` combines). Failures are injected on the first
attempt only, so Retry really works.

| URL              | What breaks                | What the player sees                                                                                      |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `?chaos=404`     | sprite sheet is a real 404 | Game starts with vector shapes; HUD says `fallbacks: sprites`. No retry (4xx).                            |
| `?chaos=json`    | arena config is corrupt    | Game starts with the default arena; no retry (`SyntaxError`).                                             |
| `?chaos=timeout` | an asset hangs             | Retried once; if it still fails: "Could not load the game" + **Retry** button.                            |
| `?chaos=abort`   | load is cancelled mid-way  | "Reason: cancelled" + **Retry**; the retry loads normally.                                                |
| `?chaos=rooms`   | `/api/rooms` times out     | Lobby: "Server not responding (timed out). Retrying automatically…" + **Retry now**; recovers on its own. |

All five were run in headless Chromium: no uncaught errors, the game starts in 404/json/rooms, and
Retry leads to the lobby in timeout/abort. Screenshots go in `docs/` when you run them yourself.

### Dev-server notes

- `?delay=N` on any URL slows that response (loading-bar demo).
- Vite's SPA fallback answers `200 index.html` for missing files, so a "missing sprite" would not be
  a 404. `dev-api.js` turns missing `/assets/*` into real 404s.
- A Vite `configureServer` hook must **not return** anything (a returned function is a post hook;
  `middlewares.use()` returns the app, which crashed startup).

### URL switches

`?seed=N` · `?latency=N` · `?load=sequential` · `?chaos=404,json,timeout,abort,rooms` ·
`?exp=block|interval|variable` (Lab 01) · `&autopilot=1` (skip loading and lobby, vector art).
Keys: **Esc** back to the lobby, **M** mute.

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

`npm test` runs the tests (`node --test`, no dependencies) covering `Vector2` purity, the one-level
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
- [x] Console experiments (`npm run prototypes`)
- [x] Tag `lab-02`

**Lab 03**

- [x] Manifest + `loadAll` (`Promise.all`, real progress bar), `withRetry`, `AbortSignal`
- [x] Sprites from a sheet; Web Audio decoded during loading, unlocked on a gesture
- [x] Sim emits events; audio/HUD listen (sim does not import audio)
- [x] Lobby (`EventTarget`), polling, timeouts, abort on leave
- [x] Five puzzles, failure gallery, sequential-vs-concurrent timings
- [x] Tag `lab-03`

**Lab 04**

- [x] npm workspaces (`client/`, `server/`), one lockfile, env config validated at start-up
- [x] `node:http` server: static files with traversal guard, `GET/POST /api/rooms`, `GET /health`, graceful shutdown (exit 0)
- [x] `Room`/`RoomManager` on `EventEmitter`; empty rooms are deleted
- [x] WebSocket protocol v1 with server-side validation, 5 s join timeout, heartbeat, `error` listener on every socket
- [x] Client socket wrapper: send queue, reconnect with jittered backoff; chat and roster UI
- [x] Match log: object-mode Transform -> NDJSON file via `pipeline`; replay as async generator and HTTP stream
- [x] Rate limit, `maxPayload`, room/connection caps, slow-client policy (`bufferedAmount`)
- [x] README: rss graph, event loop write-up (blocking demo), crash-and-fix, 170 tests
- [ ] Tag `lab-04`
