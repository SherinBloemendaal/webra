// The biome and weather badge of the HUD (index.html #weather, css/style.css):
// the sky's name, the effects in force under it, and the same in the game's
// own tooltip (js/ui/tooltip.js) instead of the browser's native title. While
// it shows a sky the badge takes keyboard focus, so the tooltip opens from the
// keyboard too.

import { NO_EFFECT, weatherInfo } from './weather-fx.js';
import { attachTooltip } from './ui/tooltip.js';

/** The badge's tooltip: the sky's name, then what it does to the battle (null without weather). */
export function weatherTip(sky) {
  const { label, detail } = weatherInfo(sky);
  return label ? { title: label, desc: detail } : null;
}

export class WeatherBadge {
  /** @param {HTMLElement} badge */
  constructor(badge) {
    this.badge = badge;
    this.sky = null;
    this.key = '';
    badge.removeAttribute('title');
    badge.removeAttribute('tabindex');
    this.tip = attachTooltip(badge, () => weatherTip(this.sky), { side: 'right' });
  }

  /** Show the sky of the newest frame (Game.weather_json, parsed). */
  update(sky) {
    const { label, detail } = weatherInfo(sky);
    const key = `${label}|${sky?.mode}|${detail}`;
    this.sky = sky;
    if (key === this.key) return;
    this.key = key;
    const badge = this.badge;
    badge.hidden = !label;
    badge.textContent = label;
    // Focusable (its tooltip opens from the keyboard) only while it shows something.
    if (label) badge.setAttribute('tabindex', '0');
    else badge.removeAttribute('tabindex');
    if (label && sky.mode === 'full' && detail !== NO_EFFECT) {
      const line = badge.ownerDocument.createElement('span');
      line.className = 'effects';
      line.textContent = detail;
      badge.append(line);
    }
    this.tip.refresh();
  }

  /** The game is over: empty and hidden, and no tooltip. */
  clear() {
    this.tip.detach();
    this.sky = null;
    this.key = '';
    this.badge.hidden = true;
    this.badge.textContent = '';
    this.badge.removeAttribute('tabindex');
  }
}
