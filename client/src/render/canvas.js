/**
 * DPR-aware canvas. The canvas *backing store* is cssSize * devicePixelRatio pixels, while
 * its CSS size stays the same. Drawing code then works in CSS pixels after begin().
 * Without this, everything looks blurry on retina / scaled displays.
 */
export function createCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const view = { width: 0, height: 0, dpr: 1 }; // width/height in CSS pixels

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    view.width = rect.width;
    view.height = rect.height;
    view.dpr = dpr;
    // Assigning width/height resets the context transform, so begin() re-applies it.
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }

  window.addEventListener('resize', resize); // browser zoom also fires `resize` and changes DPR
  resize();

  return {
    ctx,
    view,
    /** Call at the start of every frame: reset to CSS-pixel coordinates and clear. */
    begin() {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
    },
  };
}
