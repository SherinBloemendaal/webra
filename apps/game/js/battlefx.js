// What the battlefield shows of the lobby options and the bigger warheads,
// from the engine's events (engine/src/sound_events.rs: CrateCollected and
// the kinds 38 to 42):
//
// - floating cash ("+$1000") where a crate paid out, a kill earned a
//   bounty or cash changed hands (CashTick: oil derricks, captures, thieves,
//   supply trucks), in the player's colour, like OpenRA's FloatingText
//   (bounties for the killer and its allies, the rest for everyone who sees
//   the spot);
// - camera shake (OpenRA ScreenShaker: ShakeScreen warheads, ShakeOnDeath)
//   and the nuke's white flash (FlashEffect warhead);
// - message lines: time limit warnings come with the announcer
//   (js/audio/director.js), the end of the time limit and a player's defeat
//   are text only;
// - the time limit countdown at the top of the battlefield.
//
// Presentation only: nothing here goes back to the simulation. The
// "Reduce motion" setting (or the browser's prefers-reduced-motion with
// Auto) turns the shake off and the flash down. The logic (ShakeState,
// FlashState, FloatingTexts, formatClock) runs without a DOM for tests.

/** Event kinds (engine/src/sound_events.rs SoundEventKind). */
export const FX = Object.freeze({
  CRATE_COLLECTED: 36,
  BOUNTY: 38,
  TIME_LIMIT_EXPIRED: 39,
  PLAYER_LOST: 40,
  SCREEN_SHAKE: 41,
  FLASH: 42,
  CASH_TICK: 44,
});
/** sound_events.rs crate_action_code of GiveCashCrateAction. */
const GIVE_CASH = 1;
const STRIDE = 6;
/** Simulation ticks per second at normal speed: the shaker and flash count in them. */
const TICKS_PER_SECOND = 25;
/** OpenRA FloatingText duration (ticks) and rise (world pixels over it). */
export const FLOAT_TICKS = 30;
const FLOAT_RISE = 18;
/** OpenRA ScreenShakerInfo MinMultiplier / MaxMultiplier and the intensity cap. */
const MAX_MULTIPLIER = 3;
const MAX_INTENSITY = 10;
/** Brightest flash with reduce motion on (a full flash is white). */
const REDUCED_FLASH = 0.35;

/**
 * OpenRA ScreenShaker: shake effects with an expiry, a summed multiplier
 * (clamped to +-3) and an intensity that falls with the squared distance from
 * the view centre (world units), capped at 10. `offset(tick, cx, cy)` is the
 * camera offset in world pixels.
 */
export class ShakeState {
  constructor() {
    this.effects = [];
  }

  /** A shake of `duration` ticks at (x, y) (world units), `intensity`, multiplier [mx, my]. */
  add(tick, duration, x, y, intensity, multiplier = [1, 1]) {
    if (duration <= 0 || intensity <= 0) return;
    this.effects.push({ until: tick + duration, x, y, intensity, multiplier });
  }

  offset(tick, cx, cy) {
    this.effects = this.effects.filter((e) => e.until > tick);
    if (!this.effects.length) return [0, 0];
    let mx = 0;
    let my = 0;
    let intensity = 0;
    for (const e of this.effects) {
      mx += e.multiplier[0];
      my += e.multiplier[1];
      const d2 = Math.max(1, (e.x - cx) ** 2 + (e.y - cy) ** 2);
      intensity += (100 * 1024 * 1024 * e.intensity) / d2;
    }
    const clamp = (v) => Math.max(-MAX_MULTIPLIER, Math.min(MAX_MULTIPLIER, v));
    const k = Math.min(intensity, MAX_INTENSITY);
    return [clamp(mx) * k * Math.sin((tick * 2 * Math.PI) / 4), clamp(my) * k * Math.cos((tick * 2 * Math.PI) / 5)];
  }

  clear() {
    this.effects = [];
  }
}

/** OpenRA FlashPostProcessEffect: white that fades out over the effect's ticks. */
export class FlashState {
  constructor() {
    this.until = -1;
    this.duration = 0;
  }

  add(tick, duration) {
    if (duration <= 0) return;
    this.duration = duration;
    this.until = tick + duration;
  }

  /** Opacity of the white layer at `tick` (fractional ticks allowed). */
  alpha(tick, reduced = false) {
    if (tick >= this.until || this.duration <= 0) return 0;
    const a = Math.min(1, (this.until - tick) / this.duration);
    return reduced ? a * REDUCED_FLASH : a;
  }
}

/** Floating texts in world pixels: they rise and fade over FLOAT_TICKS. */
export class FloatingTexts {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  add(tick, text, x, y, color) {
    this.items.push({ id: this.nextId++, text, x, y, color, at: tick });
  }

  /** The texts at `tick`: { id, text, x, y, color, opacity }. */
  visible(tick) {
    this.items = this.items.filter((t) => tick - t.at < FLOAT_TICKS);
    return this.items.map((t) => {
      const age = Math.max(0, tick - t.at) / FLOAT_TICKS;
      return { id: t.id, text: t.text, x: t.x, y: t.y - age * FLOAT_RISE, color: t.color, opacity: 1 - age * age };
    });
  }
}

/** "+$1,000" (OpenRA FloatingText.FormatCashTick). */
export function cashText(amount) {
  return `${amount < 0 ? '-' : '+'}$${Math.abs(amount).toLocaleString('en-US')}`;
}

