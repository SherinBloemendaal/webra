// Tool interaction (pointer gestures turned into document transactions) and the
// per-frame scene: actor sprites, spawns, grid, cursor and selection overlays.

import { TEAM_COLORS } from '../../js/renderer.js';
import { TERRAIN, catalogEntry } from './mapformat.js';
import {
  actorAt,
  actorCells,
  actorSize,
  actorsInRect,
  addSpawns,
  brushCells,
  clampSpawn,
  deleteActors,
  erase,
  fill,
  fillRect,
  lineCells,
  paintGems,
  paintOre,
  paintTerrain,
  placeActor,
  placementProblem,
  spawnAt,
  spawnPartners,
} from './edits.js';
import { SPAWN_H, SPAWN_W, applyTransform, mirroredOwner, symmetricPositions, transformFacing } from './symmetry.js';
import { CELL, NEUTRAL_TEAM } from './view.js';

export const TOOLS = [
  { id: 'brush', key: 'B', label: 'Terrain brush', hint: 'Paint terrain. Right drag paints clear ground.' },
  { id: 'fill', key: 'F', label: 'Fill bucket', hint: 'Fill a connected area of one terrain type.' },
  { id: 'rect', key: 'R', label: 'Rectangle', hint: 'Drag a rectangle of terrain. Right drag clears.' },
  { id: 'ore', key: 'O', label: 'Ore brush', hint: 'Paint ore on clear or rough ground. Right drag removes ore.' },
  { id: 'gems', key: 'C', label: 'Gem brush', hint: 'Paint gems (crystals, worth twice as much as ore) on clear or rough ground. Right drag removes gems.' },
  { id: 'eraser', key: 'E', label: 'Eraser', hint: 'Back to clear ground: removes ore, gems and actors.' },
  { id: 'spawn', key: 'S', label: 'Spawns', hint: 'Click to add a spawn, drag to move, right click to remove.' },
  { id: 'actor', key: 'A', label: 'Place actor', hint: 'Place the palette actor. Right click deletes. , and . rotate.' },
  { id: 'select', key: 'V', label: 'Select', hint: 'Click or box-select actors, drag to move, Delete removes.' },
];

