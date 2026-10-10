// The game's own picture of the map being edited: an engine preview of the
// map file (Game.editor_preview: the map's actors, the trees of tree terrain
// and the bridges as a game on it starts them, nobody playing), drawn with
// the game's renderer for the spectator view. Rebuilt when the map changes;
// sprite instances and terrain bytes are read straight from it, so the
// editor draws every actor, pose, wall piece and bridge state exactly like
// the game.

/** The engine's spectator view (engine observer.rs OBSERVER, js/observer.js OBSERVER_VIEW). */
export const OBSERVER = 255;
/** Floats per sprite instance (engine render.rs SPRITE_FLOATS). */
export const SPRITE_FLOATS = 8;
/** Team slot of the neutral player in the preview (engine world.rs EDITOR_SLOTS). */
export const PREVIEW_NEUTRAL = 8;

export class PreviewWorld {
  /**
   * @param {object} o
   * @param {{ editor_preview(json: string): object }} o.Game the engine's Game class
   * @param {() => WebAssembly.Memory} o.memory the engine's memory
   * @param {(game: object) => void} [o.prepare] applies the art settings to a new preview (EditorArt.applyTo)
   */
  constructor({ Game, memory, prepare = () => {} }) {
    this.Game = Game;
    this.memory = memory;
    this.prepare = prepare;
    this.game = null;
    this.error = null;
    this.json = null;
  }

  /**
   * Build the preview of a map file (JSON text). Keeps the last good one
   * when the file cannot be read (`error` says why). Returns whether the
   * preview changed.
   */
  update(json) {
    if (json === this.json && this.game) return false;
    this.json = json;
    let next;
    try {
      next = this.Game.editor_preview(json);
    } catch (err) {
      this.error = String(err?.message ?? err);
      return false;
    }
    this.error = null;
    this.game?.free?.();
    this.game = next;
    this.prepare(next);
    return true;
  }

  /** Apply the art settings again (a new atlas). */
  reprepare() {
    if (this.game) this.prepare(this.game);
  }

  /** Engine terrain bytes of the preview (RGBA per cell, js/view.js layout), copied; null without one. */
  terrain() {
    if (!this.game) return null;
    const ptr = this.game.terrain_ptr();
    return new Uint8Array(this.memory().buffer, ptr, this.game.terrain_len()).slice();
  }

  /**
   * Sprite instances of the actors inside the world-pixel rectangle `view`
   * ({ x0, y0, x1, y1 }), copied out of engine memory.
   */
  sprites(view) {
    if (!this.game) return new Float32Array(0);
    const n = this.game.build_render(OBSERVER, 1, view.x0, view.y0, view.x1, view.y1);
    return new Float32Array(this.memory().buffer, this.game.sprite_ptr(), n * SPRITE_FLOATS).slice();
  }

  dispose() {
    this.game?.free?.();
    this.game = null;
    this.json = null;
  }
}
