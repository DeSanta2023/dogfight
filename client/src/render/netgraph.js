/**
 * The netgraph: the numbers that tell you what the network is doing to the game, on screen.
 *
 *   rtt         round trip of a ping (through the conditioner: ?lag= shows up here)
 *   snap age    ms since the newest snapshot arrived (steady ~33 ms; spikes = jitter or loss)
 *   bytes/s     what the game receives / sends, per second
 *   input queue inputs sent but not yet confirmed by a snapshot (= RTT / 33 ms, about)
 *   correction  how far the last snapshot moved the predicted ship, in world units (0 = perfect)
 *
 * Screen space (call after ctx.restore()). Two small sparklines: rtt and correction.
 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function spark(ctx, list, x, y, w, h, max, color) {
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeRect(x, y, w, h);
  if (list.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  list.forEach((v, i) => {
    const px = x + (i / 89) * w;
    const py = y + h - Math.min(1, v / max) * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

export function drawNetgraph(ctx, view, net, flags) {
  const s = net.stats;
  const w = 340;
  const x = view.width - w - 28; // bottom-right: the chat panel lives bottom-left
  const lines = [
    [
      'rtt',
      `${s.rtt.toFixed(0)} ms  (min ${Number.isFinite(s.rttMin) ? s.rttMin.toFixed(0) : '-'} max ${s.rttMax.toFixed(0)})`,
    ],
    [
      'snapshot age',
      `${s.snapshotAge.toFixed(0)} ms  (max ${s.snapshotAgeMax.toFixed(0)})`,
    ],
    ['bytes/s', `in ${s.bytesInPerSec.toFixed(0)}   out ${s.bytesOutPerSec.toFixed(0)}`],
    ['input queue', `${net.pending.length} unconfirmed  (seq ${net.seq})`],
    [
      'correction',
      `${s.correction.toFixed(2)} units  (max ${s.correctionMax.toFixed(2)}, ${s.corrections} total)`,
    ],
    [
      'snapshots',
      `${s.snapshotsPerSec.toFixed(1)}/s   late/dup ${s.lateOrDuplicate}   held ${s.extrapolating}`,
    ],
    [
      'mode',
      `${net.format} · predict ${net.predict ? 'on' : 'OFF'} · interp ${net.interp ? `${net.interpDelayMs}ms` : 'OFF'}`,
    ],
  ];
  if (net.conditioner.active)
    lines.push([
      'conditioner',
      `lag ${net.conditioner.lag} jit ${net.conditioner.jitter} loss ${(net.conditioner.loss * 100).toFixed(0)}% drop ${net.conditioner.dropped}`,
    ]);
  if (flags?.noise) lines.push(['NOISE', `Math.random() x ${flags.noise}`]);

  const h = 16 + lines.length * 16 + 58;
  const y = view.height - h - 12;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(x, y, w + 16, h);
  ctx.font = `12px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  lines.forEach(([label, value], i) => {
    ctx.fillStyle = '#7f8fb8';
    ctx.fillText(label, x + 8, y + 8 + i * 16);
    ctx.fillStyle = label === 'NOISE' ? '#ff9d9d' : '#e8ecff';
    ctx.fillText(value, x + 8 + 92, y + 8 + i * 16);
  });
  const gy = y + 12 + lines.length * 16;
  spark(ctx, s.history.rtt, x + 8, gy, 150, 40, Math.max(60, s.rttMax * 1.2), '#6effdc');
  spark(ctx, s.history.correction, x + 174, gy, 150, 40, 20, '#ffd166');
  ctx.fillStyle = '#7f8fb8';
  ctx.fillText('rtt', x + 8, gy + 42);
  ctx.fillText('correction (0..20)', x + 174, gy + 42);
  ctx.restore();
}
