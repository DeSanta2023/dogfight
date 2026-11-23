/**
 * On-screen buttons for a phone (a PWA installed on a phone has no keyboard). They press the SAME
 * keys the keyboard does: a pointer going down fires a real `keydown` with the key's `code`, going
 * up fires `keyup`, so input.ts, prediction and the server cannot tell a finger from a keyboard.
 *
 * Shown only on touch screens (`pointer: coarse`) and only while a room panel is open; everything
 * else is CSS (`:has`) so main.ts has nothing to remember.
 */
const BUTTONS = [
  { code: 'ArrowLeft', label: '◀', title: 'Turn left', side: 'left' },
  { code: 'ArrowRight', label: '▶', title: 'Turn right', side: 'left' },
  { code: 'ArrowUp', label: '▲', title: 'Thrust', side: 'right' },
  { code: 'Space', label: '●', title: 'Fire', side: 'right' },
] as const;

export function mountTouchControls(
  parent: HTMLElement,
  target: EventTarget = window,
  force = false,
): () => void {
  if (!force && !globalThis.matchMedia?.('(pointer: coarse)').matches) return () => {};

  const style = document.createElement('style');
  style.textContent = `
    #touch { display: none; position: fixed; inset: auto 0 0 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
      justify-content: space-between; pointer-events: none; z-index: 5; touch-action: none; user-select: none; -webkit-user-select: none; }
    body:has(#room-panel:not([hidden])) #touch { display: flex; }
    #touch .pad { display: flex; gap: 12px; }
    #touch button { pointer-events: auto; width: 72px; height: 72px; border-radius: 50%; border: 2px solid #60a5fa;
      background: rgba(5, 7, 15, 0.55); color: #e5e7eb; font-size: 28px; touch-action: none; -webkit-tap-highlight-color: transparent; }
    #touch button.on { background: rgba(37, 99, 235, 0.65); }`;
  const bar = document.createElement('div');
  bar.id = 'touch';
  const pads = {
    left: document.createElement('div'),
    right: document.createElement('div'),
  };
  for (const pad of Object.values(pads)) {
    pad.className = 'pad';
    bar.append(pad);
  }

  const press = (code: string, down: boolean) =>
    target.dispatchEvent(
      new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }),
    );

  for (const { code, label, title, side } of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    const release = () => {
      if (!button.classList.contains('on')) return;
      button.classList.remove('on');
      press(code, false);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId); // keep the press even if the finger slides off
      button.classList.add('on');
      press(code, true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      button.addEventListener(type, release);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    pads[side].append(button);
  }
  parent.append(style, bar);
  return () => {
    style.remove();
    bar.remove();
  };
}
