import { abortableSleep, fetchJson, isAbortError } from './assets/loader.js';

/**
 * The lobby: which rooms exist, how full they are, and "Join". No DOM in here: the model only
 * fetches and announces; src/ui/lobby-view.js listens and renders.
 *
 * Events (CustomEvent, `detail` in brackets):
 *   "status"  { status, error }   'loading' | 'ok' | 'error' (the room list from the last
 *                                 success stays available while the status is 'error')
 *   "rooms"   { rooms }           a fresh list arrived
 *   "joined"  { room, name }      the player chose a room; polling has already stopped
 *
 * Why chained sleeps and not setInterval: with setInterval a slow server makes requests pile up
 * (a new one starts before the old one has answered). Here the next refresh is scheduled only
 * after the previous one has settled, so there is never more than one in flight.
 *
 * Cancellation: start() creates one AbortController for the whole time the lobby is visible.
 * Every request listens to its signal, and so does the pause between requests; stop() aborts
 * both, so leaving the lobby leaves nothing running and no late response can touch a screen
 * that is gone.
 */
export class LobbyError extends Error {
  name = 'LobbyError';
}

export class Lobby extends EventTarget {
  rooms = [];
  status = 'idle'; // idle | loading | ok | error
  error = null;
  updatedAt = 0; // Date.now() of the last successful refresh

  #url;
  #timeoutMs;
  #intervalMs;
  #fetchImpl;
  #lifecycle = null; // AbortController of the "lobby is visible" period
  #loop = null; // promise of the polling loop (so stop() can wait for it)
  #inflight = null; // AbortController of the request currently running
  #seq = 0; // number of the newest request: older answers are stale

  /** `url` is a string, or a function returning one (the chaos mode delays only the first call). */
  constructor({
    url = 'api/rooms',
    timeoutMs = 2500,
    intervalMs = 3000,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    super();
    this.#url = typeof url === 'function' ? url : () => url;
    this.#timeoutMs = timeoutMs;
    this.#intervalMs = intervalMs;
    this.#fetchImpl = fetchImpl;
  }

  get polling() {
    return this.#lifecycle !== null;
  }

  #setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  /**
   * One request. Resolves to true when a fresh list arrived. It never rejects: a failure becomes
   * status 'error'. A request that was superseded by a newer one, or cancelled by stop(), is
   * silently dropped (it is not an error the player should see).
   */
  async refresh() {
    const id = ++this.#seq;
    this.#inflight?.abort(); // the newest request wins
    const own = new AbortController();
    this.#inflight = own;
    const lifecycle = this.#lifecycle?.signal;
    const signal = lifecycle ? AbortSignal.any([lifecycle, own.signal]) : own.signal;

    this.#setStatus('loading');
    try {
      const data = await fetchJson(this.#url(), {
        signal,
        timeoutMs: this.#timeoutMs, // every request gets AbortSignal.timeout via fetchJson
        fetchImpl: this.#fetchImpl,
      });
      // Code after an await is a NEW turn: the world may have moved on while we waited.
      if (id !== this.#seq || signal.aborted) return false;
      if (!Array.isArray(data?.rooms)) throw new Error('Malformed /api/rooms response');
      this.rooms = data.rooms;
      this.updatedAt = Date.now();
      this.#setStatus('ok');
      this.dispatchEvent(new CustomEvent('rooms', { detail: { rooms: this.rooms } }));
      return true;
    } catch (error) {
      if (id !== this.#seq || signal.aborted || isAbortError(error)) return false;
      this.#setStatus('error', error);
      return false;
    } finally {
      if (this.#inflight === own) this.#inflight = null;
    }
  }

  /** Begin polling (refresh now, then every `intervalMs` after each answer). Idempotent. */
  start() {
    if (this.#lifecycle) return;
    this.#lifecycle = new AbortController();
    const { signal } = this.#lifecycle;
    this.#loop = (async () => {
      while (!signal.aborted) {
        await this.refresh();
        if (signal.aborted) break;
        try {
          await abortableSleep(this.#intervalMs, signal);
        } catch {
          break; // aborted while waiting
        }
      }
    })();
  }

  /** Leave the lobby: cancel the pending request and the pause. Resolves once the loop is gone. */
  async stop() {
    const loop = this.#loop;
    this.#lifecycle?.abort();
    this.#inflight?.abort();
    this.#lifecycle = null;
    this.#loop = null;
    await loop;
  }

  /** Choose a room. Throws LobbyError for the things a player can fix (name, full room). */
  join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new LobbyError(`Unknown room "${roomId}"`);
    if (room.players >= room.maxPlayers) throw new LobbyError(`${room.name} is full`);
    const callsign = String(name ?? '').trim();
    if (!callsign) throw new LobbyError('Pick a callsign first');

    this.stop(); // leaving the lobby: no orphaned requests (the promise is not needed here)
    this.dispatchEvent(new CustomEvent('joined', { detail: { room, name: callsign } }));
    return { room, name: callsign };
  }
}
