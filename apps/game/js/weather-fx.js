// Weather on screen: turns the engine's sky (Game.weather_json, engine/src/
// weather.rs) into renderer uniforms (shaders weather.wgsl, sky.wgsl,
// terrain.wgsl), the HUD weather badge with what the weather does, and the
// thunder hook for the sound system. Pure apart from the time passed in, so
// it runs under Node tests.

export const BIOME_IDS = Object.freeze({ temperate: 0, snow: 1, desert: 2 });
export const WEATHER_IDS = Object.freeze({ clear: 0, rain: 1, thunderstorm: 2, snowfall: 3, sandstorm: 4, heatwave: 5 });

const LABELS = { clear: 'Clear', rain: 'Rain', thunderstorm: 'Thunderstorm', snowfall: 'Snowfall', sandstorm: 'Sandstorm', heatwave: 'Heat wave' };
const BIOME_LABELS = { temperate: 'Temperate', snow: 'Snow', desert: 'Desert' };

/**
 * Rain, snow and sand are particles in the world (shaders/weather.wgsl): the
 * ground under the view is cut into square cells of `cell` world pixels, and
 * every cell holds one particle on each of the three depth layers (far, mid,
 * near). A particle lands on its own spot of ground: it falls `height` world
 * pixels (screen up is up in the air in Red Alert's top-down view) while the
 * wind carries it `wind` world pixels per second, over `periods[layer]`
 * seconds, then splashes (rain) or settles (snow) where it landed, and starts
 * again. Sizes, spacing and speeds are world pixels, so they follow the
 * camera's zoom like the sprites do. Only this table, the grid and the clock
 * come from here; the looks (sizes, colours, splashes) live in the shader.
 */
export const KINDS = Object.freeze({
  rain: Object.freeze({ cell: 64, height: 220, wind: 60, periods: Object.freeze([0.62, 0.5, 0.42]) }),
  thunderstorm: Object.freeze({ cell: 60, height: 240, wind: 190, periods: Object.freeze([0.5, 0.4, 0.33]) }),
  snowfall: Object.freeze({ cell: 60, height: 160, wind: 30, periods: Object.freeze([6.5, 5.2, 4.2]) }),
  sandstorm: Object.freeze({ cell: 56, height: 24, wind: 480, periods: Object.freeze([0.9, 0.75, 0.6]) }),
});
/** Depth layers per cell (shaders/weather.wgsl LAYERS). */
export const LAYERS = 3;
/** Snowflakes sway sideways once per this many seconds. */
export const SWAY_PERIOD = 2.6;
/**
 * Level of detail: zoomed out, the grid keeps one cell in four (picked at
 * random within each block of 2 x 2, the rest fading out first) whenever it
 * holds more than this many cells on a 1920 x 1080 CSS pixel view (scaled
 * down for smaller views), so the count on screen stays about the same however far
 * the camera zooms out. MAX_PARTICLES is the hard cap on instances.
 */
export const TARGET_CELLS = 520;
export const MAX_PARTICLES = 8192;
/**
 * Particles keep the size they have at these camera zooms (CSS pixels per
 * world pixel) when the camera goes further: no specks thinner than a pixel
 * far out, no blobs close in. Speeds and spacing are not clamped.
 */
export const SIZE_ZOOM_MIN = 0.75;
export const SIZE_ZOOM_MAX = 2.4;
/** Fine cell indices are offset by this many cells so they stay positive left of and above the map. */
export const CELL_OFFSET = 4096;
/** How far ahead of the simulation the weather clock may be before it jumps (a seek, catching up). */
export const CLOCK_SNAP = 1;
/** Reduced motion: the particles fall this much slower (and fewer of them fall, density()). */
export const REDUCED_SPEED = 0.3;

/**
 * How much the particles' world sizes are scaled at camera zoom `zoom` (CSS
 * px per world px): 1 between SIZE_ZOOM_MIN and SIZE_ZOOM_MAX, else what
 * keeps them at the size they have at that limit.
 */
export function particleScale(zoom) {
  if (!(zoom > 0)) return 1;
  return Math.min(SIZE_ZOOM_MAX, Math.max(SIZE_ZOOM_MIN, zoom)) / zoom;
}

