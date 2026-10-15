// The battlefield tooltip, like OpenRA's (WorldTooltipLogic.cs,
// ViewportControllerWidget.cs, TooltipContainerWidget.cs and
// mods/common/chrome/tooltips.yaml WORLD_TOOLTIP): with the mouse still over
// the battlefield for a moment, a "dialog4" panel under the cursor names what
// is there. An actor or a remembered structure gets its name (or for the
// relationships of its GenericVisibility the generic name, "Enemy Soldier"),
// under it the owner's flag and name in the owner's colour, then extra lines
// (a tech building's capture text, the refund in sell mode); unexplored
// cells read "Unrevealed Terrain", ore and gems "Valuable Minerals".
//
// What the viewer may know is the engine's (engine/src/tooltip.rs,
// `Game.world_tooltip`): shroud, fog, cloak and disguises apply there, with
// the eyes of the view the screen shows (a player, or a spectator view).
// This module only decides when the panel shows, what it says and where.
//
// DOM through createElement and textContent only (strict CSP); the position
// is set through CSSOM properties.

/** TooltipContainerWidget.TooltipDelayMilliseconds: the mouse rests this long first. */
export const WORLD_TOOLTIP_DELAY_MS = 200;
/** TooltipContainerWidget.CursorOffset (0, 20) and BottomEdgeYOffset (-5), CSS px. */
export const CURSOR_OFFSET_Y = 20;
export const BOTTOM_EDGE_Y_OFFSET = -5;

/**
 * Where the panel goes (TooltipContainerWidget.ChildOrigin): `CURSOR_OFFSET_Y`
 * under the cursor; moved left so it ends at the right edge when it would
 * cross it; above the cursor when it would cross the bottom edge. All in CSS px.
 * @param {{ x: number, y: number }} mouse the cursor in the page
 * @param {{ width: number, height: number }} size the panel
 * @param {{ width: number, height: number }} viewport the page
 */
export function worldTooltipPosition(mouse, size, viewport) {
  let x = mouse.x;
  let y = mouse.y + CURSOR_OFFSET_Y;
  if (x + size.width > viewport.width) x = viewport.width - size.width;
  if (y + size.height > viewport.height) y = mouse.y + BOTTOM_EDGE_Y_OFFSET - size.height;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * What the panel says, from `Game.world_tooltip`'s answer (null: nothing to
 * show). `nameOf(owner)` and `colorOf(owner)` ([r, g, b] 0..1) name and
 * colour the owner row; `refund` is the money selling the actor would give
 * when the sell mode is on and it may be sold (OpenRA Sellable's tooltip
 * text, for the owner only; walls show $0), else -1.
 * @param {null | { kind: string, label: string, id?: number | null, owner?: number | null, faction?: string | null, extras?: string[] }} tip
 * `kind` is the answer's kind (the panel mutes "Unrevealed Terrain"); the
 * refund is a line of its own (in the money colour, Tooltips board).
 * @returns {null | { label: string, kind: string, owner: null | { name: string, color: string, faction: string }, extras: string[], refund: string | null }}
 */
export function worldTooltipContent(tip, { nameOf, colorOf, refund = -1 }) {
  if (!tip || !tip.label) return null;
  const owner =
    tip.owner === null || tip.owner === undefined
      ? null
      : { name: nameOf(tip.owner), color: cssColor(colorOf(tip.owner)), faction: tip.faction ?? '' };
  const extras = [...(tip.extras ?? [])];
  return { label: tip.label, kind: tip.kind ?? 'actor', owner, extras, refund: tip.kind === 'actor' && refund >= 0 ? `Refund: $${refund}` : null };
}

