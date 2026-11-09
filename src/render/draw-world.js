import { createRng } from '../sim/rng.js';
import { Ship } from '../sim/ship.js';
import { drawShip } from './draw.js';
import { interpolateEntity } from './interpolate.js';

// Asteroid outlines are generated once per entity id, from the id, so they never change.
const shapeCache = new Map();
function asteroidShape(id) {
  let shape = shapeCache.get(id);
  if (!shape) {
    if (shapeCache.size > 400) shapeCache.clear();
    const rng = createRng(id * 7919);
    const points = 11;
    shape = Array.from({ length: points }, (_, i) => ({
      angle: (i / points) * Math.PI * 2,
      scale: 0.78 + rng.next() * 0.3,
    }));
    shapeCache.set(id, shape);
  }
  return shape;
}

const PICKUP_STYLE = {
  shield: { color: '#6effdc', label: 'S' },
  rapid: { color: '#ffd166', label: 'R' },
  homing: { color: '#c77dff', label: 'H' },
};

/** Draw one World entity at its interpolated pose. Pure rendering: reads sim state, never writes. */
export function drawEntity(ctx, entity, alpha, sprites = null) {
  const pose = interpolateEntity(entity, alpha);

  // Sprites first. If there is no sheet (it failed to load) or no frame for this entity,
  // draw() returns false and we fall through to the built-in vector art below.
  if (sprites && entity.kind !== 'explosion') {
    const blink =
      entity.kind === 'ship' &&
      entity.invulnerable &&
      Math.floor(performance.now() / 90) % 2 === 0;
    if (sprites.draw(ctx, entity, pose, { blink })) return;
  }

  switch (entity.kind) {
    case 'ship':
      drawShip(ctx, pose, {
        blink: entity.invulnerable && Math.floor(performance.now() / 90) % 2 === 0,
        shield: entity.hasEffect('shield'),
      });
      break;

    case 'bullet': {
      const homing = entity.hasBehavior('homing');
      ctx.fillStyle = homing ? '#d9a6ff' : '#ffe27a';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(pose.x, pose.y, entity.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }

    case 'asteroid': {
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.beginPath();
      asteroidShape(entity.id).forEach(({ angle, scale }, i) => {
        const x = Math.cos(angle) * entity.radius * scale * 1.1;
        const y = Math.sin(angle) * entity.radius * scale * 1.1;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = entity.hunter ? '#3a1620' : '#1b2338';
      ctx.strokeStyle = entity.hunter ? '#ff6b6b' : '#8fa3d1';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      break;
    }

    case 'pickup': {
      const style = PICKUP_STYLE[entity.type];
      const pulse = 1 + Math.sin(performance.now() / 200) * 0.12;
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = style.color;
      ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.label, 0, 1);
      ctx.restore();
      break;
    }

    case 'explosion': {
      ctx.fillStyle = entity.variant === 'ship' ? '#ffb347' : '#cdd6f4';
      for (const p of entity.particles) {
        if (p.life <= 0) continue;
        const x = p.px + (p.x - p.px) * alpha;
        const y = p.py + (p.y - p.py) * alpha;
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
      break;
    }
  }
}

/** Score / HP / effects, top-right, in screen space (call after ctx.restore()). */
export function drawGameHud(ctx, view, hud) {
  const right = view.width - 16;
  ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(right - 188, 8, 196, 48 + hud.effects.length * 18);

  ctx.fillStyle = '#ffe27a';
  ctx.fillText(`SCORE ${hud.score}`, right, 14);

  ctx.fillStyle = '#b8ffb8';
  ctx.fillText(`deaths ${hud.deaths}`, right, 34);

  // HP pips, drawn left of the label area.
  for (let i = 0; i < Ship.MAX_HP; i++) {
    ctx.fillStyle = i < hud.hp ? '#ff6b6b' : 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(right - 180 + i * 16, 16, 12, 12);
  }

  hud.effects.forEach(([name, left], i) => {
    ctx.fillStyle = PICKUP_STYLE[name]?.color ?? '#fff';
    ctx.fillText(`${name} ${left.toFixed(1)}s`, right, 54 + i * 18);
  });

  if (hud.respawnIn > 0) {
    ctx.textAlign = 'center';
    ctx.font = 'bold 22px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#ff9d9d';
    ctx.fillText(
      `DESTROYED — respawn in ${hud.respawnIn.toFixed(1)} s`,
      view.width / 2,
      view.height / 2 - 12,
    );
  }
  ctx.textAlign = 'left';
}
