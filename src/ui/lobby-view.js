import { describeError } from '../assets/loader.js';
import { LobbyError } from '../lobby.js';

/**
 * DOM rendering of the lobby. The model (src/lobby.js) knows nothing about the page; this file
 * knows nothing about fetching. It only listens to the model's events and calls join()/refresh().
 *
 * Server data (room names) is written with textContent, never innerHTML: a hostile room name
 * must not be able to inject markup.
 */
const NAME_KEY = 'dogfight.callsign';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function storedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return ''; // private mode / blocked storage: the lobby works without it
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

const arenaSummary = ({ asteroids, pickups, hunterChance }) =>
  [
    `${asteroids} asteroids`,
    pickups ? 'pickups' : 'no pickups',
    hunterChance > 0 ? `${Math.round(hunterChance * 100)}% hunters` : 'no hunters',
  ].join(' · ');

/** Returns an unmount function that removes every listener and timer it created. */
export function mountLobbyView(root, lobby, { notice = '' } = {}) {
  const name = el('input', {
    type: 'text',
    maxLength: 16,
    placeholder: 'your callsign',
    value: storedName(),
  });
  name.setAttribute('aria-label', 'Callsign');
  const list = el('ul', { className: 'rooms' });
  const status = el('p', { className: 'status' });
  const message = el('p', { className: 'message', role: 'alert' });
  const retry = el('button', {
    type: 'button',
    className: 'retry',
    textContent: 'Retry now',
  });
  retry.hidden = true;
  retry.addEventListener('click', () => lobby.refresh());

  function roomRow(room) {
    const full = room.players >= room.maxPlayers;
    const join = el('button', {
      type: 'button',
      textContent: full ? 'Full' : 'Join',
      disabled: full,
    });
    join.addEventListener('click', () => {
      message.textContent = '';
      try {
        saveName(name.value.trim());
        lobby.join(room.id, name.value);
      } catch (error) {
        if (!(error instanceof LobbyError)) throw error;
        message.textContent = error.message;
      }
    });
    return el(
      'li',
      {},
      el('span', { className: 'room-name' }, room.name),
      el('span', { className: 'room-count' }, `${room.players}/${room.maxPlayers}`),
      el('span', { className: 'room-arena' }, arenaSummary(room.arena)),
      join,
    );
  }

  function renderRooms() {
    list.replaceChildren(...lobby.rooms.map(roomRow));
  }

  function renderStatus() {
    const age = lobby.updatedAt
      ? Math.round((Date.now() - lobby.updatedAt) / 1000)
      : null;
    const updated = age === null ? '' : `updated ${age} s ago`;
    retry.hidden = lobby.status !== 'error';
    status.dataset.state = lobby.status;
    if (lobby.status === 'error') {
      const last = lobby.rooms.length ? ' Showing the last list.' : '';
      status.textContent = `Server not responding (${describeError(lobby.error)}).${last} Retrying automatically…`;
    } else if (lobby.status === 'loading' && !lobby.rooms.length) {
      status.textContent = 'Contacting server…';
    } else {
      status.textContent =
        lobby.status === 'loading' ? `${updated} · refreshing…` : updated;
    }
  }

  const onRooms = () => renderRooms();
  const onStatus = () => renderStatus();
  lobby.addEventListener('rooms', onRooms);
  lobby.addEventListener('status', onStatus);
  const tick = setInterval(renderStatus, 500); // keeps "updated N s ago" honest

  root.replaceChildren(
    el(
      'section',
      { className: 'panel' },
      el('h1', {}, 'DOGFIGHT'),
      el('p', { className: 'sub' }, 'Choose a room'),
      notice ? el('p', { className: 'notice' }, notice) : '',
      el('label', {}, 'Callsign ', name),
      list,
      status,
      retry,
      message,
      el('p', { className: 'hint' }, 'Esc in game: back to the lobby · M: mute'),
    ),
  );
  root.hidden = false;
  renderRooms();
  renderStatus();

  return function unmount() {
    clearInterval(tick);
    lobby.removeEventListener('rooms', onRooms);
    lobby.removeEventListener('status', onStatus);
    root.replaceChildren();
    root.hidden = true;
  };
}