const ROTATE_STEP = 32;

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
    this.hooks = hooks; // { status(text), changed() }
    this.gesture = null;
    this.selection = new Set();
    this.selectedSpawn = -1;
    doc.onChange(() => {
      // Undo/redo swap in fresh objects; drop selections that no longer exist.
      for (const a of this.selection) if (!doc.actors.includes(a)) this.selection.delete(a);
      if (this.selectedSpawn >= doc.spawns.length) this.selectedSpawn = -1;
    });
  }

  info(type) {
    return catalogEntry(this.catalog, type);
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
      case 'ore':
      case 'gems':
      case 'eraser': {
        doc.begin(TOOLS.find((t) => t.id === s.tool).label);
        this.gesture = { kind: 'stroke', right, last: [x, y] };
        this.stroke([[x, y]], right);
        break;
      }
      case 'fill':
        if (!doc.inside(x, y)) return;
        doc.begin('Fill');
        fill(doc, x, y, right ? TERRAIN.CLEAR : s.material, s.symmetry);
        doc.commit();
        break;
      case 'rect':
        this.gesture = { kind: 'rect', right, x0: x, y0: y, x1: x, y1: y };
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
          this.hooks.status('Pick an actor in the palette first.');
          return;
        }
        doc.begin(`Place ${s.actorType}`);
        this.gesture = { kind: 'place', last: null };
        this.placeAt(x, y);
        break;
      }
      case 'select':
        this.selectDown(x, y, e);
        break;
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
    } else if (g.kind === 'rect') {
      g.x1 = x;
      g.y1 = y;
    } else if (g.kind === 'place') {
      this.placeAt(x, y);
    } else if (g.kind === 'spawn') {
      this.dragSpawn(x, y);
    } else if (g.kind === 'move') {
      this.dragActors(x, y);
    } else if (g.kind === 'box') {
      g.x1 = x;
      g.y1 = y;
    }
  }

  up(cell) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    const doc = this.doc;
    if (g.kind === 'rect') {
      doc.begin('Rectangle');
      fillRect(doc, g.x0, g.y0, cell.x, cell.y, g.right ? TERRAIN.CLEAR : this.state.material, this.state.symmetry);
      doc.commit();
    } else if (g.kind === 'box') {
      const hits = actorsInRect(doc, this.catalog, g.x0, g.y0, g.x1, g.y1);
      if (!g.add) this.selection.clear();
      for (const a of hits) this.selection.add(a);
      this.hooks.selectionChanged();
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

  stroke(cells, right) {
    const s = this.state;
    const doc = this.doc;
    const area = [];
    for (const [cx, cy] of cells) area.push(...brushCells(cx, cy, s.size));
    if (s.tool === 'brush') paintTerrain(doc, area, right ? TERRAIN.CLEAR : s.material, s.symmetry);
    else if (s.tool === 'ore') paintOre(doc, area, right ? 0 : s.ore, s.symmetry);
    else if (s.tool === 'gems') paintGems(doc, area, right ? 0 : s.gems, s.symmetry);
    else erase(doc, area, s.symmetry, this.catalog);
  }

  /** Top-left cell for an actor placed with the cursor at (x, y): buildings centre on the cursor. */
  anchor(type, x, y) {
    const [fw, fh] = actorSize(this.info(type));
    return [x - Math.floor((fw - 1) / 2), y - Math.floor((fh - 1) / 2)];
  }

  placeAt(x, y) {
    const s = this.state;
    const [ax, ay] = this.anchor(s.actorType, x, y);
    const g = this.gesture;
    if (g.last && g.last[0] === ax && g.last[1] === ay) return;
    g.last = [ax, ay];
    const problem = placementProblem(this.doc, this.catalog, s.actorType, ax, ay);
    if (problem) {
      this.hooks.status(`Cannot place ${s.actorType} here: ${problem}.`);
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
  }

  dragSpawn(x, y) {
    const g = this.gesture;
    const doc = this.doc;
    const [nx, ny] = clampSpawn(doc, x - g.dx, y - g.dy);
    doc.spawns[g.k] = [nx, ny];
    for (const p of g.partners) {
      doc.spawns[p.k] = applyTransform(p.t, nx, ny, doc.width, doc.height, SPAWN_W, SPAWN_H);
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
      this.hooks.selectionChanged();
      this.startSpawnDrag(k, x, y);
      return;
    }
    this.selectedSpawn = -1;
    this.gesture = { kind: 'box', add: e.shiftKey, x0: x, y0: y, x1: x, y1: y };
  }

  dragActors(x, y) {
    const g = this.gesture;
    const dx = x - g.x0;
    const dy = y - g.y0;
    if (dx === g.dx && dy === g.dy) return;
    const ignore = this.selection;
    const ok = [...g.origin].every(([a, [ox, oy]]) => !placementProblem(this.doc, this.catalog, a.type, ox + dx, oy + dy, ignore));
    if (!ok) return;
    for (const [a, [ox, oy]] of g.origin) {
      a.x = ox + dx;
      a.y = oy + dy;
    }
    g.dx = dx;
    g.dy = dy;
  }

  // ---- Commands -------------------------------------------------------------------------

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
      return true;
    }
    return false;
  }

  /** Rotate the placement facing, and the selected units with it. */
  rotate(dir) {
    const s = this.state;
    s.facing = (s.facing + dir * ROTATE_STEP + 1024) % 1024;
    const units = [...this.selection].filter((a) => this.info(a.type)?.kind !== 'building');
    if (units.length) {
      this.doc.begin('Rotate');
      this.doc.touchObjects();
      for (const a of units) a.facing = (a.facing + dir * ROTATE_STEP + 1024) % 1024;
      this.doc.commit();
    }
  }

  setOwnerOfSelection(owner) {
    if (!this.selection.size) return;
    this.doc.begin('Change owner');
    this.doc.touchObjects();
    for (const a of this.selection) a.owner = owner;
    this.doc.commit();
  }

  // ---- Scene ------------------------------------------------------------------------------

  /** Sprites and rects for this frame, plus HTML labels for spawn numbers. */
  scene() {
    const doc = this.doc;
    const s = this.state;
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
    const team = (owner) => (owner >= 0 ? Math.min(owner, 7) : NEUTRAL_TEAM);
    const visible = (x, y, m) => x >= v.x0 - m && x <= v.x1 + m && y >= v.y0 - m && y <= v.y1 + m;

    // Spawns: a faint construction yard in the player's colour.
    const fact = this.order.get('FACT');
    doc.spawns.forEach(([sx, sy], k) => {
      const cx = (sx + SPAWN_W / 2) * CELL;
      const cy = (sy + SPAWN_H / 2) * CELL;
      if (fact !== undefined) sprite(cx, cy, 0, fact * 2, team(k), 0.45);
      const col = TEAM_COLORS[team(k)];
      outline(sx * CELL, sy * CELL, SPAWN_W * CELL, SPAWN_H * CELL, [col[0], col[1], col[2], 0.95], th * 1.5);
      labels.push({ text: String(k + 1), x: cx, y: cy, team: team(k), selected: k === this.selectedSpawn });
      if (k === this.selectedSpawn) outline(sx * CELL - 3, sy * CELL - 3, SPAWN_W * CELL + 6, SPAWN_H * CELL + 6, [1, 1, 1, 0.9]);
    });

    // Actors: buildings, building turrets, units, unit turrets (engine order).
    const layers = [[], [], [], []];
    for (const a of doc.actors) {
      const info = this.info(a.type);
      const t = info ? this.order.get(info.id) : undefined;
      if (t === undefined) continue;
      const building = info.kind === 'building';
      const [fw, fh] = actorSize(info);
      const x = building ? (a.x + fw / 2) * CELL : (a.x + 0.5) * CELL;
      const y = building ? (a.y + fh / 2) * CELL : (a.y + 0.5) * CELL;
      if (!visible(x, y, 96)) continue;
      const angle = building ? 0 : (a.facing * Math.PI * 2) / 1024;
      layers[building ? 0 : 2].push([x, y, angle, t * 2, team(a.owner)]);
      if (info.turret || this.overlays[t]) layers[building ? 1 : 3].push([x, y, angle, t * 2 + 1, team(a.owner)]);
    }
    for (const layer of layers) for (const [x, y, angle, id, tm] of layer) sprite(x, y, angle, id, tm, 1);

    // Grid
    if (s.grid) {
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

    this.cursorScene(rect, outline, sprite);
    return { sprites, rects, labels };
  }

  /** Brush, rectangle, placement and box previews under the cursor. */
  cursorScene(rect, outline, sprite) {
    const doc = this.doc;
    const s = this.state;
    const g = this.gesture;
    const h = this.view.hover;
    if (g?.kind === 'rect' || g?.kind === 'box') {
      const [ax, bx] = [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)];
      const [ay, by] = [Math.min(g.y0, g.y1), Math.max(g.y0, g.y1)];
      const c = g.kind === 'box' ? [1, 1, 1, 0.9] : [0.95, 0.8, 0.25, 0.95];
      const fillC = g.kind === 'box' ? [1, 1, 1, 0.08] : [0.95, 0.8, 0.25, 0.15];
      for (const p of g.kind === 'rect' ? symmetricPositions(s.symmetry, ax, ay, doc.width, doc.height, bx - ax + 1, by - ay + 1) : [{ x: ax, y: ay }]) {
        rect(p.x * CELL, p.y * CELL, (bx - ax + 1) * CELL, (by - ay + 1) * CELL, fillC);
        outline(p.x * CELL, p.y * CELL, (bx - ax + 1) * CELL, (by - ay + 1) * CELL, c);
      }
      return;
    }
    if (!h) return;
    const { x, y } = h;
    if (s.tool === 'brush' || s.tool === 'ore' || s.tool === 'gems' || s.tool === 'eraser') {
      const c = { eraser: [1, 0.35, 0.3, 0.35], ore: [0.95, 0.75, 0.2, 0.35], gems: [0.85, 0.3, 0.7, 0.35] }[s.tool] ?? [1, 1, 1, 0.22];
      const cells = brushCells(x, y, s.size);
      symmetricPositions(s.symmetry, x, y, doc.width, doc.height).forEach((p, n) => {
        const dx = p.x - x;
        const dy = p.y - y;
        const col = n === 0 ? c : [c[0], c[1], c[2], c[3] * 0.55];
        for (const [cx, cy] of cells) {
          // Mirror the brush shape around its own centre (it is symmetric anyway).
          const mx = cx + dx;
          const my = cy + dy;
          if (doc.inside(mx, my)) rect(mx * CELL, my * CELL, CELL, CELL, col);
        }
      });
    } else if (s.tool === 'fill' || s.tool === 'rect') {
      for (const p of symmetricPositions(s.symmetry, x, y, doc.width, doc.height)) outline(p.x * CELL, p.y * CELL, CELL, CELL, [1, 1, 1, 0.8]);
    } else if (s.tool === 'spawn') {
      const k = spawnAt(doc, x, y);
      if (k < 0) {
        const [sx, sy] = clampSpawn(doc, x - 1, y - 2);
        for (const p of symmetricPositions(s.symmetry, sx, sy, doc.width, doc.height, SPAWN_W, SPAWN_H)) {
          outline(p.x * CELL, p.y * CELL, SPAWN_W * CELL, SPAWN_H * CELL, [1, 1, 1, 0.6]);
        }
      }
    } else if (s.tool === 'actor' && s.actorType && !g) {
      const info = this.info(s.actorType);
      if (!info) return;
      const [ax, ay] = this.anchor(s.actorType, x, y);
      const [fw, fh] = actorSize(info);
      const t = this.order.get(info.id);
      for (const p of symmetricPositions(s.symmetry, ax, ay, doc.width, doc.height, fw, fh)) {
        const bad = placementProblem(doc, this.catalog, s.actorType, p.x, p.y);
        for (const [cx, cy, c] of actorCells({ type: s.actorType, x: p.x, y: p.y }, this.catalog)) {
          const col = bad ? [0.9, 0.2, 0.15, 0.4] : c === 2 ? [0.3, 0.8, 0.35, 0.18] : [0.3, 0.85, 0.35, 0.35];
          rect(cx * CELL, cy * CELL, CELL, CELL, col);
        }
        const building = info.kind === 'building';
        const px = building ? (p.x + fw / 2) * CELL : (p.x + 0.5) * CELL;
        const py = building ? (p.y + fh / 2) * CELL : (p.y + 0.5) * CELL;
        const angle = building ? 0 : (transformFacing(p.t, s.facing) * Math.PI * 2) / 1024;
        const o = mirroredOwner(p.t, s.owner, doc.spawns, doc.width, doc.height);
        const owner = o >= 0 ? Math.min(o, 7) : NEUTRAL_TEAM;
        sprite(px, py, angle, t * 2, owner, 0.6);
        if (info.turret || this.overlays[t]) sprite(px, py, angle, t * 2 + 1, owner, 0.6);
      }
    }
  }
}
