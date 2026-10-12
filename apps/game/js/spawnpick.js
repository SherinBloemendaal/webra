// Picking start positions on a lobby's map preview, like OpenRA's lobby
// (LobbyUtils.SelectSpawnPoint, MapPreviewWidget, SpawnSelectorTooltipLogic):
// the spawns are markers named A, B, C... filled in the colour of the player
// who starts there; clicking one asks for it.
//
// What a click does (spawnAction), OpenRA's rules with two WebRA additions:
// - A left click on a free spawn moves the first of "your" slots without a
//   picked spawn there: you, and for the host (the skirmish lobby's player)
//   the AI slots too, in slot order. When all of them have one it moves you.
//   (OpenRA: the first local client without a spawn, else the local client.)
// - A spawn that another slot picked is taken: nothing happens.
// - A left click on a spawn one of your slots picked frees it (automatic
//   again). OpenRA does nothing there and frees spawns with a right click or
//   a click beside every spawn; WebRA keeps the right click (and Delete or
//   Backspace on a focused marker) but not the click beside the spawns: the
//   preview carries the map lens, where clicks beside a marker are common.
// - A right click frees the spawn: your own, and for the host anyone's
//   (OpenRA clear_spawn). OpenRA's host also disables empty spawns with a
//   right click; WebRA has no disabled spawns.
// - Spawns only the automatic choice gave to a player (protocol spawns.js:
//   every slot shows where it starts) are free: picking one moves that
//   player on.
//
// The markers are buttons (keyboard: Tab, Enter or Space to pick, Delete or
// Backspace to free) with the shared tooltip (who starts there, and what a
// click does), over the preview and drawn into the map lens too. The lens
// never takes the pointer (css/maplens.css pointer-events: none), so a click
// on a marker under it still reaches the marker; the lens rings the marker
// the pointer or focus is on. A touch hold that showed the lens never picks
// (lifting the finger is not a tap).

import { spawnLetter } from '../protocol/spawns.js';
import { attachTooltip } from './ui/tooltip.js';

/**
 * The slots a click may move: yours, and the AI slots when you are the host.
 * @param {{ type: string, spawn?: number }[]} slots lobby slots in order ('human', 'ai', 'open', 'closed')
 * @param {number} you your slot, or -1 (a spectator)
 * @param {boolean} host
 */
export function localSlots(slots, you, host) {
  return slots.flatMap((s, i) => (i === you || (host && s.type === 'ai') ? [i] : []));
}

/** The slot that picked spawn `k`, or -1. */
export function pickedBy(slots, k) {
  return slots.findIndex((s) => (s.type === 'human' || s.type === 'ai') && s.spawn === k);
}

/**
 * What clicking spawn `k` asks for: `{ slot, spawn }` (spawn null: automatic
 * again), or null when the click does nothing. `button` is 'left' or 'right'
 * (Delete and Backspace count as right).
 */
export function spawnAction(slots, k, { you, host, button = 'left' }) {
  const owner = pickedBy(slots, k);
  const locals = localSlots(slots, you, host);
  if (button === 'right') {
    if (owner < 0) return null;
    return owner === you || host ? { slot: owner, spawn: null } : null;
  }
  if (owner >= 0) return locals.includes(owner) ? { slot: owner, spawn: null } : null;
  const unplaced = locals.filter((i) => !Number.isInteger(slots[i].spawn));
  // You first (OpenRA's local client comes before the bots it hosts), then the AI slots.
  const order = [...unplaced.filter((i) => i === you), ...unplaced.filter((i) => i !== you)];
  const slot = order[0] ?? (you >= 0 ? you : -1);
  return slot >= 0 ? { slot, spawn: k } : null;
}

/**
 * The tooltip of marker `m` (lobby-state spawnMarkers): who starts there,
 * and what a click does. `nameOf(slot)` names a slot's player.
 */
