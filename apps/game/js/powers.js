// Support power bar: one button per support power the player has (from
// `player_json().powers`, see engine/src/powers.rs), with its name, a charge
// bar and the time left. A ready power flashes; clicking it starts targeting
// on the map (Input.startPowerTargeting): click the target, or drag from the
// target to choose the direction aircraft fly in. Escape or right click cancels.
// The support power hotkeys pick the n-th power (js/gamekeys.js; OpenRA has no default keys).
// Each button has the shared tooltip (js/ui/tooltip.js, OpenRA's
// SUPPORT_POWER_TOOLTIP): name, its key, the charge state and the description.

import { boundKey } from './hotkeys.js';
import { attachTooltip } from './ui/tooltip.js';

/**
 * Tooltip of a support power button.
 * @param {{ name: string, description: string, ready: boolean, charging: boolean, remainingTicks: number }} p player_json power
 * @param {string | null} hotkey
 * @param {number} ticksPerSecond
 */
export function powerTip(p, hotkey, ticksPerSecond) {
  let state;
  if (p.ready) state = { text: 'Ready: click it, then the target.', tone: 'hint' };
  else if (p.charging) state = { text: `Charging: ${clock(p.remainingTicks / ticksPerSecond)} left.`, tone: 'hint' };
  else state = { text: 'Paused: not enough power.', tone: 'warn' };
  return { title: p.name, hotkey, desc: p.description, notes: [state] };
}

export class PowerBar {
  /**
   * @param {HTMLElement} parent element the bar is placed in (the battlefield)
   * @param {{ ticksPerSecond: number, onSelect(power): void, onTargetLost?(): void, hotkeys?: import('./hotkeys.js').HotkeyRegistry }} hooks
   *   `hotkeys`: the registry, for the support power keys in the tooltips
   */
  constructor(parent, hooks) {
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.id = 'powers';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Support powers');
    parent.appendChild(this.root);
    this.buttons = new Map(); // key -> { el, fill, time, power }
    this.targeting = null;
  }

  /** Refresh from `player_json().powers`. */
  update(powers) {
    const seen = new Set();
    powers.forEach((p, index) => {
      seen.add(p.key);
      let b = this.buttons.get(p.key);
      if (!b) {
        b = this.create(p);
        this.buttons.set(p.key, b);
      }
      b.power = p;
      // Keep the engine's order (palette order) without moving nodes needlessly.
      if (this.root.children[index] !== b.el) this.root.insertBefore(b.el, this.root.children[index] ?? null);
      b.fill.style.width = `${Math.round(Math.max(0, Math.min(1, p.progress)) * 100)}%`;
      b.time.textContent = p.ready ? 'Ready' : p.charging ? clock(p.remainingTicks / this.hooks.ticksPerSecond) : 'Paused';
      b.el.classList.toggle('ready', p.ready);
      b.el.classList.toggle('paused', !p.ready && !p.charging);
      b.el.classList.toggle('targeting', this.targeting === p.key);
      b.el.disabled = !p.ready;
      b.tip.refresh();
    });
    for (const [key, b] of this.buttons) {
      if (!seen.has(key)) {
        b.tip.detach();
        b.el.remove();
        this.buttons.delete(key);
      }
    }
    // The targeted power was lost (airfield destroyed) or used: stop targeting.
    if (this.targeting && !this.buttons.get(this.targeting)?.power.ready) {
      this.setTargeting(null);
      this.hooks.onTargetLost?.();
    }
    this.root.hidden = this.buttons.size === 0;
  }

  /**
   * The support power hotkeys (OpenRA SupportPower01..06): target the
   * `index`-th power of the bar (0-based, palette order) when it is ready.
   */
  activate(index) {
    const el = this.root.children[index];
    const b = el && [...this.buttons.values()].find((x) => x.el === el);
    if (b?.power.ready) this.hooks.onSelect(b.power);
  }

  /** Highlight the power being targeted (null: none). */
  setTargeting(key) {
    this.targeting = key;
    for (const [k, b] of this.buttons) b.el.classList.toggle('targeting', k === key);
  }

  create(p) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'power';
    const name = document.createElement('span');
    name.className = 'power-name';
    name.textContent = p.name;
    const time = document.createElement('span');
    time.className = 'power-time';
    const bar = document.createElement('span');
    bar.className = 'power-bar';
    const fill = document.createElement('span');
    fill.className = 'power-fill';
    bar.appendChild(fill);
    el.append(name, time, bar);
    // Keep the click from reaching the map (it would deselect units).
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', () => {
      const b = this.buttons.get(p.key);
      if (b?.power.ready) this.hooks.onSelect(b.power);
    });
    const rec = { el, fill, time, power: p };
    // The hotkey of the button's place in the bar (SupportPower01.., js/gamekeys.js).
    const key = () => {
      const index = [...this.root.children].indexOf(el);
      return index >= 0 ? boundKey(this.hooks.hotkeys, `supportPower${String(index + 1).padStart(2, '0')}`) : null;
    };
    rec.tip = attachTooltip(el, () => powerTip(rec.power, key(), this.hooks.ticksPerSecond));
    return rec;
  }
}

function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