/** Ticks as "m:ss", or "h:mm:ss" from an hour (OpenRA WidgetUtils.FormatTime). */
export function formatClock(ticks, ticksPerSecond) {
  const total = Math.max(0, Math.ceil(ticks / Math.max(1, ticksPerSecond)));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Whether motion is reduced for the "Reduce motion" setting ('auto' follows the browser). */
export function motionReduced(setting, prefersReduced) {
  return setting === 'on' || (setting !== 'off' && !!prefersReduced);
}

/**
 * The battlefield's view of these events.
 */
export class BattleFx {
  /**
   * @param {object} o
   * @param {HTMLElement} o.field the battlefield (#field)
   * @param {{ actors: object[], timeLimit?: object }} o.rules Game.rules_json
   * @param {number} o.pxPerWorld world pixels per world unit
   * @param {(owner: number) => boolean} o.allied whether a player is the viewer or an ally
   * @param {(owner: number) => string} o.colorOf CSS colour of a player
   * @param {(owner: number) => string} o.nameOf a player's name
   * @param {(text: string) => void} o.line a message line (js/notifications.js)
   * @param {() => boolean} o.reduced reduce motion now
   */
  constructor({ field, rules, pxPerWorld, allied, colorOf, nameOf, line, reduced }) {
    Object.assign(this, { rules, pxPerWorld, allied, colorOf, nameOf, line, reduced });
    this.shake = new ShakeState();
    this.flash = new FlashState();
    this.texts = new FloatingTexts();
    this.tick = 0;
    this.root = document.createElement('div');
    this.root.id = 'battle-fx';
    this.root.setAttribute('aria-hidden', 'true');
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'battle-flash';
    this.floatEl = document.createElement('div');
    this.floatEl.className = 'battle-floats';
    this.clock = document.createElement('div');
    this.clock.className = 'battle-time-limit';
    this.clock.hidden = true;
    this.clock.setAttribute('role', 'timer');
    this.clock.setAttribute('aria-label', 'Time limit');
    this.root.append(this.flashEl, this.floatEl);
    field.append(this.root, this.clock);
    this.nodes = new Map();
  }

  /**
   * Engine events of a frame (flat, STRIDE per event), at render tick `tick`;
   * `visible(x, y)` tells whether the viewer sees a world-pixel spot.
   */
  onEvents(events, tick, visible = () => true) {
    this.tick = tick;
    if (!events) return;
    const k = this.pxPerWorld;
    for (let i = 0; i + STRIDE <= events.length; i += STRIDE) {
      const kind = events[i];
      const a = events[i + 1];
      const x = events[i + 2];
      const y = events[i + 3];
      const owner = events[i + 4];
      const b = events[i + 5];
      switch (kind) {
        case FX.CRATE_COLLECTED: {
          // a: the action's class (OpenRA crates give cash with one GiveCashCrateAction each).
          const act = a === GIVE_CASH ? this.rules.actors[b]?.crateActions?.find((c) => c.kind === 'GiveCash') : null;
          if (act && visible(x * k, y * k)) this.texts.add(tick, cashText(act.amount), x * k, y * k, this.colorOf(owner));
          break;
        }
        case FX.BOUNTY:
          if (this.allied(owner)) this.texts.add(tick, cashText(a), x * k, y * k, this.colorOf(owner));
          break;
        case FX.CASH_TICK:
          if (visible(x * k, y * k)) this.texts.add(tick, cashText(a), x * k, y * k, this.colorOf(owner));
          break;
        case FX.TIME_LIMIT_EXPIRED:
          // Warnings speak and write through the announcer (js/audio/director.js); the end is a line only.
          this.line('Time limit has expired.');
          break;
        case FX.PLAYER_LOST:
          this.line(`${this.nameOf(owner)} is defeated.`);
          break;
        case FX.SCREEN_SHAKE:
          this.shake.add(tick, a, x, y, b, [owner & 15, owner >> 4]);
          break;
        case FX.FLASH:
          this.flash.add(tick, a);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Camera offset in world pixels for the frame at render tick `tick`
   * (fractional), around the view centre (world pixels).
   */
  cameraOffset(tick, cx, cy) {
    if (this.reduced()) {
      this.shake.clear();
      return [0, 0];
    }
    const k = this.pxPerWorld;
    return this.shake.offset(Math.floor(tick), cx / k, cy / k);
  }

  /** Draw the flash and the floating texts for the camera ({ x, y, zoom }: CSS pixels per world pixel). */
  frame(tick, camera) {
    this.flashEl.style.opacity = String(this.flash.alpha(tick, this.reduced()));
    const keep = new Set();
    for (const t of this.texts.visible(tick)) {
      keep.add(t.id);
      let n = this.nodes.get(t.id);
      if (!n) {
        n = document.createElement('span');
        n.className = 'battle-float';
        n.textContent = t.text;
        n.style.color = t.color;
        this.floatEl.append(n);
        this.nodes.set(t.id, n);
      }
      n.style.transform = `translate(${(t.x - camera.x) * camera.zoom}px, ${(t.y - camera.y) * camera.zoom}px) translate(-50%, -50%)`;
      n.style.opacity = String(t.opacity);
    }
    for (const [id, n] of this.nodes) {
      if (!keep.has(id)) {
        n.remove();
        this.nodes.delete(id);
      }
    }
  }

  /** The time limit from Game.player_json (`timeLimit`: { left, ticksPerSecond } or null). */
  timeLimit(state) {
    const t = state?.timeLimit;
    this.clock.hidden = !t || !!state.gameOver;
    if (t) this.clock.textContent = `Time left ${formatClock(t.left, t.ticksPerSecond)}`;
  }

  /** Real seconds to render ticks (the shaker and flash count ticks of normal speed). */
  static ticksAt(seconds) {
    return seconds * TICKS_PER_SECOND;
  }
}
