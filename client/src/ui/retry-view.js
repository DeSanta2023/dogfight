/**
 * The "something failed and the game cannot start" screen: a clear message and a Retry button.
 * The canvas keeps drawing the background; this is a plain DOM overlay so the button is
 * focusable and works with the keyboard.
 */
export function mountRetryView(root, { title, detail, onRetry, buttonLabel = 'Retry' }) {
  const button = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: buttonLabel,
  });
  button.addEventListener('click', onRetry, { once: true });

  const panel = document.createElement('section');
  panel.className = 'panel error';
  panel.setAttribute('role', 'alert');
  const heading = Object.assign(document.createElement('h1'), { textContent: title });
  const text = Object.assign(document.createElement('p'), { textContent: detail });
  panel.append(heading, text, button);

  root.replaceChildren(panel);
  root.hidden = false;
  button.focus();

  return function unmount() {
    root.replaceChildren();
    root.hidden = true;
  };
}
