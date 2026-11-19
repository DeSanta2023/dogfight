/**
 * DPR-aware canvas. The canvas *backing store* is cssSize * devicePixelRatio pixels, while
 * its CSS size stays the same. Drawing code then works in CSS pixels after begin().
 * Without this, everything looks blurry on retina / scaled displays.
 */
export interface CanvasView {
  width: number;
  height: number;
  dpr: number;
}

export function createCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser has no 2D canvas');
  const view: CanvasView = { width: 0, height: 0, dpr: 1 }; // width/height in CSS pixels

  function resize(): void {
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
    begin(): void {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
    },
  };
}