function cssColor(c) {
  const [r, g, b] = (c ?? [1, 1, 1]).slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * When the panel shows (OpenRA: once the mouse has not moved for the delay,
 * and only while it is over the battlefield): `update` takes the mouse each
 * frame and says whether to show the tooltip now.
 */
export class TooltipTimer {
  constructor(delay = WORLD_TOOLTIP_DELAY_MS) {
    this.delay = delay;
    this.lastMove = -Infinity;
    this.x = null;
    this.y = null;
  }

  /** `over`: the mouse is over the battlefield (no drag, pan, touch or menu). */
  update(now, over, x, y) {
    if (!over) {
      this.x = this.y = null;
      return false;
    }
    if (x !== this.x || y !== this.y) {
      this.x = x;
      this.y = y;
      this.lastMove = now;
    }
    return now > this.lastMove + this.delay;
  }
}

/**
 * The panel itself (css/worldtooltip.css), one per game.
 *
 *   const tip = new WorldTooltip({ input, game, view: () => player, player, nameOf, colorOf });
 *   tip.frame(performance.now()); // every animation frame
 */
export class WorldTooltip {
  /**
   * @param {object} o
   * @param {object} o.input js/input.js (mouse, camera, modes, canvas)
   * @param {object} o.game the Game or its worker proxy (`world_tooltip`, `sell_value`)
   * @param {() => number} o.view the player whose eyes the screen uses (or a spectator view)
   * @param {number} o.player the local player (sell mode refunds)
   * @param {(owner: number) => string} o.nameOf
   * @param {(owner: number) => number[]} o.colorOf
   * @param {() => boolean} [o.blocked] a menu or dialog covers the battlefield
   */
  constructor({ input, game, view, player, nameOf, colorOf, blocked = () => false, doc = document }) {
    Object.assign(this, { input, game, view, player, nameOf, colorOf, blocked, doc });
    this.timer = new TooltipTimer();
    this.key = null;
    const el = (tag, cls) => {
      const e = doc.createElement(tag);
      e.className = cls;
      return e;
    };
    this.el = el('div', 'world-tooltip');
    this.el.id = 'world-tooltip';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    this.labelEl = el('div', 'world-tooltip-label');
    this.ownerEl = el('div', 'world-tooltip-owner');
    this.flagEl = el('span', 'world-tooltip-flag faction-flag');
    this.ownerName = el('span', 'world-tooltip-owner-name');
    this.ownerEl.append(this.flagEl, this.ownerName);
    this.extrasEl = el('div', 'world-tooltip-extras');
    this.refundEl = el('div', 'world-tooltip-refund');
    this.el.append(this.labelEl, this.ownerEl, this.extrasEl, this.refundEl);
    doc.body.append(this.el);
  }

  hide() {
    this.el.hidden = true;
    this.key = null;
  }

  /** Per animation frame: show, update or hide the panel. */
  frame(now) {
    const inp = this.input;
    const m = inp.mouse;
    const over = m.inside && !m.touch && !inp.drag && !inp.pan && !inp.suspended && !this.blocked();
    if (!this.timer.update(now, over, m.x, m.y)) {
      this.hide();
      return;
    }
    const w = inp.toWorld(m.x, m.y);
    const mods = inp.heldMods();
    let tip = null;
    try {
      tip = JSON.parse(this.game.world_tooltip(this.view(), w.x, w.y, mods.ctrl, mods.alt));
    } catch {
      tip = null;
    }
    // OpenRA Sellable: "Refund: $" for the owner while the sell order generator is active.
    const refund = inp.mode === 'sell' && tip?.kind === 'actor' && tip.id !== null && tip.id !== undefined ? this.game.sell_value(this.player, tip.id) : -1;
    const content = worldTooltipContent(tip, { nameOf: this.nameOf, colorOf: this.colorOf, refund });
    if (!content) {
      this.hide();
      return;
    }
    const key = JSON.stringify(content);
    if (key !== this.key) {
      this.key = key;
      this.labelEl.textContent = content.label;
      this.el.dataset.kind = content.kind;
      this.ownerEl.hidden = !content.owner;
      if (content.owner) {
        this.flagEl.dataset.faction = content.owner.faction;
        this.ownerName.textContent = content.owner.name;
        this.ownerName.style.color = content.owner.color;
      }
      this.extrasEl.hidden = content.extras.length === 0;
      this.extrasEl.textContent = content.extras.join('\n');
      this.refundEl.hidden = !content.refund;
      this.refundEl.textContent = content.refund ?? '';
    }
    this.el.hidden = false;
    const r = inp.canvas.getBoundingClientRect();
    const view = this.doc.defaultView;
    const pos = worldTooltipPosition(
      { x: r.left + m.x, y: r.top + m.y },
      { width: this.el.offsetWidth || 0, height: this.el.offsetHeight || 0 },
      { width: view?.innerWidth ?? r.right, height: view?.innerHeight ?? r.bottom },
    );
    this.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  }

  destroy() {
    this.el.remove();
  }
}
