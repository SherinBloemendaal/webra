// Tool interaction (pointer gestures turned into document transactions) and the
// per-frame scene the editor draws over the engine's picture of the map:
// spawns, placement and paste ghosts, the grid, the region, selections, the
// layers (passability, zones, rush paths) and the cursor.

import { TEAM_COLORS } from '../../js/renderer.js';
import { TERRAIN, catalogEntry } from './mapformat.js';
import {
  Occupancy,
  actorAt,
  actorCells,
  actorSize,
  actorsInRect,
  addSpawns,
  autoShore,
  brushCells,
  clampSpawn,
  clearRegion,
  copyRegion,
  deleteActors,
  ellipseCells,
  erase,
  fill,
  lineCells,
  paintGems,
  paintOre,
  paintTerrain,
  pasteRegion,
  placeActor,
  placementProblem,
  rectCells,
  spawnAt,
  spawnPartners,
  thickLineCells,
} from './edits.js';
import { SPAWN_H, SPAWN_W, applyTransform, mirroredOwner, symmetricPositions, transformFacing, transformsFor } from './symmetry.js';
import { TOOLS } from './commands.js';
import { CELL, NEUTRAL_TEAM } from './view.js';

export { TOOLS };

const ROTATE_STEP = 32;

/** Team slot of a document owner: spawn k is player k, neutral the preview's neutral player. */
export const teamOf = (owner) => (owner >= 0 ? Math.min(owner, 7) : NEUTRAL_TEAM);

/** Radians (clockwise, the renderer's) of a facing in OpenRA angle units (1024 a turn). */
export const facingRadians = (facing) => (facing * Math.PI * 2) / 1024;

/** Engine editor_cells flags (engine/src/editor.rs). */
export const CELL_FLAGS = Object.freeze({ PASSABLE: 1, BUILDABLE: 2, REACHABLE: 4, RUSH: 8 });

const box = (g) => ({ x0: Math.min(g.x0, g.x1), y0: Math.min(g.y0, g.y1), x1: Math.max(g.x0, g.x1), y1: Math.max(g.y0, g.y1) });

export class Controller {
  constructor(doc, view, catalog, state, hooks) {
    this.doc = doc;
    this.view = view;
    this.catalog = catalog; // { id: rules_json actor }
    this.order = new Map(Object.values(catalog).map((a, i) => [a.id, i]));
    // Per actor index: non-zero when a building has an animated layer in its second
    // sprite slot (js/sprites.js buildAtlas `overlays`); the editor shows its still frame.
    this.overlays = new Uint32Array(0);
    this.state = state;
    // { status(text), hover(cell), selectionChanged(), picked(what), regionChanged() }
    this.hooks = hooks;
    this.gesture = null;
    this.selection = new Set();
    this.selectedSpawn = -1;
    /** Engine overlay cells (Game.editor_cells) for the layers, or null. */
    this.analysis = null;
    /** Who stands where (edits.js Occupancy) for doc version `occupancyVersion`. */
    this.occupancyCache = null;
    this.occupancyVersion = -1;
    /** The structures the game would refuse where they stand, for doc version `refusedVersion`. */
    this.refused = [];
    this.refusedVersion = -1;
    /** The shape preview's rects while its corners, tool settings and the map stay the same. */
    this.shapePreview = null;
    doc.onChange(() => {
      // Undo/redo swap in fresh objects; drop selections that no longer exist.
      for (const a of this.selection) if (!doc.actors.includes(a)) this.selection.delete(a);
      if (this.selectedSpawn >= doc.spawns.length) this.selectedSpawn = -1;
      const r = this.state.region;
      if (r && (r.x1 >= doc.width || r.y1 >= doc.height)) this.setRegion(null);
    });
  }

  info(type) {
    return catalogEntry(this.catalog, type);
  }

  /**
   * Who stands where now, for placement checks (edits.js Occupancy). Kept
   * while the document's version stays the same; inside a transaction (a
   * gesture changing the map as it goes) made afresh each time.
   */
  occupancy() {
    const doc = this.doc;
    if (doc.inTransaction) return new Occupancy(doc, this.catalog);
    if (this.occupancyVersion !== doc.version) {
      this.occupancyCache = new Occupancy(doc, this.catalog);
      this.occupancyVersion = doc.version;
    }
    return this.occupancyCache;
  }

  /**
   * The structures a game would refuse where they stand (no room, wrong
   * ground): `[actor, info]`. Found once per document version (each check
   * against an index of who stands where, not against every actor).
   */
  refusedStructures() {
    const doc = this.doc;
    if (!doc.inTransaction && this.refusedVersion === doc.version) return this.refused;
    const occupancy = this.occupancy();
    const out = [];
    for (const a of doc.actors) {
      const info = this.info(a.type);
      if (info?.kind !== 'building') continue;
      if (occupancy.problem(a.type, a.x, a.y, a)) out.push([a, info]);
    }
    if (!doc.inTransaction) {
      this.refused = out;
      this.refusedVersion = doc.version;
    }
    return out;
  }

