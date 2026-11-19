import { assertNever } from '@dogfight/shared/brand.ts';
import type { Drawable, DrawableShip } from './drawable.ts';
import type { Pose } from './interpolate.ts';
import { ARENA } from '@dogfight/shared/arena.ts';

/**
 * Sprite-sheet rendering with drawImage(sheet, sx, sy, sw, sh, dx, dy, dw, dh): copy one
 * rectangle (a "frame") of the sheet onto the canvas, scaled and rotated by the context.
 *
 * `atlas.frames[name]` = { x, y, w, h, fit }: where the frame sits on the sheet, and `fit`, how
 * much bigger than the entity's collision radius the whole cell must be drawn so that the visible
 * art matches the radius. Entities are drawn centred and pointing along +x (angle 0).
 *
 * draw() returns false when it cannot draw something (no such frame). The caller then falls back
 * to the built-in vector art, so a missing or broken sprite sheet never stops the game.
 */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  fit: number;
}
export interface Atlas {
  frames: Readonly<Record<string, Frame>>;
}
export interface Sprites {
  has(name: string): boolean;
  draw(
    ctx: CanvasRenderingContext2D,
    entity: Drawable,
    pose: Pose,
    options?: { blink?: boolean; now?: number },
  ): boolean;
}
interface BlitOptions {
  alpha?: number;
  scale?: number;
}

export function createSprites({
  sheet,
  atlas,
}: {
  sheet: CanvasImageSource;
  atlas: Atlas | null | undefined;
}): Sprites {
  const frames = atlas?.frames ?? {};

  function blit(
    ctx: CanvasRenderingContext2D,
    name: string,
    x: number,
    y: number,
    angle: number,
    radius: number,
    { alpha = 1, scale = 1 }: BlitOptions = {},
  ): boolean {
    const frame = frames[name];
    if (!frame) return false;
    const size = radius * frame.fit * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      sheet,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      -size / 2,
      -size / 2,
      size,
      size,
    );
    ctx.restore();
    return true;
  }

  /** Near an edge the ship is also drawn on the opposite side, so it slides through the border. */
  function drawShip(
    ctx: CanvasRenderingContext2D,
    entity: DrawableShip,
    pose: Pose,
    blink: boolean,
  ): boolean {
    const margin = 24;
    const xs = [0];
    const ys = [0];
    if (pose.x < margin) xs.push(ARENA.width);
    if (pose.x > ARENA.width - margin) xs.push(-ARENA.width);
    if (pose.y < margin) ys.push(ARENA.height);
    if (pose.y > ARENA.height - margin) ys.push(-ARENA.height);

    const name = pose.thrust ? 'ship-thrust' : 'ship';
    let drawn = false;
    for (const dx of xs) {
      for (const dy of ys) {
        drawn = blit(ctx, name, pose.x + dx, pose.y + dy, pose.angle, entity.radius, {
          alpha: blink ? 0.3 : 1,
        });
        if (entity.hasEffect('shield')) {
          ctx.strokeStyle = 'rgba(110, 255, 220, 0.85)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pose.x + dx, pose.y + dy, 24, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    return drawn;
  }

  return {
    has: (name: string): boolean => name in frames,

    draw(ctx, entity, pose, { blink = false, now = performance.now() } = {}) {
      switch (entity.kind) {
        case 'ship':
          return drawShip(ctx, entity, pose, blink);

        case 'bullet':
          return blit(
            ctx,
            entity.hasBehavior('homing') ? 'bullet-homing' : 'bullet',
            pose.x,
            pose.y,
            pose.angle,
            entity.radius,
          );

        case 'asteroid': {
          // Purely visual slow spin; the simulation's asteroids have no rotation of their own.
          const spin =
            (now / 1000) * (0.25 + (entity.id % 5) * 0.12) * (entity.id % 2 ? 1 : -1);
          const name = entity.hunter ? 'hunter-1' : `asteroid-${entity.size}`;
          return blit(ctx, name, pose.x, pose.y, spin + entity.id, entity.radius);
        }

        case 'pickup': {
          const pulse = 1 + Math.sin(now / 200) * 0.1;
          return blit(ctx, `pickup-${entity.type}`, pose.x, pose.y, 0, entity.radius, {
            scale: pulse,
          });
        }

        case 'explosion':
          return false; // explosions are particles, drawn by draw-world.ts

        default:
          return assertNever(entity);
      }
    },
  };
}
