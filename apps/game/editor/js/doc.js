// The map being edited, with transactional edits and undo/redo. No DOM.
//
// Every user action runs as one transaction: `begin()`, any number of cell,
// object (spawns, actors) or property changes, then `commit()`. Cell changes are
// stored as per-cell before/after values; objects and properties as snapshots.

import { MAP_FORMAT, createMap, decodeLayers, encodeBase64, isPassable } from './mapformat.js';
import { pruneOverrides } from './overrides.js';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1500;

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export class MapDoc {
  constructor(map = createMap()) {
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.load(map);
  }

  // ---- Loading and export --------------------------------------------------------

  /** Replace the whole document without touching history (used by undo of a replace). */
  load(map) {
    const { terrain, ore } = decodeLayers(map);
    this.width = map.width;
    this.height = map.height;
    this.terrain = terrain;
    this.ore = ore;
    this.spawns = clone(map.spawns ?? []);
    this.actors = clone(map.actors ?? []).map((a) => ({ type: a.type, owner: a.owner, x: a.x, y: a.y, facing: a.facing ?? 0 }));
    this.meta = { name: map.name ?? '', author: map.author ?? '', description: map.description ?? '' };
    this.rules = map.rules ? clone(map.rules) : null;
  }

  /** The document as a format-1 map object. */
  toMap() {
    return {
      format: MAP_FORMAT,
      name: this.meta.name,
      author: this.meta.author,
      description: this.meta.description,
      width: this.width,
      height: this.height,
      terrain: encodeBase64(this.terrain),
      ore: encodeBase64(this.ore),
      spawns: clone(this.spawns),
      actors: clone(this.actors),
      rules: pruneOverrides(this.rules),
    };
  }

  /** Replace the document with another map as one undoable step. */
  replace(map, label = 'Load map') {
    const before = this.toMap();
    this.load(map);
    this.push({ label, kind: 'replace', before, after: this.toMap() });
    this.emit({ cells: true, objects: true, meta: true, resized: true });
  }

  // ---- Events --------------------------------------------------------------------

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(change) {
    for (const fn of this.listeners) fn(change);
  }

  // ---- Queries -------------------------------------------------------------------

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  idx(x, y) {
    return y * this.width + x;
  }

  terrainAt(x, y) {
    return this.inside(x, y) ? this.terrain[this.idx(x, y)] : -1;
  }

  // ---- Transactions --------------------------------------------------------------

  begin(label, coalesceKey = null) {
    if (this.tx) this.commit();
    this.tx = { label, coalesceKey, cells: new Map(), objects: null, meta: null };
  }

  get inTransaction() {
    return this.tx !== null;
  }

  /** Set terrain and/or ore of a cell (pass `undefined` to keep one). Impassable terrain drops ore. */
  setCell(x, y, terrain, ore) {
    if (!this.inside(x, y)) return false;
    const i = this.idx(x, y);
    const t = terrain === undefined ? this.terrain[i] : terrain;
    let o = ore === undefined ? this.ore[i] : ore;
    if (!isPassable(t)) o = 0;
    if (t === this.terrain[i] && o === this.ore[i]) return false;
    this.autoBegin('Edit');
    if (!this.tx.cells.has(i)) this.tx.cells.set(i, [this.terrain[i], this.ore[i]]);
    this.terrain[i] = t;
    this.ore[i] = o;
    this.tx.dirtyCells = true;
    return true;
  }

  /** Call before mutating `spawns` or `actors` inside a transaction. */
  touchObjects() {
    this.autoBegin('Edit');
    if (!this.tx.objects) this.tx.objects = { spawns: clone(this.spawns), actors: clone(this.actors) };
  }

  /** Call before mutating `meta` or `rules` inside a transaction. */
  touchMeta() {
    this.autoBegin('Edit');
    if (!this.tx.meta) this.tx.meta = { meta: clone(this.meta), rules: clone(this.rules) };
  }

  autoBegin(label) {
    if (!this.tx) this.begin(label);
  }

  /** Close the transaction, record it if it changed anything and notify listeners. */
  commit() {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    const entry = { label: tx.label, kind: 'edit', coalesceKey: tx.coalesceKey, time: Date.now() };
    let changed = false;
    if (tx.cells.size) {
      const n = tx.cells.size;
      entry.cells = { idx: new Uint32Array(n), tb: new Uint8Array(n), ob: new Uint8Array(n), ta: new Uint8Array(n), oa: new Uint8Array(n) };
      let k = 0;
      for (const [i, [t, o]] of tx.cells) {
        entry.cells.idx[k] = i;
        entry.cells.tb[k] = t;
        entry.cells.ob[k] = o;
        entry.cells.ta[k] = this.terrain[i];
        entry.cells.oa[k] = this.ore[i];
        k++;
      }
      changed = true;
    }
    if (tx.objects) {
      const after = { spawns: clone(this.spawns), actors: clone(this.actors) };
      if (JSON.stringify(after) !== JSON.stringify(tx.objects)) {
        entry.objects = { before: tx.objects, after };
        changed = true;
      }
    }
    if (tx.meta) {
      const after = { meta: clone(this.meta), rules: clone(this.rules) };
      if (JSON.stringify(after) !== JSON.stringify(tx.meta)) {
        entry.meta = { before: tx.meta, after };
        changed = true;
      }
    }
    if (!changed) return;
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.coalesceKey &&
      top?.coalesceKey === entry.coalesceKey &&
      entry.time - top.time < COALESCE_MS &&
      entry.meta &&
      !entry.cells &&
      !entry.objects &&
      top.meta &&
      !top.cells &&
      !top.objects
    ) {
      // Typing in one field: keep a single undo step.
      top.meta.after = entry.meta.after;
      top.time = entry.time;
      this.redoStack = [];
    } else {
      this.push(entry);
    }
    this.emit({ cells: !!entry.cells, objects: !!entry.objects, meta: !!entry.meta, resized: false });
  }

  /** Abort the open transaction and restore what it changed. */
  rollback() {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    for (const [i, [t, o]] of tx.cells) {
      this.terrain[i] = t;
      this.ore[i] = o;
    }
    if (tx.objects) {
      this.spawns = tx.objects.spawns;
      this.actors = tx.objects.actors;
    }
    if (tx.meta) {
      this.meta = tx.meta.meta;
      this.rules = tx.meta.rules;
    }
    this.emit({ cells: tx.cells.size > 0, objects: !!tx.objects, meta: !!tx.meta, resized: false });
  }

  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  // ---- Undo / redo ---------------------------------------------------------------

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.tx) this.commit();
    const e = this.undoStack.pop();
    if (!e) return null;
    this.apply(e, 'before');
    this.redoStack.push(e);
    return e.label;
  }

  redo() {
    if (this.tx) this.commit();
    const e = this.redoStack.pop();
    if (!e) return null;
    this.apply(e, 'after');
    this.undoStack.push(e);
    return e.label;
  }

  apply(e, side) {
    if (e.kind === 'replace') {
      this.load(e[side]);
      this.emit({ cells: true, objects: true, meta: true, resized: true });
      return;
    }
    if (e.cells) {
      const { idx } = e.cells;
      const t = side === 'before' ? e.cells.tb : e.cells.ta;
      const o = side === 'before' ? e.cells.ob : e.cells.oa;
      for (let k = 0; k < idx.length; k++) {
        this.terrain[idx[k]] = t[k];
        this.ore[idx[k]] = o[k];
      }
    }
    if (e.objects) {
      const s = clone(e.objects[side]);
      this.spawns = s.spawns;
      this.actors = s.actors;
    }
    if (e.meta) {
      const s = clone(e.meta[side]);
      this.meta = s.meta;
      this.rules = s.rules;
    }
    this.emit({ cells: !!e.cells, objects: !!e.objects, meta: !!e.meta, resized: false });
  }

  // ---- Spawns ----------------------------------------------------------------------

  /**
   * Remove spawn `k`. Actors it owned become neutral and higher owner indices
   * shift down, so ownership stays attached to the same spawns.
   */
  removeSpawn(k) {
    this.touchObjects();
    this.spawns.splice(k, 1);
    for (const a of this.actors) {
      if (a.owner === k) a.owner = -1;
      else if (a.owner > k) a.owner--;
    }
  }
}
