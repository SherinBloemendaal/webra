// The icon panels of the observer statistics (js/observer.js): per player a
// row of cameos, like OpenRA's ObserverProductionIcons (each production
// tab's current item with the build clock, its time left, "Ready" or "On
// hold"), ObserverSupportPowerIcons (each support power with its charge
// clock and time left or "Ready") and ObserverArmyIcons (each unit type with
// its count), with OpenRA's tooltips (ProductionTooltipLogic,
// SupportPowerTooltipLogic, ArmyTooltipLogic).
//
// The data comes from the engine: `Game.observer_production` (queues and
// powers) and `Game.army_counts`. The strips keep their elements between
// updates and only write what changed; the pictures are painted once per
// icon (and again with `repaint` when the installed content changes).

import { formatClock, productionTip } from './production.js';
import { attachTooltip } from './ui/tooltip.js';

/** CSS size of an icon: OpenRA's 32 x 24 observer icons, a little larger for the browser. */
export const ICON_CSS = { width: 40, height: 30 };

/** OpenRA WidgetUtils.FormatTime: whole seconds rounded up, "mm:ss" (h:mm:ss from an hour on). */
export function iconTime(ticks, ticksPerSecond = 25) {
  return formatClock(Math.ceil(Math.max(0, ticks) / ticksPerSecond));
}

/**
 * The production icons of a player (OpenRA ObserverProductionIconsWidget):
 * the current item of every production tab, grouped by type (the count
 * shows how many tabs build it; in Red Alert every type has one tab, so it
 * is one), ordered by tab (ProductionQueue DisplayOrder) and then
 * BuildPaletteOrder. Within a group the ready item comes first, then the
 * building ones, then those on hold, the least time left first.
 *
 * @param {{ queues?: { queue: number, id: string, progress: number, done: boolean, paused: boolean, remainingTicks: number, buildTicks?: number }[] } | null} prod
 *   `Game.observer_production` (parsed)
 * @param {Map<string, object>} actorsById rules_json actors by id
 * @param {number} [ticksPerSecond]
 * @returns {{ key: string, actor: object, item: object, count: number, progress: number, text: string }[]}
 */
export function productionIcons(prod, actorsById, ticksPerSecond = 25) {
  const groups = new Map();
  for (const it of prod?.queues ?? []) {
    const actor = actorsById.get(it.id);
    if (!actor) continue;
    let g = groups.get(it.id);
    if (!g) groups.set(it.id, (g = { actor, items: [] }));
    g.items.push(it);
  }
  const rank = (it) => (it.done ? 0 : it.paused ? 2 : 1);
  const list = [...groups.values()].map((g) => {
    g.items.sort((a, b) => rank(a) - rank(b) || a.remainingTicks - b.remainingTicks);
    return g;
  });
  list.sort((a, b) => a.items[0].queue - b.items[0].queue || (a.actor.order ?? 0) - (b.actor.order ?? 0));
  return list.map(({ actor, items }) => {
    const item = items[0];
    // GetOverlayForItem: ON HOLD before READY, else the time left (RemainingTimeActual).
    const text = item.paused ? 'On hold' : item.done ? 'Ready' : iconTime(item.remainingTicks, ticksPerSecond);
    return {
      key: actor.id,
      actor,
      item,
      count: items.length,
      progress: item.done ? 1 : Math.max(0, Math.min(1, item.progress)),
      text,
    };
  });
}

/**
 * The support power icons of a player (OpenRA ObserverSupportPowerIconsWidget):
 * every power it has in palette order, the charge clock, and "Ready" or
 * the time left. Ready is OpenRA's SupportPowerInstance.Ready: charged and
 * Active, that is with a powered provider; a power whose providers are all
 * without power (`paused`) shows its time left in red, 00:00 once charged
 * (OpenRA's "ON HOLD" is for powers without a provider, which it leaves out).
 * @param {{ powers?: { key: string, icon: string, name: string, description: string, progress: number, ready: boolean, charging: boolean, remainingTicks: number, totalTicks: number }[] } | null} prod
 */
export function powerIcons(prod, ticksPerSecond = 25) {
  return (prod?.powers ?? []).map((p) => ({
    key: p.key,
    power: p,
    progress: p.ready ? 1 : Math.max(0, Math.min(1, p.progress)),
    paused: !p.charging,
    text: p.ready && p.charging ? 'Ready' : iconTime(p.remainingTicks, ticksPerSecond),
  }));
}

/**
 * The army icons of a player (OpenRA ObserverArmyIconsWidget): every unit
 * type with its count, in the engine's order (`Game.army_counts`: by
 * production tab, then palette order).
 * @param {ArrayLike<number>} flat `[actor type index, count, ...]`
 * @param {object[]} actors rules_json actors in rules order
 */
export function armyIcons(flat, actors) {
  const out = [];
  for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) {
    const actor = actors[flat[i]];
    if (actor && flat[i + 1] > 0) out.push({ key: actor.id, actor, count: flat[i + 1] });
  }
  return out;
}

/** Tooltip of a production icon (OpenRA ProductionTooltipLogic for observers: no hotkey, no click hints). */
export function productionIconTip(icon, prod, { ticksPerSecond = 25, lowPowerModifier = 100 } = {}) {
  const tip = productionTip(icon.actor, { buildTicks: icon.item.buildTicks }, prod, { ticksPerSecond, lowPowerModifier });
  return { ...tip, notes: [] };
}