/**
 * The cells a weather draws for the view `[x0, y0, x1, y1]` (world px) of
 * `cssArea` CSS px², with `budget` the share of TARGET_CELLS (quality).
 * Returns `{ bx, by, cols, rows, block, fade, count }`: the first block
 * (in blocks of `block` fine cells, CELL_OFFSET included), the grid size in
 * blocks, how far (0..1) the cells the next level of detail drops have
 * faded out, and the instance count. The ground covered reaches past the view
 * by where particles over it can be: the fall height below, the wind's drift
 * sideways and a block of slack all round.
 */
export function weatherGrid(kind, view, cssArea, budget = 1) {
  const k = KINDS[kind];
  if (!k || !view) return { bx: 0, by: 0, cols: 0, rows: 0, block: 1, fade: 0, count: 0 };
  const drift = k.wind * Math.max(...k.periods);
  const pad = k.cell;
  const x0 = view[0] - pad - Math.max(0, -drift);
  const x1 = view[2] + pad + Math.max(0, drift);
  const y0 = view[1] - pad;
  // A particle is at most its fall height above its ground (perspective only pushes it further out).
  const y1 = view[3] + pad + k.height;
  const cells = Math.max(0, ((x1 - x0) * (y1 - y0)) / (k.cell * k.cell));
  const target = TARGET_CELLS * Math.max(0.2, Math.min(1, cssArea / (1920 * 1080))) * Math.max(0.05, budget);
  const lod = cells > target ? Math.log(cells / target) / Math.log(4) : 0;
  let level = Math.floor(lod);
  // The three cells in four the next level drops fade so that what shows
  // (a quarter at full strength, the rest at 1 - fade) is 4^-(lod - level):
  // the same as the target at every zoom, and exactly the next level at its start.
  const fade = (4 - 4 ** (1 - (lod - level))) / 3;
  const grid = (lv) => {
    const size = k.cell * 2 ** lv;
    const bx = Math.floor(x0 / size + CELL_OFFSET / 2 ** lv);
    const by = Math.floor(y0 / size + CELL_OFFSET / 2 ** lv);
    const cols = Math.floor(x1 / size + CELL_OFFSET / 2 ** lv) - bx + 1;
    const rows = Math.floor(y1 / size + CELL_OFFSET / 2 ** lv) - by + 1;
    return { bx, by, cols, rows, block: 2 ** lv, count: cols * rows * LAYERS };
  };
  let g = grid(level);
  // Never more than the cap (only a view far larger than any screen gets here).
  while (g.count > MAX_PARTICLES && level < 12) g = grid(++level);
  return { ...g, fade: g.block === 2 ** Math.floor(lod) ? fade : 0 };
}

/**
 * Seconds the weather takes to build up and die down (engine/src/weather.rs
 * RAMP_SECONDS). The engine throws no lightning in a thunderstorm's last
 * STORM_CALM_SECONDS, which covers this die-down and the longest thunder
 * delay below, so no flash and no thunder comes while the rain is stopping.
 */
export const RAMP = 4;
/** Thunder comes this long after the flash, plus up to THUNDER_TRAVEL seconds with distance. */
export const THUNDER_DELAY = 0.3;
export const THUNDER_TRAVEL = 2.5;
const TICKS_PER_SECOND = 25;
/** The badge detail when the weather changes nothing. */
export const NO_EFFECT = 'No effect on the battle.';

/**
 * The HUD text for a sky: `{ label, detail }`. `detail` lists every gameplay
 * effect in force (the numbers of engine/src/weather.rs), or says that the
 * weather is only for show.
 */
