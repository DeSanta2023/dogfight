import { Ship } from './sim/ship.js';

/**
 * The in-game HUD: score, hp, effects, respawn notice, and the things that react to events:
 * floating "+100" popups where an asteroid blew up, a red flash when the ship is hit.
 *
 * Like audio.js it learns about the game ONLY through the event bus (attach). The simulation
 * does not know this file exists. Popups use wall-clock time (performance.now) because they are
 * decoration: they must not touch, or depend on, the fixed-step simulation.
 */

const EFFECT_COLOR = { shield: '#6effdc', rapid: '#ffd166', homing: '#c77dff' };
const POPUP_MS = 900;
const FLASH_MS = 280;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function createHud() {
  let popups = []; // { x, y, text, color, born }
  let flashAt = -Infinity;
  let scoredAt = -Infinity;

  return {
    /** Subscribe to a game's events. Returns the unsubscribe function. */
    attach(events) {
      const listeners = {
        exploded: ({ detail }) => {
          if (detail.points > 0) {
            popups.push({
              x: detail.x,
              y: detail.y,
              text: `+${detail.points}`,
              color: '#ffe27a',
              born: performance.now(),
            });
            scoredAt = performance.now();
          }
        },
        collected: ({ detail }) =>
          popups.push({
            x: detail.x,
            y: detail.y,
            text: detail.type.toUpperCase(),
            color: EFFECT_COLOR[detail.type] ?? '#fff',
            born: performance.now(),
          }),
        hit: ({ detail }) => {
          if (detail.target === 'ship') flashAt = performance.now();
        },
      };
      for (const [type, listener] of Object.entries(listeners)) {
        events.addEventListener(type, listener);
      }
      return () => {
        for (const [type, listener] of Object.entries(listeners)) {
          events.removeEventListener(type, listener);
        }
      };
    },

    reset() {
      popups = [];
      flashAt = scoredAt = -Infinity;
    },

    /** Inside the world transform (arena coordinates): the floating popups. */
    drawWorld(ctx, now = performance.now()) {
      popups = popups.filter((p) => now - p.born < POPUP_MS);
      ctx.font = `bold 18px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of popups) {
        const t = (now - p.born) / POPUP_MS;
        ctx.globalAlpha = 1 - t * t;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y - 12 - t * 34);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    },

    /** Screen space (after ctx.restore()): score, hp, effects, notices. */
    drawScreen(ctx, view, hud, now = performance.now()) {
      const flash = 1 - (now - flashAt) / FLASH_MS;
      if (flash > 0) {
        ctx.strokeStyle = `rgba(255, 70, 70, ${(flash * 0.7).toFixed(3)})`;
        ctx.lineWidth = 18;
        ctx.strokeRect(0, 0, view.width, view.height);
      }

      const right = view.width - 16;
      ctx.font = `14px ${MONO}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';

      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(right - 188, 8, 196, 48 + hud.effects.length * 18);

      const pulse = now - scoredAt < 250;
      ctx.fillStyle = pulse ? '#ffffff' : '#ffe27a';
      ctx.fillText(`SCORE ${hud.score}`, right, 14);

      ctx.fillStyle = '#b8ffb8';
      ctx.fillText(`deaths ${hud.deaths}`, right, 34);

      for (let i = 0; i < Ship.MAX_HP; i++) {
        ctx.fillStyle = i < hud.hp ? '#ff6b6b' : 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(right - 180 + i * 16, 16, 12, 12);
      }

      hud.effects.forEach(([name, left], i) => {
        ctx.fillStyle = EFFECT_COLOR[name] ?? '#fff';
        ctx.fillText(`${name} ${left.toFixed(1)}s`, right, 54 + i * 18);
      });

      if (hud.respawnIn > 0) {
        ctx.textAlign = 'center';
        ctx.font = `bold 22px ${MONO}`;
        ctx.fillStyle = '#ff9d9d';
        ctx.fillText(
          `DESTROYED — respawn in ${hud.respawnIn.toFixed(1)} s`,
          view.width / 2,
          view.height / 2 - 12,
        );
      }
      ctx.textAlign = 'left';
    },
  };
}
