/**
 * Network conditioner: makes a perfect localhost connection behave like a bad one, so lag,
 * jitter and loss can be FELT and measured without leaving the room.
 *
 *   lag      added round-trip time in ms; each direction waits lag/2
 *   jitter   extra random 0..jitter ms per packet and direction. Packets get independent delays,
 *            so they can arrive OUT OF ORDER (just like UDP; the game must survive that)
 *   loss     probability 0..1 that a packet silently disappears
 *
 * It is applied to GAME packets only (input, ping, snapshot, pong), never to join/chat.
 * (A real WebSocket is TCP: it never loses or reorders. The conditioner simulates what a UDP
 * game, or a bad link behind a proxy that drops frames, would see. See the README network note.)
 */
export class Conditioner {
  sent = 0;
  dropped = 0;

  constructor({
    lag = 0,
    jitter = 0,
    loss = 0,
    random = Math.random,
    setTimer = (fn, ms) => setTimeout(fn, ms), // a wrapper: browsers refuse setTimeout called as a method
  } = {}) {
    this.lag = lag;
    this.jitter = jitter;
    this.loss = loss;
    this.random = random;
    this.setTimer = setTimer;
  }

  get active() {
    return this.lag > 0 || this.jitter > 0 || this.loss > 0;
  }

  /** Run `fn` after this packet's artificial delay, or never (lost). Returns false when lost. */
  deliver(fn) {
    this.sent++;
    if (this.loss > 0 && this.random() < this.loss) {
      this.dropped++;
      return false;
    }
    const delay = this.lag / 2 + this.random() * this.jitter;
    if (delay <= 0) fn();
    else this.setTimer(fn, delay);
    return true;
  }

  static fromParams(params) {
    const num = (key) => {
      const n = Number(params.get(key));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return new Conditioner({
      lag: num('lag'),
      jitter: num('jitter'),
      loss: Math.min(1, num('loss') / 100), // ?loss=5 means 5 %
    });
  }
}
