/**
 * Sound effects with the Web Audio API.
 *
 * Two constraints shape this module:
 *
 *  1. Autoplay policy: a real AudioContext may only start producing sound after a user gesture.
 *     So it is created in unlock(), which main.js calls from the first click / key press.
 *  2. Decoding must happen DURING loading, not on the first shot (decoding on demand causes an
 *     audible click and a hitch). decodeAudioData needs *a* context, but not the audible one: an
 *     OfflineAudioContext decodes without any gesture, and the resulting AudioBuffers can be
 *     played by any context.
 *
 * The simulation never imports this file. It only publishes events; attach() subscribes to them.
 */

const CONTEXT = globalThis.AudioContext ?? globalThis.webkitAudioContext;
const OFFLINE = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;

export function createAudio({ ContextClass = CONTEXT, OfflineClass = OFFLINE } = {}) {
  const buffers = new Map(); // sound name -> decoded AudioBuffer
  const lastPlayed = new Map(); // sound name -> performance.now() of its last start
  let ctx = null; // the audible context: only exists after unlock()
  let master = null;
  let muted = false;

  const audio = {
    /** False in browsers without Web Audio: the game then simply runs silent. */
    get available() {
      return Boolean(ContextClass && OfflineClass);
    },

    /** 'locked' until the first gesture, then the real AudioContext state ('running', ...). */
    get state() {
      return ctx ? ctx.state : 'locked';
    },

    get muted() {
      return muted;
    },

    /** A context for loadAudio() to decode with: no gesture needed, nothing audible. */
    createDecoder() {
      return new OfflineClass(1, 1, 44100);
    },

    setBuffers(decoded) {
      for (const [name, buffer] of Object.entries(decoded))
        if (buffer) buffers.set(name, buffer);
    },

    has: (name) => buffers.has(name),

    /** Call from a user-gesture handler (click, keydown). Safe to call repeatedly. */
    async unlock() {
      if (!audio.available) return false;
      if (!ctx) {
        ctx = new ContextClass();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.6;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') await ctx.resume();
      return ctx.state === 'running';
    },

    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.6;
      return muted;
    },

    /** Fire-and-forget. Every play makes a new, cheap AudioBufferSourceNode (they are one-shot). */
    play(name, { volume = 1, rate = 1, minGapMs = 35 } = {}) {
      const buffer = buffers.get(name);
      if (!ctx || ctx.state !== 'running' || !buffer) return false;

      // A bullet storm must not stack dozens of identical sounds into a wall of noise.
      const now = performance.now();
      if (now - (lastPlayed.get(name) ?? -Infinity) < minGapMs) return false;
      lastPlayed.set(name, now);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(master);
      source.start();
      return true;
    },

    /**
     * Subscribe to a game's event bus. Returns a function that unsubscribes (call it when that
     * game is replaced, so a dead game's events cannot make noise).
     */
    attach(events) {
      const on = (type, listener) => events.addEventListener(type, listener);
      const jitter = () => 0.94 + Math.random() * 0.12; // slight pitch variation: less robotic

      const listeners = {
        fired: () => audio.play('shoot', { volume: 0.45, rate: jitter() }),
        hit: ({ detail }) =>
          audio.play('hit', {
            volume: detail.target === 'ship' ? 1 : 0.6,
            rate: jitter(),
          }),
        exploded: ({ detail }) =>
          detail.kind === 'ship'
            ? audio.play('explode', { volume: 1, rate: 0.75, minGapMs: 0 })
            : audio.play('explode', {
                volume: 0.45 + 0.15 * (detail.size ?? 1),
                rate: 1.35 - 0.2 * (detail.size ?? 1), // big rocks rumble lower
              }),
        collected: () => audio.play('pickup', { volume: 0.8 }),
      };
      for (const [type, listener] of Object.entries(listeners)) on(type, listener);
      return () => {
        for (const [type, listener] of Object.entries(listeners)) {
          events.removeEventListener(type, listener);
        }
      };
    },
  };

  return audio;
}