  setRegion(r) {
    this.state.region = r;
    this.hooks.regionChanged?.();
  }

  // ---- Pointer gestures ------------------------------------------------------------

  down(cell, e) {
    if (this.gesture) return;
    const doc = this.doc;
    const s = this.state;
    const right = e.button === 2;
    const { x, y } = cell;
    switch (s.tool) {
      case 'brush':
      case 'eraser': {
        doc.begin(s.tool === 'eraser' ? 'Erase' : `Paint ${this.paintName(right)}`);
        this.gesture = { kind: 'stroke', right, last: [x, y], painted: [] };
        this.stroke([[x, y]], right);
        break;
      }
      case 'line':
      case 'rect':
      case 'ellipse':
        this.gesture = { kind: 'shape', shape: s.tool, right, x0: x, y0: y, x1: x, y1: y };
        break;
      case 'fill':
        if (!doc.inside(x, y)) return;
        doc.begin('Fill');
        if (s.paint === 'terrain') fill(doc, x, y, right ? TERRAIN.CLEAR : s.material, s.symmetry);
        else this.paintCells(this.fillCells(x, y), right);
        doc.commit();
        break;
      case 'eyedropper':
        this.pick(x, y);
        break;
      case 'spawn': {
        const k = spawnAt(doc, x, y);
        if (right) {
          if (k >= 0) {
            doc.begin('Remove spawn');
            doc.removeSpawn(k);
            doc.commit();
            this.selectedSpawn = -1;
          }
          return;
        }
        if (k >= 0) {
          this.startSpawnDrag(k, x, y);
        } else if (doc.inside(x, y)) {
          doc.begin('Add spawn');
          const added = addSpawns(doc, x - 1, y - 2, s.symmetry);
          doc.commit();
          if (!added.length) this.hooks.status(`A map has at most 8 spawns.`);
          else this.selectedSpawn = added[0];
        }
        break;
      }
      case 'actor': {
        if (right) {
          const a = actorAt(doc, this.catalog, x, y);
          if (a) {
            doc.begin('Delete actor');
            deleteActors(doc, [a]);
            doc.commit();
          }
          return;
        }
        if (!s.actorType) {
          this.hooks.status('Pick an actor in the Actors tab first.');
          return;
        }
        doc.begin(`Place ${this.info(s.actorType)?.name ?? s.actorType}`);
        this.gesture = { kind: 'place', last: null };
        this.placeAt(x, y);
        break;
      }
      case 'select':
        this.selectDown(x, y, e);
        break;
      case 'region': {
        const r = s.region;
        if (!right && r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
          // Drag the region's contents to a new place.
          doc.begin('Move region');
          const clip = copyRegion(doc, this.catalog, r.x0, r.y0, r.x1, r.y1);
          clearRegion(doc, this.catalog, r.x0, r.y0, r.x1, r.y1);
          this.gesture = { kind: 'moveRegion', clip, x0: x, y0: y, dx: 0, dy: 0, from: r };
          return;
        }
        if (right) {
          this.setRegion(null);
          return;
        }
        this.gesture = { kind: 'region', x0: x, y0: y, x1: x, y1: y };
        break;
      }
      case 'paste': {
        if (right || !s.clip) {
          this.hooks.status(s.clip ? 'Paste cancelled.' : 'Copy a region or pick a stamp first.');
          this.hooks.endPaste?.();
          return;
        }
        const [px, py] = this.pasteAnchor(x, y);
        doc.begin('Paste');
        const r = pasteRegion(doc, this.catalog, s.clip, px, py, s.symmetry, s.pasteLayers);
        doc.commit();
        if (r.skipped) this.hooks.status(`Pasted; ${r.skipped} actor${r.skipped === 1 ? '' : 's'} did not fit and were left out.`);
        break;
      }
    }
  }

  move(cell) {
    const g = this.gesture;
    const { x, y } = cell;
    this.hooks.hover(cell);
    if (!g) return;
    if (g.kind === 'stroke') {
      if (g.last[0] === x && g.last[1] === y) return;
      this.stroke(lineCells(g.last[0], g.last[1], x, y).slice(1), g.right);
      g.last = [x, y];
    } else if (g.kind === 'shape' || g.kind === 'box' || g.kind === 'region') {
      g.x1 = x;
      g.y1 = y;
    } else if (g.kind === 'place') {
      this.placeAt(x, y);
    } else if (g.kind === 'spawn') {
      this.dragSpawn(x, y);
    } else if (g.kind === 'move') {
      this.dragActors(x, y);
    } else if (g.kind === 'moveRegion') {
      g.dx = x - g.x0;
      g.dy = y - g.y0;
    }
  }