/** Tooltip of a support power icon (OpenRA SupportPowerTooltipLogic): name, "time left / charge time" (red while paused) and the description. */
export function powerIconTip(icon, ticksPerSecond = 25) {
  const p = icon.power;
  const text = `${iconTime(p.remainingTicks, ticksPerSecond)} / ${iconTime(p.totalTicks, ticksPerSecond)}`;
  return {
    title: p.name,
    stats: [
      {
        kind: 'time',
        label: 'charge time',
        text,
        bad: !p.charging,
      },
    ],
    desc: p.description || '',
  };
}

/** Tooltip of an army icon (OpenRA ArmyTooltipLogic): name and description. */
export function armyIconTip(icon) {
  return { title: icon.actor.name, desc: icon.actor.description || '' };
}

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * One player's row of icons. `update(icons)` takes the output of
 * productionIcons / powerIcons / armyIcons (each with a stable `key`).
 */
export class IconStrip {
  /**
   * @param {{
   *   kind: 'production' | 'powers' | 'army',
   *   paint(canvas: HTMLCanvasElement, icon: object): void,
   *   tip(icon: object): object | null,
   *   backing?: { width: number, height: number },
   *   doc?: Document,
   * }} o `paint` draws the picture (called once per icon), `tip` builds its tooltip spec
   */
  constructor({ kind, paint, tip, backing = ICON_CSS, doc = globalThis.document }) {
    this.kind = kind;
    this.paint = paint;
    this.tip = tip;
    this.backing = backing;
    this.doc = doc;
    this.root = el(doc, 'span', `observer-icons observer-icons-${kind}`);
    this.root.setAttribute('role', 'list');
    /** key -> icon record */
    this.icons = new Map();
    this.order = [];
  }

  create(icon) {
    const doc = this.doc;
    const root = el(doc, 'span', 'observer-icon');
    root.setAttribute('role', 'listitem');
    const canvas = el(doc, 'canvas', 'observer-icon-art');
    canvas.width = this.backing.width;
    canvas.height = this.backing.height;
    canvas.setAttribute('aria-hidden', 'true');
    root.append(canvas);
    const rec = {
      root,
      canvas,
      icon,
      clock: null,
      text: null,
      count: null,
      last: {},
    };
    if (this.kind !== 'army') {
      // The clock: a shade over the part still to go, like the sidebar's build clock.
      rec.clock = el(doc, 'span', 'observer-icon-clock');
      rec.text = el(doc, 'span', 'observer-icon-text');
      root.append(rec.clock, rec.text);
    }
    rec.count = el(doc, 'span', 'observer-icon-count');
    rec.count.hidden = true;
    root.append(rec.count);
    this.paint(canvas, icon);
    rec.tooltip = attachTooltip(root, () => this.tip(rec.icon));
    return rec;
  }

  /** Show `icons` (in order), reusing the elements of icons that stay. */
  update(icons) {
    const seen = new Set();
    let reorder = icons.length !== this.order.length;
    icons.forEach((icon, i) => {
      seen.add(icon.key);
      let rec = this.icons.get(icon.key);
      if (!rec) {
        rec = this.create(icon);
        this.icons.set(icon.key, rec);
        reorder = true;
      }
      if (this.order[i] !== icon.key) reorder = true;
      rec.icon = icon;
      this.apply(rec, icon);
    });
    for (const [key, rec] of this.icons) {
      if (seen.has(key)) continue;
      rec.tooltip.detach();
      rec.root.remove();
      this.icons.delete(key);
    }
    if (reorder) {
      this.order = icons.map((x) => x.key);
      this.root.replaceChildren(...this.order.map((k) => this.icons.get(k).root));
    }
  }

  /** Write what changed of one icon. */
  apply(rec, icon) {
    const last = rec.last;
    const name = icon.actor?.name ?? icon.power?.name ?? icon.key;
    const count = this.kind === 'army' ? String(icon.count) : icon.count > 1 ? String(icon.count) : '';
    const text = icon.text ?? '';
    const label = [name, text, this.kind === 'army' ? `${icon.count}` : count ? `${count} building` : ''].filter(Boolean).join(', ');
    if (rec.clock && last.progress !== icon.progress) {
      last.progress = icon.progress;
      rec.clock.style.setProperty('--p', icon.progress.toFixed(3));
      rec.clock.hidden = icon.progress >= 1;
    }
    if (rec.text && last.text !== text) {
      last.text = text;
      rec.text.textContent = text;
      rec.root.classList.toggle('observer-icon-ready', text === 'Ready');
      rec.root.classList.toggle('observer-icon-hold', text === 'On hold');
    }
    if (last.paused !== !!icon.paused) {
      last.paused = !!icon.paused;
      // A support power without a powered provider: its time in red, like OpenRA's tooltip.
      rec.root.classList.toggle('observer-icon-paused', last.paused);
    }
    if (last.count !== count) {
      last.count = count;
      rec.count.textContent = count;
      rec.count.hidden = !count;
    }
    if (last.label !== label) {
      last.label = label;
      rec.root.setAttribute('aria-label', label);
    }
    rec.tooltip.refresh();
  }

  /** Paint every picture again (installed content changed). */
  repaint() {
    for (const rec of this.icons.values()) this.paint(rec.canvas, rec.icon);
  }

  remove() {
    for (const rec of this.icons.values()) rec.tooltip.detach();
    this.icons.clear();
    this.root.remove();
  }
}
