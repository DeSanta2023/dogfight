/**
 * Keyboard input as a closure: `down` and `pressed` are private, the returned object is the API.
 *
 * isDown(code)      — level-triggered: true while the key is held.
 * justPressed(code) — edge-triggered: true from the keydown until the next endStep().
 * endStep()         — call once after every SIMULATION step (not every rendered frame).
 *
 * Why endStep() per simulation step: the simulation may run 0, 1 or several steps per
 * rendered frame. If we cleared `pressed` per frame, a press that happened during a frame
 * with 0 steps would be lost, and in a frame with 2 steps it would fire twice.
 * Clearing after each step makes "just pressed" mean "the next step sees it exactly once".
 */
const GAME_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);

export function createInput(target) {
  const down = new Set();
  const pressed = new Set();

  target.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // stop arrows/space from scrolling the page
    if (!down.has(e.code)) pressed.add(e.code); // ignore OS key-repeat
    down.add(e.code);
  });
  target.addEventListener('keyup', (e) => down.delete(e.code));
  // A key released while the window is unfocused never fires keyup: avoid "stuck" keys.
  globalThis.addEventListener?.('blur', () => down.clear());

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
  };
}