export function weatherInfo(state) {
  if (!state || state.mode === 'off') return { label: '', detail: '' };
  const biome = BIOME_LABELS[state.biome] ?? 'Temperate';
  const label = `${biome} · ${LABELS[state.weather] ?? 'Clear'}`;
  if (state.mode === 'cosmetic') return { label, detail: 'Weather effects are off: the weather is only for show.' };
  const effects = [];
  if (state.sightPct < 100) effects.push(`Sight ${state.sightPct - 100}%`);
  if (state.biome === 'snow') effects.push('Vehicles slide (more on ice), infantry 10% slower');
  if (state.weather === 'heatwave') effects.push('Vehicles that keep driving or firing overheat: 25% slower and fire 25% slower until they cool down');
  // engine/src/lightning.rs: what a strike does; Lightning Rods ground it.
  if (state.weather === 'thunderstorm') {
    effects.push('Lightning halves the health of what it strikes; a struck power plant cuts its owner\'s power for 15 s and then makes half its power until repaired. Lightning Rods ground every strike within their range');
  }
  return { label, detail: effects.length ? effects.join('. ') + '.' : NO_EFFECT };
}

/** Selection panel text for a vehicle's heat (actor_json().heat / overheated). */
export function heatText(info) {
  if (info?.overheated) return 'Overheated: slower, fires slower';
  if (info?.heat >= 50) return `Hot ${info.heat}%`;
  return '';
}

/**
 * Follows the engine's sky and produces what the renderer and the HUD need.
 * `reducedMotion`: the Reduce motion setting (no flicker, soft flashes, slow
 * and fewer particles, no splashes); `lowQuality`: half the particle grid. Both may
 * change while the game runs.
 */
export class WeatherFx {
  constructor({ reducedMotion = false, lowQuality = false, onThunder = null } = {}) {
    this.reducedMotion = reducedMotion;
    this.lowQuality = lowQuality;
    this.onThunder = onThunder;
    this.state = null;
    this.lastFlashTick = null;
    this.flashAt = -1;
    this.thunderAt = -1;
    /** The strike whose thunder is on its way: { x, y, kind } (world pixels). */
    this.strike = null;
    /** The weather's own clock (seconds, see advance) and the simulated time it last followed. */
    this.clock = null;
    this.lastSim = 0;
    this.still = 0;
    /** Where each depth layer is in its fall (0..1, wrapping), and the snow's sway. */
    this.phases = [0, 0, 0];
    this.sway = 0;
  }

  /**
   * New sky from Game.weather_json (parsed). `now` in seconds; `camera` is
   * the view centre in world pixels (far strikes rumble later). `flash` is
   * [tick, x, y] or [tick, x, y, kind] (engine/src/weather.rs StrikeKind:
   * 0 the ground, 1 a lightning rod, 2 units or structures, 3 a power
   * plant); `onThunder` gets { x, y, kind } once the sound has travelled, and
   * the sound system places it (audio/director.js thunderCue).
   */
  update(state, now, camera = null) {
    this.state = state;
    const flash = state?.flash;
    if (flash && flash[0] !== this.lastFlashTick) {
      // A strike older than two seconds (joining, catching up) is not replayed.
      const fresh = this.lastFlashTick !== null && state.tick - flash[0] < 2 * TICKS_PER_SECOND;
      this.lastFlashTick = flash[0];
      if (fresh) {
        this.flashAt = now;
        const d = camera ? Math.hypot(flash[1] - camera.x, flash[2] - camera.y) : 0;
        // Sound travels: farther strikes rumble later.
        this.thunderAt = now + THUNDER_DELAY + Math.min(THUNDER_TRAVEL, d / 1200);
        this.strike = { x: flash[1], y: flash[2], kind: flash[3] ?? 0 };
      }
    }
    if (this.thunderAt >= 0 && now >= this.thunderAt) {
      this.thunderAt = -1;
      this.onThunder?.(this.strike);
    }
  }

  /** 0..1: how far the current weather has built up (and ramps down before it ends). */
  intensity() {
    const s = this.state;
    if (!s || s.mode === 'off' || s.weather === 'clear') return 0;
    const into = (s.tick - s.since) / TICKS_PER_SECOND;
    const left = (s.until - s.tick) / TICKS_PER_SECOND;
    return Math.max(0, Math.min(1, into / RAMP, left / RAMP));
  }

  /** Lightning flash strength now, 0..1: a double flicker, or one soft pulse with reduced motion. */
  flash(now) {
    if (this.flashAt < 0) return 0;
    const t = now - this.flashAt;
    if (t < 0 || t > 0.6) return 0;
    if (this.reducedMotion) return 0.18 * Math.sin((Math.min(t, 0.5) / 0.5) * Math.PI);
    const pulse = (at, len, peak) => (t >= at && t < at + len ? peak * (1 - (t - at) / len) : 0);
    return Math.max(pulse(0, 0.12, 0.85), pulse(0.18, 0.2, 0.6));
  }