  up(cell) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    const doc = this.doc;
    if (g.kind === 'shape') {
      const cells = this.shapeCells(g.shape, g.x0, g.y0, cell.x, cell.y);
      doc.begin(`${g.shape === 'line' ? 'Line' : g.shape === 'rect' ? 'Rectangle' : 'Ellipse'} of ${this.paintName(g.right)}`);
      this.paintCells(cells, g.right);
      doc.commit();
    } else if (g.kind === 'box') {
      const hits = actorsInRect(doc, this.catalog, g.x0, g.y0, g.x1, g.y1);
      if (!g.add) this.selection.clear();
      for (const a of hits) this.selection.add(a);
      this.hooks.selectionChanged();
    } else if (g.kind === 'region') {
      const r = box(g);
      const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
      this.setRegion({ x0: clamp(r.x0, doc.width), y0: clamp(r.y0, doc.height), x1: clamp(r.x1, doc.width), y1: clamp(r.y1, doc.height) });
    } else if (g.kind === 'moveRegion') {
      const nx = g.from.x0 + g.dx;
      const ny = g.from.y0 + g.dy;
      const r = pasteRegion(doc, this.catalog, g.clip, nx, ny, 'none');
      doc.commit();
      const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
      this.setRegion({ x0: clamp(nx, doc.width), y0: clamp(ny, doc.height), x1: clamp(nx + g.clip.w - 1, doc.width), y1: clamp(ny + g.clip.h - 1, doc.height) });
      if (r.skipped) this.hooks.status(`${r.skipped} actor${r.skipped === 1 ? '' : 's'} did not fit there and were left out.`);
    } else {
      doc.commit();
    }
  }

  leave() {
    this.hooks.hover(null);
  }

  /** Abort the gesture in progress (Escape). */
  cancel() {
    if (!this.gesture) return false;
    if (this.doc.inTransaction) this.doc.rollback();
    this.gesture = null;
    return true;
  }

  // ---- Painting ---------------------------------------------------------------------

  /** What the paint tools put down now (or take away with the right button). */
  paintName(right) {
    const s = this.state;
    if (s.paint === 'ore') return right ? 'no ore' : 'ore';
    if (s.paint === 'gems') return right ? 'no gems' : 'gems';
    return right ? 'clear ground' : 'terrain';
  }

  /** Paint `cells` with the paint layer (and their symmetric copies); shores follow painted water. */
  paintCells(cells, right) {
    const s = this.state;
    const doc = this.doc;
    if (s.paint === 'ore') paintOre(doc, cells, right ? 0 : s.ore, s.symmetry);
    else if (s.paint === 'gems') paintGems(doc, cells, right ? 0 : s.gems, s.symmetry);
    else {
      const material = right ? TERRAIN.CLEAR : s.material;
      paintTerrain(doc, cells, material, s.symmetry);
      if (s.autoShore && material === TERRAIN.WATER) autoShore(doc, cells, s.symmetry);
    }
  }

  stroke(cells, right) {
    const s = this.state;
    const area = [];
    for (const [cx, cy] of cells) area.push(...brushCells(cx, cy, s.size));
    if (s.tool === 'eraser') erase(this.doc, area, s.symmetry, this.catalog);
    else this.paintCells(area, right);
  }

  shapeCells(shape, x0, y0, x1, y1) {
    const s = this.state;
    if (shape === 'line') return thickLineCells(x0, y0, x1, y1, s.size);
    if (shape === 'rect') return rectCells(x0, y0, x1, y1, s.shapeFill);
    return ellipseCells(x0, y0, x1, y1, s.shapeFill);
  }

  /** The connected cells of the same terrain at (x, y), for a resource fill. */
  fillCells(x, y) {
    const doc = this.doc;
    const from = doc.terrain[doc.idx(x, y)];
    const seen = new Uint8Array(doc.width * doc.height);
    const out = [];
    const stack = [doc.idx(x, y)];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % doc.width;
      const cy = (i - cx) / doc.width;
      out.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!doc.inside(cx + dx, cy + dy)) continue;
        const j = doc.idx(cx + dx, cy + dy);
        if (!seen[j] && doc.terrain[j] === from) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    return out;
  }

  /** Eyedropper: the actor under the cursor, else ore or gems, else the terrain. */
  pick(x, y) {
    const doc = this.doc;
    if (!doc.inside(x, y)) return;
    const a = actorAt(doc, this.catalog, x, y);
    const s = this.state;
    if (a) {
      s.actorType = this.info(a.type)?.id ?? a.type;
      s.owner = a.owner;
      s.facing = a.facing ?? 0;
      this.hooks.picked?.({ kind: 'actor', actor: a });
      return;
    }
    const i = doc.idx(x, y);
    if (doc.ore[i] > 0) {
      s.ore = doc.ore[i];
      s.paint = 'ore';
      this.hooks.picked?.({ kind: 'ore', density: doc.ore[i] });
    } else if (doc.gems[i] > 0) {
      s.gems = doc.gems[i];
      s.paint = 'gems';
      this.hooks.picked?.({ kind: 'gems', density: doc.gems[i] });
    } else {
      s.material = doc.terrain[i];
      s.paint = 'terrain';
      this.hooks.picked?.({ kind: 'terrain', terrain: doc.terrain[i] });
    }
  }

  // ---- Actors and spawns ----------------------------------------------------------------

  /** Top-left cell for an actor placed with the cursor at (x, y): buildings centre on the cursor. */
  anchor(type, x, y) {
    const [fw, fh] = actorSize(this.info(type));
    return [x - Math.floor((fw - 1) / 2), y - Math.floor((fh - 1) / 2)];
  }

  /** Top-left cell of the clipboard pasted with the cursor at (x, y): centred on the cursor. */
  pasteAnchor(x, y) {
    const c = this.state.clip;
    return [x - Math.floor((c.w - 1) / 2), y - Math.floor((c.h - 1) / 2)];
  }

  placeAt(x, y) {
    const s = this.state;
    const [ax, ay] = this.anchor(s.actorType, x, y);
    const g = this.gesture;
    if (g.last && g.last[0] === ax && g.last[1] === ay) return;
    g.last = [ax, ay];
    const problem = placementProblem(this.doc, this.catalog, s.actorType, ax, ay);
    if (problem) {
      this.hooks.status(`Cannot place ${this.info(s.actorType)?.name ?? s.actorType} here: ${problem}.`);
      return;
    }
    placeActor(this.doc, this.catalog, { type: s.actorType, owner: s.owner, x: ax, y: ay, facing: s.facing }, s.symmetry);
  }

  startSpawnDrag(k, x, y) {
    const doc = this.doc;
    doc.begin('Move spawn');
    doc.touchObjects();
    this.selectedSpawn = k;
    const [sx, sy] = doc.spawns[k];
    this.gesture = { kind: 'spawn', k, dx: x - sx, dy: y - sy, partners: spawnPartners(doc, k, this.state.symmetry) };
    this.hooks.selectionChanged();
  }

  dragSpawn(x, y) {
    const g = this.gesture;
    const doc = this.doc;
    const [nx, ny] = clampSpawn(doc, x - g.dx, y - g.dy);
    doc.spawns[g.k] = [nx, ny];
    for (const p of g.partners) {
      doc.spawns[p.k] = clampSpawn(doc, ...applyTransform(p.t, nx, ny, doc.width, doc.height, SPAWN_W, SPAWN_H));
    }
  }

  selectDown(x, y, e) {
    const doc = this.doc;
    const a = actorAt(doc, this.catalog, x, y);
    if (a) {
      if (e.shiftKey) {
        if (this.selection.has(a)) this.selection.delete(a);
        else this.selection.add(a);
      } else if (!this.selection.has(a)) {
        this.selection.clear();
        this.selection.add(a);
      }
      this.selectedSpawn = -1;
      this.hooks.selectionChanged();
      if (!this.selection.has(a)) return;
      doc.begin('Move actors');
      doc.touchObjects();
      this.gesture = { kind: 'move', x0: x, y0: y, origin: new Map([...this.selection].map((s) => [s, [s.x, s.y]])), dx: 0, dy: 0 };
      return;
    }
    const k = spawnAt(doc, x, y);
    if (k >= 0) {
      this.selection.clear();
      this.startSpawnDrag(k, x, y);
      return;
    }
    this.selectedSpawn = -1;
    this.gesture = { kind: 'box', add: e.shiftKey, x0: x, y0: y, x1: x, y1: y };
    this.hooks.selectionChanged();
  }

  dragActors(x, y) {
    const g = this.gesture;
    const dx = x - g.x0;
    const dy = y - g.y0;
    if (dx === g.dx && dy === g.dy) return;
    const others = new Occupancy(this.doc, this.catalog, this.selection);
    const ok = [...g.origin].every(([a, [ox, oy]]) => !others.problem(a.type, ox + dx, oy + dy));
    if (!ok) return;
    for (const [a, [ox, oy]] of g.origin) {
      a.x = ox + dx;
      a.y = oy + dy;
    }
    g.dx = dx;
    g.dy = dy;
  }

  // ---- Commands -------------------------------------------------------------------------

  /** Delete the selected actors, the selected spawn, or clear the region. */
  deleteSelection() {
    const doc = this.doc;
    if (this.selection.size) {
      doc.begin('Delete actors');
      deleteActors(doc, [...this.selection]);
      doc.commit();
      this.selection.clear();
      this.hooks.selectionChanged();
      return true;
    }
    if (this.selectedSpawn >= 0) {
      doc.begin('Remove spawn');
      doc.removeSpawn(this.selectedSpawn);
      doc.commit();
      this.selectedSpawn = -1;
      this.hooks.selectionChanged();
      return true;
    }
    const r = this.state.region;
    if (r) {
      doc.begin('Clear region');
      clearRegion(doc, this.catalog, r.x0, r.y0, r.x1, r.y1);
      doc.commit();
      return true;
    }
    return false;
  }

  /** Turn the placement facing, and the selected units with it. */
  rotate(dir) {
    const s = this.state;
    s.facing = (s.facing + dir * ROTATE_STEP + 1024) % 1024;
    const units = [...this.selection].filter((a) => this.info(a.type)?.kind !== 'building');
    if (units.length) {
      this.doc.begin('Turn');
      this.doc.touchObjects();
      for (const a of units) a.facing = (a.facing + dir * ROTATE_STEP + 1024) % 1024;
      this.doc.commit();
    }
  }

  /** Change a property of every selected actor (owner, facing) as one step. */
  setOnSelection(label, fn) {
    if (!this.selection.size) return;
    // Dragging a slider makes one undo step (coalesced by label).
    this.doc.begin(label, `selection.${label}`);
    this.doc.touchObjects();
    for (const a of this.selection) fn(a, this.info(a.type));
    this.doc.commit();
  }

  setOwnerOfSelection(owner) {
    this.setOnSelection('Change owner', (a) => (a.owner = owner));
  }

  selectAll() {
    for (const a of this.doc.actors) this.selection.add(a);
    this.hooks.selectionChanged();
  }

  // ---- Scene ------------------------------------------------------------------------------

  /**
   * A ghost of actor type `info` (placement previews, spawns, refused
   * structures): its body in the idle pose (pose 0, so the sprite id is the
   * slot for WebRA and installed art alike) and, for a turret or an animated
   * layer, the second slot on top.
   */
  ghost(sprite, info, x, y, angle, team, alpha) {
    const t = info ? this.order.get(info.id) : undefined;
    if (t === undefined) return;
    sprite(x, y, angle, t * 2, team, alpha);
    if (info.turret || this.overlays[t]) sprite(x, y, angle, t * 2 + 1, team, alpha);
  }

  /** Sprites and rects for this frame, plus HTML labels for spawn numbers. */
  scene() {
    const doc = this.doc;
    const s = this.state;
    const layers = s.layers;
    const zoom = this.view.camera.zoom;
    const th = Math.max(1, 1.5 / zoom);
    const v = this.view.viewRect();
    const sprites = [];
    const rects = [];
    const labels = [];
    const sprite = (x, y, angle, id, team, alpha) => sprites.push(x, y, angle, id, team, 1, alpha, 0);
    const rect = (x, y, w, h, c) => rects.push(x, y, w, h, c[0], c[1], c[2], c[3]);
    const outline = (x, y, w, h, c, t = th) => {
      rect(x, y, w, t, c);
      rect(x, y + h - t, w, t, c);
      rect(x, y + t, t, h - 2 * t, c);
      rect(x + w - t, y + t, t, h - 2 * t, c);
    };
    const team = teamOf;
    const visible = (x, y, m) => x >= v.x0 - m && x <= v.x1 + m && y >= v.y0 - m && y <= v.y1 + m;
    const cx0 = Math.max(0, Math.floor(v.x0 / CELL));
    const cy0 = Math.max(0, Math.floor(v.y0 / CELL));
    const cx1 = Math.min(doc.width - 1, Math.floor(v.x1 / CELL));
    const cy1 = Math.min(doc.height - 1, Math.floor(v.y1 / CELL));

    this.layerScene(rect, outline, cx0, cy0, cx1, cy1);

    // Spawns: a faint construction yard in the player's colour.
    if (layers.spawns !== false) {
      doc.spawns.forEach(([sx, sy], k) => {
        const cx = (sx + SPAWN_W / 2) * CELL;
        const cy = (sy + SPAWN_H / 2) * CELL;
        this.ghost(sprite, this.catalog.FACT, cx, cy, 0, team(k), 0.45);
        const col = TEAM_COLORS[team(k)];
        outline(sx * CELL, sy * CELL, SPAWN_W * CELL, SPAWN_H * CELL, [col[0], col[1], col[2], 0.95], th * 1.5);
        labels.push({ text: String(k + 1), x: cx, y: cy, team: team(k), selected: k === this.selectedSpawn });
        if (k === this.selectedSpawn) outline(sx * CELL - 3, sy * CELL - 3, SPAWN_W * CELL + 6, SPAWN_H * CELL + 6, [1, 1, 1, 0.9]);
      });
    }

    // The actors themselves come from the engine preview (js/world.js). A
    // structure the game would refuse there (no room, wrong ground) is not
    // in it: shown here as a red ghost, so it can be found and moved.
    if (layers.actors !== false) {
      for (const [a, info] of this.refusedStructures()) {
        const [fw, fh] = actorSize(info);
        const x = (a.x + fw / 2) * CELL;
        const y = (a.y + fh / 2) * CELL;
        if (!visible(x, y, 96)) continue;
        this.ghost(sprite, info, x, y, 0, team(a.owner), 0.5);
        outline(a.x * CELL, a.y * CELL, fw * CELL, fh * CELL, [0.95, 0.25, 0.2, 0.9]);
      }
    }

    // Grid
    if (layers.grid) {
      const step = zoom * CELL >= 8 ? 1 : zoom * CELL >= 2 ? 8 : 16;
      const gx0 = Math.max(0, Math.floor(v.x0 / CELL / step) * step);
      const gx1 = Math.min(doc.width, Math.ceil(v.x1 / CELL));
      const gy0 = Math.max(0, Math.floor(v.y0 / CELL / step) * step);
      const gy1 = Math.min(doc.height, Math.ceil(v.y1 / CELL));
      const t = Math.max(0.5, 1 / zoom);
      const fine = [0, 0, 0, 0.22];
      const major = [0, 0, 0, 0.42];
      for (let gx = gx0; gx <= gx1; gx += step) rect(gx * CELL - t / 2, 0, t, doc.height * CELL, gx % 8 === 0 ? major : fine);
      for (let gy = gy0; gy <= gy1; gy += step) rect(0, gy * CELL - t / 2, doc.width * CELL, t, gy % 8 === 0 ? major : fine);
    }
    // Map border
    outline(-2 * th, -2 * th, doc.width * CELL + 4 * th, doc.height * CELL + 4 * th, [0.85, 0.7, 0.25, 0.9], th);

    // Selection
    for (const a of this.selection) {
      const info = this.info(a.type);
      const [fw, fh] = actorSize(info);
      outline(a.x * CELL - 1, a.y * CELL - 1, fw * CELL + 2, fh * CELL + 2, [1, 1, 1, 0.95]);
    }

    // The region: a marching outline (white and dark dashes).
    const r = this.gesture?.kind === 'region' ? box(this.gesture) : s.region;
    if (r && this.gesture?.kind !== 'moveRegion') this.regionOutline(rect, r, th);

    this.cursorScene(rect, outline, sprite);
    return { sprites, rects, labels };
  }

  /** The analysis layers over the visible cells. */
  layerScene(rect, outline, cx0, cy0, cx1, cy1) {
    const doc = this.doc;
    const L = this.state.layers;
    const a = this.analysis;
    const cellsOk = a && a.length === doc.width * doc.height;
    // Nothing to draw per cell: no need to visit them (the whole map when zoomed out).
    if (!L.resources && !(cellsOk && (L.zones || L.passability || L.buildable || L.reach || L.rush))) return;
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const i = y * doc.width + x;
        if (cellsOk) {
          const f = a[i];
          if (L.zones && f >> 8 !== 255) {
            const c = TEAM_COLORS[teamOf(f >> 8)];
            rect(x * CELL, y * CELL, CELL, CELL, [c[0], c[1], c[2], 0.28]);
          }
          if (L.passability && !(f & CELL_FLAGS.PASSABLE)) rect(x * CELL, y * CELL, CELL, CELL, [0.9, 0.15, 0.1, 0.38]);
          if (L.buildable && f & CELL_FLAGS.BUILDABLE) rect(x * CELL, y * CELL, CELL, CELL, [0.2, 0.85, 0.3, 0.25]);
          if (L.reach && f & CELL_FLAGS.PASSABLE && !(f & CELL_FLAGS.REACHABLE)) rect(x * CELL, y * CELL, CELL, CELL, [0, 0, 0, 0.55]);
          if (L.rush && f & CELL_FLAGS.RUSH) rect(x * CELL + CELL * 0.3, y * CELL + CELL * 0.3, CELL * 0.4, CELL * 0.4, [1, 0.85, 0.2, 0.9]);
        }
        if (L.resources && (doc.ore[i] || doc.gems[i])) {
          const c = doc.gems[i] ? [0.85, 0.35, 0.85, 0.9] : [1, 0.8, 0.2, 0.9];
          outline(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, c, 1);
        }
      }
    }
  }

  regionOutline(rect, r, th) {
    const x = r.x0 * CELL;
    const y = r.y0 * CELL;
    const w = (r.x1 - r.x0 + 1) * CELL;
    const h = (r.y1 - r.y0 + 1) * CELL;
    rect(x, y, w, h, [0.4, 0.7, 1, 0.12]);
    const dash = 8;
    const t = th * 1.5;
    for (let d = 0; d < w; d += dash) {
      const c = (d / dash) % 2 ? [0.05, 0.05, 0.05, 0.9] : [1, 1, 1, 0.95];
      const len = Math.min(dash, w - d);
      rect(x + d, y, len, t, c);
      rect(x + d, y + h - t, len, t, c);
    }
    for (let d = 0; d < h; d += dash) {
      const c = (d / dash) % 2 ? [0.05, 0.05, 0.05, 0.9] : [1, 1, 1, 0.95];
      const len = Math.min(dash, h - d);
      rect(x, y + d, t, len, c);
      rect(x + w - t, y + d, t, len, c);
    }
  }

  /** Brush, shape, region, paste and placement previews under the cursor. */
  cursorScene(rect, outline, sprite) {
    const doc = this.doc;
    const s = this.state;
    const g = this.gesture;
    const h = this.view.hover;
    const sym = (x, y, w = 1, hh = 1) => symmetricPositions(s.symmetry, x, y, doc.width, doc.height, w, hh);
    const paintColor = s.paint === 'ore' ? [0.95, 0.75, 0.2, 0.35] : s.paint === 'gems' ? [0.85, 0.3, 0.7, 0.35] : [1, 1, 1, 0.22];
    const cellsAt = (cells, c) => {
      // Each painted cell at its symmetric positions.
      const seen = new Set();
      cells.forEach(([cx, cy]) => {
        sym(cx, cy).forEach((p, n) => {
          const key = p.y * doc.width + p.x;
          if (!doc.inside(p.x, p.y) || seen.has(key)) return;
          seen.add(key);
          rect(p.x * CELL, p.y * CELL, CELL, CELL, n === 0 ? c : [c[0], c[1], c[2], c[3] * 0.55]);
        });
      });
    };
    if (g?.kind === 'shape') {
      const runs = this.shapeRects(g, g.right ? [1, 0.35, 0.3, 0.35] : paintColor);
      for (let k = 0; k < runs.length; k += 8) rect(runs[k], runs[k + 1], runs[k + 2], runs[k + 3], runs.subarray(k + 4, k + 8));
      return;
    }
    if (g?.kind === 'box') {
      const b = box(g);
      rect(b.x0 * CELL, b.y0 * CELL, (b.x1 - b.x0 + 1) * CELL, (b.y1 - b.y0 + 1) * CELL, [1, 1, 1, 0.08]);
      outline(b.x0 * CELL, b.y0 * CELL, (b.x1 - b.x0 + 1) * CELL, (b.y1 - b.y0 + 1) * CELL, [1, 1, 1, 0.9]);
      return;
    }
    if (g?.kind === 'moveRegion') {
      this.clipScene(rect, outline, sprite, g.clip, g.from.x0 + g.dx, g.from.y0 + g.dy, false);
      return;
    }
    if (!h) return;
    const { x, y } = h;
    if (s.tool === 'brush' || s.tool === 'eraser' || (s.tool === 'line' && !g)) {
      cellsAt(brushCells(x, y, s.size), s.tool === 'eraser' ? [1, 0.35, 0.3, 0.35] : paintColor);
    } else if (s.tool === 'fill' || s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'eyedropper') {
      for (const p of sym(x, y)) outline(p.x * CELL, p.y * CELL, CELL, CELL, [1, 1, 1, 0.8]);
    } else if (s.tool === 'spawn') {
      const k = spawnAt(doc, x, y);
      if (k < 0) {
        const [sx, sy] = clampSpawn(doc, x - 1, y - 2);
        for (const p of sym(sx, sy, SPAWN_W, SPAWN_H)) outline(p.x * CELL, p.y * CELL, SPAWN_W * CELL, SPAWN_H * CELL, [1, 1, 1, 0.6]);
      }
    } else if (s.tool === 'paste' && s.clip && !g) {
      const [px, py] = this.pasteAnchor(x, y);
      for (const p of sym(px, py, s.clip.w, s.clip.h)) {
        this.clipScene(rect, outline, sprite, s.clip, p.x, p.y, p.t.fx || p.t.fy || p.t.swap);
      }
    } else if (s.tool === 'actor' && s.actorType && !g) {
      const info = this.info(s.actorType);
      if (!info) return;
      const [ax, ay] = this.anchor(s.actorType, x, y);
      const [fw, fh] = actorSize(info);
      const occupancy = this.occupancy();
      for (const p of sym(ax, ay, fw, fh)) {
        const bad = occupancy.problem(s.actorType, p.x, p.y);
        for (const [cx, cy, c] of actorCells({ type: s.actorType, x: p.x, y: p.y }, this.catalog)) {
          const col = bad ? [0.9, 0.2, 0.15, 0.4] : c === 2 ? [0.3, 0.8, 0.35, 0.18] : [0.3, 0.85, 0.35, 0.35];
          rect(cx * CELL, cy * CELL, CELL, CELL, col);
        }
        const building = info.kind === 'building';
        const px = building ? (p.x + fw / 2) * CELL : (p.x + 0.5) * CELL;
        const py = building ? (p.y + fh / 2) * CELL : (p.y + 0.5) * CELL;
        const angle = building ? 0 : facingRadians(transformFacing(p.t, s.facing));
        const o = mirroredOwner(p.t, s.owner, doc.spawns, doc.width, doc.height);
        this.ghost(sprite, info, px, py, angle, teamOf(o), 0.6);
      }
    }
  }

  /**
   * Rect floats of the shape being dragged: its cells at their symmetric
   * positions (the copies fainter), drawn as runs of cells along each row
   * (the same pixels as a rect per cell). Made again only when the corners,
   * the tool settings or the map size change, not every frame.
   */
  shapeRects(g, c) {
    const s = this.state;
    const doc = this.doc;
    const key = [g.shape, g.x0, g.y0, g.x1, g.y1, s.size, s.shapeFill, s.symmetry, doc.width, doc.height, ...c].join(',');
    if (this.shapePreview?.key === key) return this.shapePreview.rects;
    // Each painted cell at its symmetric positions; the first position to reach a cell gives its colour.
    const shade = new Map();
    const transforms = transformsFor(s.symmetry, doc.width, doc.height);
    const seen = [];
    for (const [cx, cy] of this.shapeCells(g.shape, g.x0, g.y0, g.x1, g.y1)) {
      // As symmetricPositions: a position a later transform repeats counts once, as the earliest.
      seen.length = 0;
      for (const t of transforms) {
        const [px, py] = applyTransform(t, cx, cy, doc.width, doc.height);
        let repeated = false;
        for (let k = 0; k < seen.length; k += 2) if (seen[k] === px && seen[k + 1] === py) repeated = true;
        if (repeated) continue;
        seen.push(px, py);
        const at = py * doc.width + px;
        if (!doc.inside(px, py) || shade.has(at)) continue;
        shade.set(at, seen.length === 2 ? 0 : 1);
      }
    }
    const colors = [c, [c[0], c[1], c[2], c[3] * 0.55]];
    const cells = Float64Array.from(shade.keys()).sort();
    const rects = [];
    for (let k = 0; k < cells.length; ) {
      const start = cells[k];
      const shadeOf = shade.get(start);
      const x = start % doc.width;
      const y = (start - x) / doc.width;
      let n = 1;
      while (k + n < cells.length && cells[k + n] === start + n && x + n < doc.width && shade.get(start + n) === shadeOf) n++;
      const col = colors[shadeOf];
      rects.push(x * CELL, y * CELL, n * CELL, CELL, col[0], col[1], col[2], col[3]);
      k += n;
    }
    this.shapePreview = { key, rects: Float32Array.from(rects) };
    return this.shapePreview.rects;
  }

  /**
   * A clipboard region at (x, y): its box, the cells it changes tinted, its
   * actors as ghosts. Mirrored copies show the box only (they are mirrored
   * when pasted).
   */
  clipScene(rect, outline, sprite, clip, x, y, mirrored) {
    outline(x * CELL, y * CELL, clip.w * CELL, clip.h * CELL, [0.4, 0.75, 1, 0.95]);
    rect(x * CELL, y * CELL, clip.w * CELL, clip.h * CELL, [0.4, 0.75, 1, 0.1]);
    if (mirrored) return;
    for (const a of clip.actors) {
      const info = this.info(a.type);
      if (!info) continue;
      const [fw, fh] = actorSize(info);
      const building = info.kind === 'building';
      const px = (x + a.dx + (building ? fw / 2 : 0.5)) * CELL;
      const py = (y + a.dy + (building ? fh / 2 : 0.5)) * CELL;
      this.ghost(sprite, info, px, py, building ? 0 : facingRadians(a.facing), teamOf(a.owner), 0.6);
    }
  }
}
