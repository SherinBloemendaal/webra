// Support power timers: the top-left list of superweapon countdowns, OpenRA's
// SupportPowerTimer widget (mods/ra/chrome/ingame-player.yaml, Widgets/
// SupportPowerTimerWidget.cs). One line per power whose
// DisplayTimerRelationships include the local player's relationship to its
// owner (in Red Alert the Atom Bomb and the GPS Satellite, to everyone):
// "<player>'s <power>: m:ss" (mods/ra/fluent/ra.ftl support-power-timer) in
// the owner's colour, blinking white every other 25 ticks once ready. The
// engine decides what the viewer may see (engine/src/powers.rs
// `power_timers`, `Game.power_timers_json(viewer)`).
//
// Like OpenRA's Red Alert, only players have it: spectators, replays and a
// defeated player who watches on get the observer panel (js/observer.js,
// Support powers) instead.

/** OpenRA SupportPowerTimerWidget: Game.LocalTick % 50 < 25 shows the owner's colour. */
export const BLINK_TICKS = 50;

/**
 * OpenRA WidgetUtils.FormatTime(ticks, leadingMinuteZero: false, timestep):
 * whole seconds rounded up, "m:ss", or "h:mm:ss" from an hour.
 * @param {number} ticks
 * @param {number} tickMs milliseconds per tick of the game speed (World.Timestep)
 */
export function formatPowerTime(ticks, tickMs) {
  const seconds = Math.max(0, Math.ceil((ticks * tickMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * OpenRA SpriteFont.GetContrastColor with TextContrastColorDark 000000 and
 * TextContrastColorLight 7F7F7F (mods/common/metrics.yaml): the shadow of
 * a light text is black, of a dark one grey.
 * @param {number[]} rgb 0..1
 */
export function shadowColor(rgb) {
  const [r, g, b] = rgb.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  const brightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
  return brightness > 0.33 ? [0, 0, 0] : [127 / 255, 127 / 255, 127 / 255];
}

/**
 * The lines to show (OpenRA SupportPowerTimerWidget.Tick).
 * @param {Array<{ player: number, key: string, name: string, remainingTicks: number, ready: boolean }>} timers Game.power_timers_json
 * @param {{ tick: number, tickMs: number, nameOf(player: number): string, colorOf(player: number): number[] }} o
 * @returns {Array<{ id: string, text: string, color: number[], shadow: number[] }>}
 */
export function timerLines(timers, { tick, tickMs, nameOf, colorOf }) {
  const white = [1, 1, 1];
  return timers.map((t) => {
    const color = !t.ready || tick % BLINK_TICKS < BLINK_TICKS / 2 ? (colorOf(t.player) ?? white) : white;
    return {
      id: `${t.player}:${t.key}`,
      text: `${nameOf(t.player)}'s ${t.name}: ${formatPowerTime(t.remainingTicks, tickMs)}`,
      color,
      shadow: shadowColor(color),
    };
  });
}

const css = (c) => `rgb(${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(', ')})`;

export class PowerTimers {
  /** @param {HTMLElement} parent the battlefield (#field) */
  constructor(parent) {
    this.root = document.createElement('div');
    this.root.id = 'power-timers';
    this.root.setAttribute('aria-label', 'Support power timers');
    this.root.hidden = true;
    parent.appendChild(this.root);
    this.nodes = new Map(); // id -> element
  }

  /** Show `lines` (timerLines), top to bottom (OpenRA Order: Descending). */
  update(lines) {
    const els = lines.map((l) => {
      let el = this.nodes.get(l.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'power-timer';
        this.nodes.set(l.id, el);
      }
      if (el.textContent !== l.text) el.textContent = l.text;
      el.style.color = css(l.color);
      el.style.textShadow = `1px 1px 0 ${css(l.shadow)}`;
      return el;
    });
    const keep = new Set(lines.map((l) => l.id));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.nodes.delete(id);
    // Only touch the list when a line came, went or moved.
    const kids = this.root.children;
    if (kids.length !== els.length || els.some((el, i) => kids[i] !== el)) this.root.replaceChildren(...els);
    this.root.hidden = lines.length === 0;
  }

  /** Clear the list (the player started watching). */
  clear() {
    this.update([]);
  }
}
