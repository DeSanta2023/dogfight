import type { PickupType } from '@dogfight/shared/entities.ts';
import type { GameEvents } from '@dogfight/shared/events.ts';
import { Ship } from '@dogfight/shared/ship.ts';
import type { EffectName } from './render/drawable.ts';

/** What the HUD draws: both Game.hud and NetGame.hud have this shape. */
export interface HudData {
  score: number;
  deaths: number;
  hp: number;
  effects: readonly (readonly [EffectName, number])[];
  respawnIn: number;
}
/** The size of the canvas in CSS pixels (what createCanvas() reports). */
interface ScreenView {
  width: number;
  height: number;
}
interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

/**
 * The in-game HUD: score, hp, effects, respawn notice, and the things that react to events:
 * floating "+100" popups where an asteroid blew up, a red flash when the ship is hit.
 *
 * Like audio.js it learns about the game ONLY through the event bus (attach). The simulation
 * does not know this file exists. Popups use wall-clock time (performance.now) because they are
 * decoration: they must not touch, or depend on, the fixed-step simulation.
 */

const EFFECT_COLOR: Record<PickupType, string> = {
  shield: '#6effdc',
  rapid: '#ffd166',
  homing: '#c77dff',
};
const POPUP_MS = 900;
const FLASH_MS = 280;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function createHud() {
  let popups: Popup[] = [];
  let flashAt = -Infinity;
  let scoredAt = -Infinity;

  return {
    /** Subscribe to a game's events. Returns the unsubscribe function. */
    /**
     * Subscribe to a game's events. Returns the unsubscribe function. `ownSlot`: online, only
     * damage to MY ship flashes the screen; offline (null) any ship hit is mine.
     */
    attach(events: GameEvents, ownSlot: number | null = null): () => void {
      const offs = [
        events.on('exploded', (d) => {
          if (d.points > 0) {
            popups.push({
              x: d.x,
              y: d.y,
              text: `+${d.points}`,
              color: '#ffe27a',
              born: performance.now(),
            });
            scoredAt = performance.now();
          }
        }),
        events.on('collected', (d) =>
          popups.push({
            x: d.x,
            y: d.y,
            text: d.type.toUpperCase(),
            color: EFFECT_COLOR[d.type],
            born: performance.now(),
          }),
        ),
        events.on('hit', (d) => {
          if (d.target === 'ship' && (ownSlot === null || d.slot === ownSlot))
            flashAt = performance.now();
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },

    reset() {
      popups = [];
      flashAt = scoredAt = -Infinity;
    },

    /** Inside the world transform (arena coordinates): the floating popups. */
    drawWorld(ctx: CanvasRenderingContext2D, now = performance.now()): void {
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
    drawScreen(
      ctx: CanvasRenderingContext2D,
      view: ScreenView,
      hud: HudData,
      now = performance.now(),
    ): void {
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
        ctx.fillStyle = EFFECT_COLOR[name];
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
