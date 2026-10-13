// Weather on screen: turns the engine's sky (Game.weather_json, engine/src/
// weather.rs) into renderer uniforms (shaders weather.wgsl, sky.wgsl,
// terrain.wgsl), the HUD weather badge with what the weather does, and the
// thunder hook for the sound system. Pure apart from the time passed in, so
// it runs under Node tests.

export const BIOME_IDS = Object.freeze({ temperate: 0, snow: 1, desert: 2 });
export const WEATHER_IDS = Object.freeze({ clear: 0, rain: 1, thunderstorm: 2, snowfall: 3, sandstorm: 4, heatwave: 5 });

const LABELS = { clear: 'Clear', rain: 'Rain', thunderstorm: 'Thunderstorm', snowfall: 'Snowfall', sandstorm: 'Sandstorm', heatwave: 'Heat wave' };
const BIOME_LABELS = { temperate: 'Temperate', snow: 'Snow', desert: 'Desert' };

/** Particles per weather at full intensity on a 1920 x 1080 view. */
const PARTICLES = { rain: 900, thunderstorm: 1300, snowfall: 700, sandstorm: 900 };
export const MAX_PARTICLES = 1600;
/** Seconds the weather takes to build up and die down. */
const RAMP = 4;
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
    effects.push('Lightning halves the health of what it strikes and knocks out the power of a struck power plant\'s owner for 15 s. Lightning Rods ground every strike within their range');
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
 * `reducedMotion`: prefers-reduced-motion (no flicker, soft flashes, slow
 * particles); `lowQuality`: fewer particles.
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
        this.thunderAt = now + 0.3 + Math.min(2.5, d / 1200);
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

  /** Particles to draw for a view of `w` x `h` device pixels. */
  particles(w, h) {
    const s = this.state;
    const per = s ? PARTICLES[s.weather] : 0;
    if (!per) return 0;
    const area = Math.max(0.25, Math.min(2, (w * h) / (1920 * 1080)));
    const quality = this.lowQuality ? 0.4 : 1;
    const motion = this.reducedMotion ? 0.5 : 1;
    return Math.min(MAX_PARTICLES, Math.round(per * area * quality * motion * this.intensity()));
  }

  /** Renderer uniforms: `env` [biome, weather, intensity, flash] and `env2` [wind x, wind y, particles, motion]. */
  uniforms(now, w = 1920, h = 1080) {
    const s = this.state;
    const biome = BIOME_IDS[s?.biome] ?? 0;
    const off = !s || s.mode === 'off';
    const weather = off ? 0 : (WEATHER_IDS[s.weather] ?? 0);
    const wind = weather === WEATHER_IDS.sandstorm ? 420 : weather === WEATHER_IDS.thunderstorm ? 120 : 60;
    return {
      env: [biome, weather, off ? 0 : this.intensity(), off ? 0 : this.flash(now)],
      env2: [wind, 0, off ? 0 : this.particles(w, h), this.reducedMotion ? 0 : 1],
    };
  }
}
