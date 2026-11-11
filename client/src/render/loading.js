/**
 * The loading screen, drawn on the canvas. The bar shows REAL progress: the number of assets
 * that have finished (loadAll's onProgress), not a timer. The drawn fill only eases toward the
 * real fraction so that jumps between assets do not look jerky.
 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function createLoadingScreen() {
  const state = { loaded: 0, total: 0, fraction: 0, shown: 0, last: '', note: '' };

  return {
    state,

    reset() {
      Object.assign(state, {
        loaded: 0,
        total: 0,
        fraction: 0,
        shown: 0,
        last: '',
        note: '',
      });
    },

    /** Wire this to loadAll's onProgress. */
    onProgress({ loaded, total, fraction, id, ok }) {
      Object.assign(state, { loaded, total, fraction, last: ok ? id : `${id} (failed)` });
    },

    draw(ctx, view) {
      state.shown += (state.fraction - state.shown) * 0.2;
      if (Math.abs(state.fraction - state.shown) < 0.002) state.shown = state.fraction;

      const w = Math.min(420, view.width - 64);
      const x = (view.width - w) / 2;
      const y = view.height / 2;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `bold 26px ${MONO}`;
      ctx.fillStyle = '#7fe3ff';
      ctx.fillText('DOGFIGHT', view.width / 2, y - 44);

      ctx.fillStyle = 'rgba(120, 160, 255, 0.18)';
      ctx.fillRect(x, y, w, 14);
      ctx.fillStyle = '#7fe3ff';
      ctx.fillRect(x, y, w * state.shown, 14);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 13);

      ctx.font = `13px ${MONO}`;
      ctx.fillStyle = '#d7e3ff';
      const count = state.total ? `${state.loaded}/${state.total}` : '…';
      ctx.fillText(
        `loading ${count}   ${Math.round(state.fraction * 100)}%`,
        view.width / 2,
        y + 36,
      );
      ctx.fillStyle = 'rgba(215, 227, 255, 0.6)';
      ctx.fillText(state.last, view.width / 2, y + 56);
      if (state.note) {
        ctx.fillStyle = '#ffd166';
        ctx.fillText(state.note, view.width / 2, y + 78);
      }
      ctx.textAlign = 'left';
    },
  };
}
