// A flame chart from a Chrome CPU profile (what DevTools > Performance shows, and what
// Profiler.stop returns over the DevTools protocol). Pure function: profile in, SVG text out.

/** profile: { nodes: [{id, callFrame:{functionName,url,lineNumber}, children?:[id]}], samples, timeDeltas } */
export function flameSvg(
  profile,
  { title = 'CPU flame chart', width = 1400, rowHeight = 18, minWidthPx = 1.2 } = {},
) {
  const byId = new Map(
    profile.nodes.map((n) => [n.id, { ...n, self: 0, total: 0, kids: [] }]),
  );

  // Time spent per node = sum of the deltas of the samples that landed on it.
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (node) node.self += timeDeltas[i + 1] ?? timeDeltas[i] ?? 0;
  }
  const root = profile.nodes[0];
  const total = (id) => {
    const n = byId.get(id);
    n.total = n.self + (n.children ?? []).reduce((a, c) => a + total(c), 0);
    return n.total;
  };
  total(root.id);
  // The idle time is not interesting and would shrink everything: drop it from the root.
  const idle = [...byId.values()].find((n) => n.callFrame.functionName === '(idle)');
  const grand = byId.get(root.id).total - (idle?.total ?? 0);

  const rects = [];
  let maxDepth = 0;
  const color = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${10 + (h % 40)} ${70 + (h % 20)}% ${55 + (h % 15)}%)`;
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const place = (id, x, depth) => {
    const n = byId.get(id);
    if (n === idle) return x;
    const w = (n.total / grand) * width;
    if (w < minWidthPx) return x + w;
    const fn = n.callFrame.functionName || '(anonymous)';
    const file = n.callFrame.url.split('/').pop() ?? '';
    maxDepth = Math.max(maxDepth, depth);
    rects.push({
      x,
      depth,
      w,
      fn,
      file,
      line: n.callFrame.lineNumber + 1,
      ms: n.total / 1000,
      pct: (n.total / grand) * 100,
    });
    let cx = x;
    for (const c of n.children ?? []) cx = place(c, cx, depth + 1);
    return x + w;
  };
  let x = 0;
  for (const c of byId.get(root.id).children ?? []) x = place(c, x, 0);

  const top = 44;
  const height = top + (maxDepth + 1) * rowHeight + 24;
  const body = rects
    .map(
      (r) =>
        `<g><title>${esc(r.fn)} ${esc(r.file)}:${r.line} — ${r.ms.toFixed(1)} ms (${r.pct.toFixed(1)}%)</title>` +
        `<rect x="${r.x.toFixed(1)}" y="${top + r.depth * rowHeight}" width="${Math.max(0.5, r.w - 0.5).toFixed(1)}" height="${rowHeight - 1}" fill="${color(r.fn)}"/>` +
        (r.w > 38
          ? `<text x="${(r.x + 3).toFixed(1)}" y="${top + r.depth * rowHeight + 12}" font-size="11" clip-path="inset(0)">${esc(r.fn.slice(0, Math.floor(r.w / 6.2)))}</text>`
          : '') +
        `</g>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace,Menlo,Consolas,monospace">
<rect width="${width}" height="${height}" fill="#fff"/>
<text x="6" y="20" font-size="15" font-family="system-ui,sans-serif" font-weight="600">${esc(title)}</text>
<text x="6" y="36" font-size="11" fill="#555">width = share of busy CPU time (idle removed) · ${(grand / 1000).toFixed(0)} ms in total · row = call depth · hover for details</text>
${body}
</svg>`;
}

/** Heaviest functions by SELF time: the flat list under the chart. */
export function topSelf(profile, count = 10) {
  const byFn = new Map();
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const { samples, timeDeltas } = profile;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]);
    if (!n || n.callFrame.functionName === '(idle)') continue;
    const dt = timeDeltas[i + 1] ?? timeDeltas[i] ?? 0;
    const key = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + dt);
    sum += dt;
  }
  return [...byFn]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([fn, us]) => ({
      fn,
      ms: +(us / 1000).toFixed(1),
      pct: +((us / sum) * 100).toFixed(1),
    }));
}