export function spawnTip(m, slots, { you, host, nameOf, enabled = true }) {
  const title = `Start position ${m.letter}`;
  const lines = [];
  if (m.slot === null) lines.push('Nobody starts here.');
  else {
    const who = m.slot === you ? 'You' : nameOf(m.slot);
    const team = slots[m.slot]?.team ? `, team ${slots[m.slot].team}` : '';
    lines.push(`${who} (P${m.slot + 1}${team}) ${m.slot === you ? 'start' : 'starts'} here${m.picked ? ' (picked).' : ' (automatic: moves on when someone picks this position).'}`);
  }
  if (enabled) {
    const left = spawnAction(slots, m.index, { you, host });
    const right = spawnAction(slots, m.index, { you, host, button: 'right' });
    if (left && left.spawn === null) lines.push(left.slot === you ? 'Click to free it: you start at an automatic position.' : `Click to free it for P${left.slot + 1}.`);
    else if (left) lines.push(left.slot === you ? 'Click to start here.' : `Click to start P${left.slot + 1} (${nameOf(left.slot)}) here.`);
    else if (m.picked) lines.push('Taken.');
    if (right && !(left && left.spawn === null)) lines.push(`Right-click to free it for P${right.slot + 1}.`);
  }
  return { title, desc: lines.join(' ') };
}

/**
 * The markers over a preview: buttons in `container` (positioned in percent
 * of the map through CSSOM, CSP), with the shared tooltip, mirrored into the
 * map lens. `onPick({ slot, spawn })` carries out a click.
 */
export class SpawnMarkers {
  /**
   * @param {HTMLElement} container the layer over the preview
   * @param {{ lens?: object | null, onPick: (action: { slot: number, spawn: number | null }) => void, doc?: Document }} o
   */
  constructor(container, { lens = null, onPick, doc = globalThis.document }) {
    this.container = container;
    this.lens = lens;
    this.onPick = onPick;
    this.doc = doc;
    this.buttons = [];
    this.tips = [];
    this.view = null;
  }

  /**
   * Show `markers` (lobby-state spawnMarkers) for the lobby `view`: { slots,
   * you, host, colors (0..1 RGB by colour index), nameOf, enabled }.
   */
  render(markers, view) {
    const focused = this.buttons.findIndex((b) => b === this.doc.activeElement);
    for (const t of this.tips) t.detach();
    this.tips = [];
    this.buttons = [];
    this.container.textContent = '';
    this.view = view;
    this.markers = markers;
    for (const m of markers) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'spawn-marker';
      b.textContent = m.letter;
      b.dataset.spawn = String(m.index);
      b.style.left = `${m.left}%`;
      b.style.top = `${m.top}%`;
      if (m.slot === null) b.classList.add('spawn-marker-empty');
      else {
        b.style.setProperty('--marker-color', rgbCss(view.colors[m.color]));
        b.classList.add(m.picked ? 'spawn-marker-picked' : 'spawn-marker-auto');
      }
      if (m.slot !== null && m.slot === view.you) b.classList.add('spawn-marker-you');
      const tip = () => spawnTip(m, view.slots, view);
      b.setAttribute('aria-label', `${tip().title}: ${tip().desc}`);
      if (!view.enabled) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.act(m.index, 'left');
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.act(m.index, 'right');
      });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        this.act(m.index, 'right');
      });
      for (const type of ['pointerenter', 'focus']) b.addEventListener(type, () => this.lens?.setHotMarker?.(m.index));
      for (const type of ['pointerleave', 'blur']) b.addEventListener(type, () => this.lens?.setHotMarker?.(-1));
      this.tips.push(attachTooltip(b, tip, { side: 'top' }));
      this.buttons.push(b);
      this.container.append(b);
    }
    if (focused >= 0) this.buttons[Math.min(focused, this.buttons.length - 1)]?.focus();
    this.lens?.setMarkers?.(markers.map((m) => ({ x: m.x, y: m.y, label: m.letter, color: m.slot === null ? null : view.colors[m.color], picked: m.picked })));
  }

  /** Carry out a click on spawn `k` (a touch hold that showed the lens is not a click). */
  act(k, button) {
    const v = this.view;
    if (!v?.enabled) return;
    if (button === 'left' && this.lens?.heldRecently?.()) return;
    const action = spawnAction(v.slots, k, { you: v.you, host: v.host, button });
    if (action) this.onPick(action);
  }

  /** Drop the markers (the preview failed or there is none). */
  clear() {
    this.render([], this.view ?? { slots: [], you: -1, host: false, colors: [], nameOf: () => '', enabled: false });
  }

  destroy() {
    for (const t of this.tips) t.detach();
    this.tips = [];
    this.buttons = [];
    this.container.textContent = '';
  }
}

function rgbCss(c) {
  const [r, g, b] = (c ?? [0.27, 0.27, 0.27]).map((v) => Math.round(v * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

export { spawnLetter };