  /**
   * Run the weather's clock for a frame: `sim` the simulated time of the
   * frame (js/simclock.js, seconds), `dt` the page time since the last frame
   * (seconds). The particles stand still with the game, but the clock does
   * not step with the simulation's ticks: it runs at the page's pace and
   * leans toward the simulated time (a little faster when behind, slower when
   * ahead, still once the simulation stood still a quarter of a second), so
   * the falling never judders when a frame's tick interpolation does, and it
   * never runs backwards. Only a gap over CLOCK_SNAP seconds (catching up,
   * a replay seeking) makes it jump. The fall of each layer is kept as a
   * phase that wraps, so no large time reaches the GPU.
   */
  advance(sim, dt) {
    if (!Number.isFinite(sim)) return;
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const before = this.clock;
    if (before === null || Math.abs(sim - before) > CLOCK_SNAP) {
      this.clock = sim;
      this.lastSim = sim;
      this.still = 0;
      if (before === null) return;
    } else {
      if (sim > this.lastSim) {
        this.lastSim = sim;
        this.still = 0;
      } else {
        this.still += step;
      }
      const lead = sim - before;
      const rate = this.still < 0.25 ? 1 + 2 * lead : 2 * lead;
      this.clock = before + Math.max(0, Math.min(3, rate)) * step;
    }
    const moved = this.clock - before;
    const kind = KINDS[this.state?.weather] ?? KINDS.rain;
    const motion = this.reducedMotion ? REDUCED_SPEED : 1;
    const wrap = (v) => v - Math.floor(v);
    this.phases = this.phases.map((p, i) => wrap(p + (moved * motion) / kind.periods[i]));
    this.sway = wrap(this.sway + (moved * motion) / SWAY_PERIOD);
  }

  /**
   * Share of each grid's particles shown: fewer with reduced motion. Low
   * quality halves the grid itself instead (weatherGrid's budget), so it
   * also draws fewer instances.
   */
  density() {
    return this.reducedMotion ? 0.6 : 1;
  }

  /**
   * Renderer uniforms (shaders/common.wgsl Globals):
   * - `env` [biome, weather, intensity, flash];
   * - `env2` [wind x (world px/s), particle density 0..1, instances, motion (0 reduced)];
   * - `wgrid` [first block x, first block y, columns, rows] (weatherGrid);
   * - `wcell` [cell size, block size in cells, level of detail fade, size scale];
   * - `wphase` [far, mid and near layer phase, snow sway phase];
   * - `wfall` [fall height, wind drift over the far, mid and near layer's fall] (world px).
   * `view` is the visible world rectangle [x0, y0, x1, y1], `zoom` the
   * camera's CSS px per world px and `cssArea` the view's CSS px².
   */
  uniforms(now, view = null, zoom = 1, cssArea = 1920 * 1080) {
    const s = this.state;
    const biome = BIOME_IDS[s?.biome] ?? 0;
    const off = !s || s.mode === 'off';
    const weather = off ? 0 : (WEATHER_IDS[s.weather] ?? 0);
    const kind = off ? null : KINDS[s.weather];
    const intensity = off ? 0 : this.intensity();
    const density = this.density();
    const grid = kind && intensity > 0 ? weatherGrid(s.weather, view, cssArea, this.lowQuality ? 0.5 : 1) : weatherGrid(null);
    const wind = kind?.wind ?? 0;
    return {
      env: [biome, weather, intensity, off ? 0 : this.flash(now)],
      env2: [wind, density, grid.count, this.reducedMotion ? 0 : 1],
      wgrid: [grid.bx, grid.by, grid.cols, grid.rows],
      wcell: [kind?.cell ?? 1, grid.block, grid.fade, particleScale(zoom)],
      wphase: [...this.phases, this.sway],
      wfall: [kind?.height ?? 0, ...(kind?.periods ?? [0, 0, 0]).map((p) => wind * p)],
    };
  }
}
