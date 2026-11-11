/**
 * DOM for "I am in a room": roster, chat and a connection banner, as a small panel in the corner
 * (the game keeps running underneath). It listens to a RoomSession and calls sendChat().
 * Everything that came from the network is written with textContent, never innerHTML: a chat
 * message "<img onerror=...>" is shown as text, not run.
 *
 * Enter focuses the chat box, Enter in it sends, Esc in it gives the keyboard back to the game.
 */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const clock = (at) =>
  new Date(at ?? Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

export function mountRoomView(root, session) {
  const title = el('h2', {}, session.room?.name ?? 'Room');
  const banner = el('p', { className: 'banner', role: 'status' });
  const roster = el('ul', { className: 'roster' });
  const log = el('ol', { className: 'chat-log' });
  const field = el('input', {
    type: 'text',
    maxLength: 300,
    placeholder: 'Enter to chat…',
    autocomplete: 'off',
  });
  field.setAttribute('aria-label', 'Chat message');
  const form = el('form', { className: 'chat-form' }, field);

  function line(text, className = '') {
    const item = el('li', { className }, text);
    log.append(item);
    while (log.children.length > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  let names = new Set(session.players.map((p) => p.name));
  function renderRoster() {
    roster.replaceChildren(
      ...session.players.map((p) =>
        el('li', { className: p.id === session.you ? 'me' : '' }, p.name),
      ),
    );
    const now = new Set(session.players.map((p) => p.name));
    for (const n of now) if (!names.has(n)) line(`${n} joined`, 'system');
    for (const n of names) if (!now.has(n)) line(`${n} left`, 'system');
    names = now;
  }

  function renderStatus({ state, delayMs } = session) {
    banner.hidden = state === 'joined';
    banner.textContent =
      state === 'reconnecting'
        ? `Connection lost. Reconnecting${delayMs ? ` in ${(delayMs / 1000).toFixed(1)} s` : ''}…`
        : state === 'connecting'
          ? 'Connecting…'
          : state === 'closed'
            ? 'Disconnected'
            : '';
  }

  const on = (name, fn) => {
    session.addEventListener(name, fn);
    return () => session.removeEventListener(name, fn);
  };
  const offs = [
    on('joined', () => {
      title.textContent = session.room.name;
      renderRoster();
    }),
    on('roster', renderRoster),
    on('chat', ({ detail }) =>
      line(`${clock(detail.at)} ${detail.from}: ${detail.text}`),
    ),
    on('status', ({ detail }) => renderStatus(detail)),
  ];

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (session.sendChat(field.value)) field.value = '';
  });
  field.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.stopPropagation(); // do not also leave the room
      field.blur();
    }
  });
  const onKey = (event) => {
    if (event.code === 'Enter' && document.activeElement !== field) {
      event.preventDefault();
      field.focus();
    }
  };
  window.addEventListener('keydown', onKey);

  root.replaceChildren(
    title,
    banner,
    roster,
    log,
    form,
    el('p', { className: 'hint' }, 'Enter: chat · Esc: lobby'),
  );
  root.hidden = false;
  renderRoster();
  renderStatus();

  return function unmount() {
    for (const off of offs) off();
    window.removeEventListener('keydown', onKey);
    root.replaceChildren();
    root.hidden = true;
  };
}
