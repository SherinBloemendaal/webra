// Panels of the map editor's side bar that show the state of things: the
// history, the layers, the fairness report, the problems with their quick
// fixes, the stamps and the keyboard shortcuts. Each builder takes data and
// callbacks and returns DOM (createElement and textContent only: the CSP
// allows no markup strings and no style attributes), so the editor and the
// tests build them the same way.

import { el } from './ui.js';
import { checkbox } from '../../js/ui/controls.js';
import { formatCombo } from '../../js/hotkeys.js';

// ---- History -------------------------------------------------------------------------

/**
 * The undo history as a list: the oldest step first, the current state
 * marked, redo steps after it greyed. Clicking a step goes back or forward
 * to just after it (`onGo(steps)`: negative undoes, positive redoes).
 */
export function historyList(undo, redo, onGo) {
  const item = (label, offset, time) =>
    el('li', { class: `history-step ${offset < 0 ? 'past' : offset > 0 ? 'future' : 'current'}`, 'aria-current': offset === 0 ? 'step' : undefined }, [
      el('button', { type: 'button', class: 'history-go', title: offset === 0 ? 'The map as it is now' : offset < 0 ? 'Go back to here' : 'Go forward to here', disabled: offset === 0, onclick: () => onGo(offset) }, [
        el('span', { class: 'history-label' }, label),
        time ? el('span', { class: 'history-time' }, new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null,
      ]),
    ]);
  // The first entry is the map before the oldest remembered step.
  const items = [item('Opened', -undo.length, null)];
  undo.forEach((e, k) => items.push(item(e.label, k + 1 - undo.length, e.time)));
  // The next redo is the last of the redo stack.
  for (let k = redo.length - 1; k >= 0; k--) items.push(item(redo[k].label, redo.length - k, redo[k].time));
  return el('ol', { class: 'history', 'aria-label': 'Undo history' }, items);
}

// ---- Layers ----------------------------------------------------------------------------

/** The layers a map view can show (state.layers keys), in panel order. */
export const LAYERS = [
  { key: 'grid', label: 'Grid', hint: 'Cell lines, a stronger one every 8 cells.' },
  { key: 'actors', label: 'Actors', hint: 'Structures, units, trees and everything else placed on the map.' },
  { key: 'spawns', label: 'Spawns', hint: 'Start positions with their numbers.' },
  { key: 'resources', label: 'Ore and gems highlight', hint: 'Outlines every cell with ore (gold) or gems (purple).' },
  { key: 'passability', label: 'Passability', hint: 'Red where ground units cannot go (terrain, structures, trees, walls), as the game sees it.' },
  { key: 'buildable', label: 'Buildable ground', hint: 'Green where a structure can be placed.' },
  { key: 'zones', label: 'Spawn zones', hint: 'Each cell in the colour of the start that reaches it first by ground.' },
  { key: 'rush', label: 'Rush paths', hint: 'The shortest ground path from each start to the nearest other start.' },
  { key: 'reach', label: 'Unreachable ground', hint: 'Dark where ground units from spawn 1 cannot get.' },
];

/** Layer switches; `onChange(key, on)`. */
export function layersList(layers, onChange) {
  return el(
    'div',
    { class: 'layers' },
    LAYERS.map((l) => checkbox({ label: l.label, hint: l.hint, checked: !!layers[l.key], onChange: (on) => onChange(l.key, on) }).row),
  );
}

// ---- Fairness ---------------------------------------------------------------------------

/** Fairness numbers per spawn and how far they spread (largest over smallest). */
export const FAIRNESS_COLUMNS = [
  { key: 'rush', label: 'Rush', title: 'Ground steps to the nearest other start' },
  { key: 'ore', label: 'Ore', title: 'Ore within reach of the start (density summed)' },
  { key: 'gems', label: 'Gems', title: 'Gems within reach of the start (density summed; a gem pays twice)' },
  { key: 'buildable', label: 'Build', title: 'Buildable cells within reach of the start' },
  { key: 'zone', label: 'Zone', title: 'Cells this start reaches first by ground' },
];

/** The spread of a column: max / min over the spawns that have a value, or null. */
export function spread(bases, key) {
  const v = bases.map((b) => b[key]).filter((x) => typeof x === 'number');
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  return lo === 0 ? (hi === 0 ? 1 : Infinity) : hi / lo;
}

/**
 * The fairness table (engine editor_report): a row per spawn in its colour,
 * a spread row, and notes for cut-off starts. `teamCss(k)` is spawn k's colour.
 * Spreads above `warnAt` are marked.
 */
export function fairnessView(report, teamCss, onJump, warnAt = 1.25) {
  if (!report || !report.bases.length) return el('p', { class: 'hint' }, 'Place spawns to compare the starts.');
  const head = el('tr', {}, [el('th', {}, 'Spawn'), ...FAIRNESS_COLUMNS.map((c) => el('th', { title: c.title }, c.label))]);
  const rows = report.bases.map((b, k) => {
    const swatch = el('span', { class: 'swatch-dot' });
    swatch.style.setProperty('--dot', teamCss(k));
    return el('tr', {}, [
      el('th', {}, el('button', { type: 'button', class: 'link', title: 'Show this start', onclick: () => onJump(k) }, [swatch, ` ${k + 1}`])),
      ...FAIRNESS_COLUMNS.map((c) => el('td', {}, b[c.key] === null || b[c.key] === undefined ? 'none' : String(b[c.key]))),
    ]);
  });
  const spreads = FAIRNESS_COLUMNS.map((c) => {
    const s = spread(report.bases, c.key);
    const text = s === null ? '' : s === Infinity ? 'one has none' : `x${s.toFixed(2)}`;
    return el('td', { class: s !== null && s > warnAt ? 'unfair' : 'fair', title: s !== null && s > warnAt ? 'The starts differ a lot here' : '' }, text);
  });
  const notes = [];
  if (report.unreachableSpawns.length) notes.push(el('p', { class: 'error' }, `Cut off by ground from spawn 1: ${report.unreachableSpawns.map((k) => k + 1).join(', ')}.`));
  notes.push(el('p', { class: 'hint' }, `Ore, gems and buildable ground count within ${report.reach} cells of each start. Measured with the game's own passability.`));
  return el('div', { class: 'fairness' }, [el('table', { class: 'fair-table' }, [el('thead', {}, head), el('tbody', {}, [...rows, el('tr', { class: 'spread' }, [el('th', {}, 'Spread'), ...spreads])])]), ...notes]);
}

// ---- Problems ---------------------------------------------------------------------------

/**
 * The validation: the engine's verdict, located problems to jump to, and
 * quick fixes (js/fixes.js) as buttons. `onFix(problem, fix)`, `onJump(x, y)`.
 */
export function problemsView({ engine, issues, fixes }, onFix, onJump) {
  const items = [];
  const fixed = new Set();
  for (const p of fixes) {
    const located = p.x !== undefined;
    items.push(
      el('li', { class: p.level }, [
        el('span', { class: 'issue-text' }, p.message),
        el('span', { class: 'issue-actions' }, [
          located ? el('button', { type: 'button', class: 'link', onclick: () => onJump(p.x, p.y) }, 'Show') : null,
          ...p.fixes.map((f) => el('button', { type: 'button', class: 'fix', onclick: () => onFix(p, f) }, f.label)),
        ]),
      ]),
    );
    fixed.add(p.message);
  }
  for (const e of engine.errors) if (![...fixed].some((m) => e.includes(m) || m.includes(e))) items.push(el('li', { class: 'error' }, el('span', { class: 'issue-text' }, e)));
  for (const i of issues) {
    if (fixed.has(i.message)) continue;
    const level = i.level === 'error' && engine.errors.length === 0 ? 'warning' : i.level;
    const located = i.x !== undefined && i.y !== undefined;
    if (level !== 'warning' && !located) continue;
    items.push(
      el('li', { class: level }, [
        el('span', { class: 'issue-text' }, i.message),
        located ? el('span', { class: 'issue-actions' }, el('button', { type: 'button', class: 'link', onclick: () => onJump(i.x, i.y) }, 'Show')) : null,
      ]),
    );
  }
  return el('ul', { class: 'issues' }, items);
}

// ---- Stamps -----------------------------------------------------------------------------

/** Saved stamps: use, rename and delete. `stamps`: [{ name, region: { w, h }, savedAt }]. */
export function stampsList(stamps, { onUse, onRename, onDelete }) {
  if (!stamps.length) return el('p', { class: 'hint' }, 'No stamps yet. Select a region (M), then "Save as stamp".');
  return el(
    'ul',
    { class: 'stamps' },
    stamps.map((s, k) =>
      el('li', {}, [
        el('button', { type: 'button', class: 'stamp-use', title: 'Paste this stamp', onclick: () => onUse(k) }, [el('span', { class: 'stamp-name' }, s.name), el('span', { class: 'muted' }, ` ${s.region.w} x ${s.region.h}`)]),
        el('button', { type: 'button', class: 'link', onclick: () => onRename(k) }, 'Rename'),
        el('button', { type: 'button', class: 'link danger-link', onclick: () => onDelete(k) }, 'Delete'),
      ]),
    ),
  );
}

// ---- Keys -------------------------------------------------------------------------------

/**
 * The editor's shortcuts by group, each with its keys and a button to
 * change them: `onRebind(name)` starts listening for a key, `onReset(name)`.
 * `listening` names the action waiting for a key.
 */
export function keysList(actions, { onRebind, onReset, listening = null, mac }) {
  const groups = new Map();
  for (const a of actions) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  return el(
    'div',
    { class: 'keys-list' },
    [...groups].map(([group, list]) =>
      el('section', {}, [
        el('h2', {}, group),
        el(
          'table',
          { class: 'keys' },
          list.map((a) =>
            el('tr', {}, [
              el('th', {}, a.label),
              el('td', {}, [
                el(
                  'button',
                  { type: 'button', class: listening === a.name ? 'key-bind listening' : 'key-bind', disabled: a.readonly, title: a.readonly ? 'This key cannot be changed' : 'Click, then press the new key', onclick: () => onRebind(a.name) },
                  listening === a.name ? 'Press a key...' : a.keys.length ? a.keys.map((k) => formatCombo(k, mac)).join(', ') : 'Not bound',
                ),
                a.readonly ? null : el('button', { type: 'button', class: 'link', onclick: () => onReset(a.name) }, 'Default'),
              ]),
            ]),
          ),
        ),
      ]),
    ),
  );
}
