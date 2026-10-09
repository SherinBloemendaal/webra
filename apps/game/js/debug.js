// Debug menu: OpenRA's developer mode, opened with the ` key (hotkeys.js) or the
// "Debug" button on the battlefield.
//
// Two kinds of tools:
//
// - Cheats change the simulation, so they are engine orders like any other
//   (Game.dev_flag / dev_give_cash / dev_kill / dev_experience, engine/src/debug.rs
//   and veterancy.rs). Online
//   they travel through lockstep and every peer applies them on the same tick.
//   They only work when the game was started with the lobby option "Debug
//   menu" (options key `cheats`): the engine ignores them otherwise and the
//   server refuses to relay them (apps/server/src/validate.js). The menu only
//   offers them in such games.
// - Views are local and never change the game: cell grid and occupancy,
//   footprints, the flow field a selected unit follows, combat geometry,
//   actor tags and health numbers, performance stats and a frame graph. They
//   read engine state through read-only calls (Game.debug_cells, debug_flow,
//   debug_actors, debug_stats) and only show what the player may see.
//
// The pure helpers at the top have no DOM and are unit tested
// (apps/game/tests/debug.test.mjs).

import { instanceLines } from './crowd.js';
import { defaultRegistry } from './registry.js';
import { VIEWS } from './debug-views.js';

/** Cheat flags (engine/src/debug.rs DevFlag), in menu order. */
export const CHEATS = [
  { flag: 'fast_build', label: 'Instant build', title: 'Production finishes at once (it still costs money).' },
  { flag: 'build_anywhere', label: 'Build anywhere', title: 'Structures can be placed anywhere on explored ground.' },
  { flag: 'unlimited_power', label: 'Unlimited power', title: 'Never run low on power.' },
  { flag: 'fast_charge', label: 'Instant charge', title: 'Support powers are ready at once.' },
  { flag: 'disable_shroud', label: 'Reveal map', title: 'Disable shroud and fog: see the whole map.' },
  { flag: 'all_tech', label: 'All tech', title: 'Every prerequisite counts as met: build anything.' },
];

export { VIEWS };

/** Cell flags of Game.debug_cells (engine/src/debug.rs `cell`). */
export const CELL = {
  EXPLORED: 1,
  BLOCKED: 2,
  WATER: 4,
  FOOTPRINT: 8,
  FOOTPRINT_PASSABLE: 16,
  UNITS: 32,
  VISIBLE: 64,
};

/** Flow field directions (engine/src/flowfield.rs DIRS): clockwise from north; 8 goal, 255 none. */
export const DIRS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
export const DIR_GOAL = 8;

/** Settings registry group of the view choices (js/registry.js). */
const PREFS_GROUP = 'debug';
const HISTORY = 240;

/**
 * Split a `[x0, y0, width, height, value...]` grid from the engine (after
 * `skip` leading values). Returns null when it is empty or malformed.
 */
export function decodeGrid(data, skip = 0) {
  if (!data || data.length < skip + 4) return null;
  const [x0, y0, w, h] = [data[skip], data[skip + 1], data[skip + 2], data[skip + 3]];
  if (!(w > 0 && h > 0) || data.length !== skip + 4 + w * h) return null;
  return { x0, y0, w, h, at: (x, y) => data[skip + 4 + (y - y0) * w + (x - x0)] };
}

/** Stored choices: known view keys and `cpuInstances` (force the CPU instance path), only booleans. */
export function sanitizePrefs(stored) {
  const out = {};
  const ok = stored && typeof stored === 'object';
  for (const v of VIEWS) out[v.key] = !!(ok && stored[v.key] === true);
  out.cpuInstances = !!(ok && stored.cpuInstances === true);
  return out;
}

/** Rolling history of frame timings (ms) for the graph and the averages. */
export class PerfHistory {
  constructor(size = HISTORY) {
    this.size = size;
    this.frame = new Float32Array(size);
    this.render = new Float32Array(size);
    this.sim = new Float32Array(size);
    this.count = 0;
    this.next = 0;
  }

  push(frameMs, renderMs, simMs) {
    this.frame[this.next] = frameMs;
    this.render[this.next] = renderMs;
    this.sim[this.next] = simMs;
    this.next = (this.next + 1) % this.size;
    this.count = Math.min(this.count + 1, this.size);
  }

  /** Samples oldest first. */
  series(name) {
    const src = this[name];
    const out = [];
    for (let i = 0; i < this.count; i++) out.push(src[(this.next - this.count + i + this.size) % this.size]);
    return out;
  }

  /** { avg, max } of a series. */
  summary(name) {
    const s = this.series(name);
    if (s.length === 0) return { avg: 0, max: 0 };
    let sum = 0;
    let max = 0;
    for (const v of s) {
      sum += v;
      max = Math.max(max, v);
    }
    return { avg: sum / s.length, max };
  }
}

/** Lines of the performance panel. */
export function formatStats(stats, perf, { fps = 0, simMs = 0, tickMs = 40, memoryBytes = 0, sim = null, instances = null } = {}) {
  const f = perf.summary('frame');
  const r = perf.summary('render');
  const s = perf.summary('sim');
  const lines = [
    `FPS ${fps.toFixed(0)}  frame ${f.avg.toFixed(1)} ms (max ${f.max.toFixed(1)})`,
    `render ${r.avg.toFixed(2)} ms  sim ${simMs.toFixed(2)} ms/tick (budget ${tickMs} ms)  sim/frame ${s.avg.toFixed(2)} ms`,
  ];
  if (stats) {
    lines.push(
      `tick ${stats.tick}  units ${stats.units}  structures ${stats.buildings}  actor slots ${stats.actorSlots}`,
      `projectiles ${stats.projectiles}  effects ${stats.effects}`,
      `flow fields: ${stats.flowComputed} computed, ${stats.flowCached} cached  passability v${stats.passVersion}`,
    );
  }
  if (memoryBytes > 0) lines.push(`wasm memory ${(memoryBytes / (1024 * 1024)).toFixed(1)} MB`);
  if (sim) lines.push(...simLines(sim));
  lines.push(...instanceLines(instances));
  return lines;
}

/**
 * Where the simulation runs (js/sim/host.js stats()): the mode and why, and
 * for a worker its time per frame, the step round trip and torn frames.
 */
export function simLines(sim) {
  const lines = [`simulation: ${sim.label} (${sim.reason})`];
  if (sim.workerMs !== null && sim.workerMs !== undefined) {
    const torn = sim.mode === 'shared' ? `  torn frames ${sim.torn}` : '';
    lines.push(`worker sim/frame ${sim.workerMs.toFixed(2)} ms  step round trip ${(sim.roundTripMs ?? 0).toFixed(1)} ms${torn}`);
  }
  return lines;
}

function readPrefs() {
  return sanitizePrefs(defaultRegistry().group(PREFS_GROUP));
}

function writePrefs(prefs) {
  // The registry keeps them (private mode or full storage: for this page only).
  defaultRegistry().patch(PREFS_GROUP, sanitizePrefs(prefs));
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rgba(c, a) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${b(c[0])}, ${b(c[1])}, ${b(c[2])}, ${a})`;
}

// ---- Menu -----------------------------------------------------------------------

export class DebugMenu {
  /**
   * @param {HTMLElement} field the battlefield element (holds the game canvas)
   * @param {{
   *   game: any, input: any, player: number, rules: any, colors: number[][],
   *   online: boolean, tickMs: number, memoryBytes?: () => number, sim?: () => object,
   *   step?: () => boolean, isPaused?: () => boolean, setPaused?: (on: boolean) => void,
   *   instances?: () => object,
   * }} ctx `step` runs one simulation tick while paused (local games only);
   *   `instances` describes the instance path for the stats (js/crowd.js instanceLines)
   */
  constructor(field, ctx) {
    this.ctx = ctx;
    this.game = ctx.game;
    this.player = ctx.player;
    this.cheats = ctx.game.cheats_enabled();
    this.pxPerCell = ctx.rules.pxPerCell || 24;
    this.prefs = readPrefs();
    this.perf = new PerfHistory();
    this.stats = null;
    this.fps = 0;
    this.simMs = 0;
    /** Cheat flags just switched here, until the engine state agrees (lockstep delay). */
    this.pending = new Map();

    this.overlay = el('canvas', 'debug-overlay');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.ctx2d = this.overlay.getContext('2d');
    this.button = el('button', 'hud-button debug-button', this.cheats ? 'Debug (cheats on)' : 'Debug');
    this.button.type = 'button';
    this.button.title = 'Debug menu (`)';
    this.button.classList.toggle('debug-button-cheats', this.cheats);
    this.button.classList.toggle('debug-button-online', !!ctx.online);
    this.button.addEventListener('click', () => this.toggle());
    this.panel = this.buildPanel();
    this.panel.hidden = true;
    field.append(this.overlay, this.button, this.panel);

  }

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.refreshPanel();
  }

  buildPanel() {
    const panel = el('section', 'debug-panel');
    panel.setAttribute('aria-label', 'Debug menu');
    // Clicks in the panel must not reach the map.
    for (const type of ['mousedown', 'pointerdown', 'contextmenu', 'wheel']) panel.addEventListener(type, (e) => e.stopPropagation());
    const head = el('div', 'debug-head');
    head.append(el('h2', 'debug-title', 'Debug menu'));
    const close = el('button', 'debug-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.toggle(false));
    head.append(close);
    panel.append(head);

    // Cheats (simulation, lockstep orders).
    const cheats = el('div', 'debug-section');
    cheats.append(el('h3', 'debug-heading', 'Cheats'));
    this.cheatBoxes = new Map();
    if (this.cheats) {
      cheats.append(el('p', 'debug-note debug-note-cheats', 'Cheats are enabled in this game, for every player.'));
      const grid = el('div', 'debug-grid');
      for (const c of CHEATS) {
        const row = el('label', 'debug-check');
        row.title = c.title;
        const box = el('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => {
          this.pending.set(c.flag, { on: box.checked, until: performance.now() + 3000 });
          this.game.dev_flag(this.player, c.flag, box.checked);
        });
        this.cheatBoxes.set(c.flag, box);
        row.append(box, el('span', null, c.label));
        grid.append(row);
      }
      const actions = el('div', 'debug-actions');
      actions.append(
        this.action('Give $20,000', 'Add cash (OpenRA: give cash).', () => this.game.dev_give_cash(this.player)),
        this.action('Destroy selected', 'Destroy the selected actors, of any owner.', () => {
          const ids = this.ctx.input.selection;
          if (ids.length > 0) this.game.dev_kill(this.player, Uint32Array.from(ids));
        }),
        this.action('Give experience to selection', 'Raise each selected own unit one veterancy rank (OpenRA: level up).', () => {
          const ids = this.ctx.input.selection;
          if (ids.length > 0) this.game.dev_experience(this.player, Uint32Array.from(ids));
        }),
      );
      cheats.append(grid, actions);
    } else {
      cheats.append(el('p', 'debug-note', 'Cheats are off in this game. The host enables them with the "Debug menu" lobby option.'));
    }
    panel.append(cheats);

    // Views (local only).
    const views = el('div', 'debug-section');
    views.append(el('h3', 'debug-heading', 'Views'));
    const vgrid = el('div', 'debug-grid');
    for (const v of VIEWS) {
      const row = el('label', 'debug-check');
      row.title = v.title;
      const box = el('input');
      box.type = 'checkbox';
      box.checked = this.prefs[v.key];
      box.addEventListener('change', () => {
        this.prefs[v.key] = box.checked;
        writePrefs(this.prefs);
        this.refreshPanel();
      });
      row.append(box, el('span', null, v.label));
      vgrid.append(row);
    }
    views.append(vgrid);
    panel.append(views);

    // Rendering: the GPU instance pass or the CPU path (js/crowd.js).
    const rendering = el('div', 'debug-section');
    rendering.append(el('h3', 'debug-heading', 'Rendering'));
    const row = el('label', 'debug-check');
    row.title = 'Build every frame\'s sprites in the simulation instead of interpolating tick-rate records on the GPU.';
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.prefs.cpuInstances;
    box.addEventListener('change', () => {
      this.prefs.cpuInstances = box.checked;
      writePrefs(this.prefs);
      this.refreshPanel();
    });
    row.append(box, el('span', null, 'CPU instance path'));
    rendering.append(row);
    panel.append(rendering);

    // Simulation stepping (local games only: online games never pause).
    if (!this.ctx.online && this.ctx.step) {
      const sim = el('div', 'debug-section');
      sim.append(el('h3', 'debug-heading', 'Simulation'));
      // Its own pause: the game menu (Esc, P) covers the map and this panel.
      if (this.ctx.setPaused) {
        this.pauseBtn = this.action('Pause', 'Pause or resume the simulation without opening the game menu.', () => {
          this.ctx.setPaused(!this.ctx.isPaused());
          this.refreshPanel();
        });
        sim.append(this.pauseBtn);
      }
      this.stepBtn = this.action('Step one tick', 'Advance the paused game by one tick.', () => {
        this.ctx.step();
        this.refreshPanel();
      });
      sim.append(this.stepBtn);
      panel.append(sim);
    }

    this.statsBox = el('pre', 'debug-stats');
    this.graph = el('canvas', 'debug-graph');
    this.graph.width = HISTORY;
    this.graph.height = 60;
    this.graph.setAttribute('role', 'img');
    this.graph.setAttribute('aria-label', 'Frame time graph');
    panel.append(this.statsBox, this.graph);
    return panel;
  }

  action(label, title, onClick) {
    const b = el('button', 'debug-action', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  /** Sync the panel with the engine (called with `player_json()` every 100 ms). */
  update(state) {
    if (this.panel.hidden) return;
    const now = performance.now();
    const dev = state?.dev ?? {};
    for (const [flag, box] of this.cheatBoxes) {
      const p = this.pending.get(flag);
      if (p && (dev[flag] === p.on || now > p.until)) this.pending.delete(flag);
      box.checked = this.pending.has(flag) ? this.pending.get(flag).on : dev[flag] === true;
    }
    this.refreshPanel();
  }

  refreshPanel() {
    const isPaused = this.ctx.isPaused?.() ?? false;
    if (this.stepBtn) this.stepBtn.disabled = !isPaused;
    if (this.pauseBtn) this.pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    const stats = this.prefs.stats;
    this.statsBox.hidden = !stats;
    this.graph.hidden = !this.prefs.graph;
    if (stats) {
      try {
        this.stats = JSON.parse(this.game.debug_stats());
      } catch {
        this.stats = null;
      }
      this.statsBox.textContent = formatStats(this.stats, this.perf, {
        fps: this.fps,
        simMs: this.simMs,
        tickMs: this.ctx.tickMs,
        memoryBytes: this.ctx.memoryBytes?.() ?? 0,
        sim: this.ctx.sim?.() ?? null,
        instances: this.ctx.instances?.() ?? null,
      }).join('\n');
    }
  }

  /**
   * Once per animation frame, after the game was drawn.
   * @param {{ frameMs: number, renderMs: number, simFrameMs: number, simMs: number, fps: number }} t
   */
  frame(t) {
    this.perf.push(t.frameMs, t.renderMs, t.simFrameMs);
    this.fps = t.fps;
    this.simMs = t.simMs;
    if (!this.panel.hidden && this.prefs.graph) this.drawGraph();
    this.drawOverlay();
  }

  drawGraph() {
    const g = this.graph.getContext('2d');
    const { width: w, height: h } = this.graph;
    g.clearRect(0, 0, w, h);
    const scale = h / 50; // 50 ms at the top
    g.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    for (const ms of [16.7, 33.3]) {
      g.beginPath();
      g.moveTo(0, h - ms * scale);
      g.lineTo(w, h - ms * scale);
      g.stroke();
    }
    const plot = (name, color) => {
      const s = this.perf.series(name);
      g.strokeStyle = color;
      g.beginPath();
      s.forEach((v, i) => {
        const x = w - s.length + i;
        const y = h - Math.min(h, v * scale);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    };
    plot('frame', '#9fc36a');
    plot('render', '#5fa8e8');
    plot('sim', '#e8a23a');
  }

  // ---- World overlays ---------------------------------------------------------------

  wantsOverlay() {
    const p = this.prefs;
    return p.cells || p.footprints || p.flow || p.combat || p.tags || p.health;
  }

  drawOverlay() {
    const canvas = this.overlay;
    const c = this.ctx2d;
    if (!this.wantsOverlay()) {
      if (!canvas.hidden) {
        c.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
      }
      return;
    }
    canvas.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cw, ch);
    const cam = this.ctx.input.camera;
    const v = this.ctx.input.viewRect();
    const k = dpr * cam.zoom;
    // World pixels to canvas pixels.
    const world = () => c.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    const sx = (x) => (x - cam.x) * k;
    const sy = (y) => (y - cam.y) * k;
    const line = (px) => px / cam.zoom; // a width of `px` CSS pixels in world space

    const P = this.pxPerCell;
    if (this.prefs.cells) {
      world();
      this.drawCells(c, v, P, line);
    }
    if (this.prefs.flow) {
      world();
      this.drawFlow(c, v, P, line);
    }
    let actors = [];
    if (this.prefs.footprints || this.prefs.combat || this.prefs.tags || this.prefs.health || this.prefs.flow) {
      try {
        actors = JSON.parse(this.game.debug_actors(this.player, v.x0, v.y0, v.x1, v.y1));
      } catch {
        actors = [];
      }
    }
    world();
    if (this.prefs.flow) this.drawGoals(c, actors, P, line);
    if (this.prefs.footprints) this.drawFootprints(c, actors, P, line);
    if (this.prefs.combat) this.drawCombat(c, actors, line);
    if (this.prefs.tags || this.prefs.health) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      this.drawLabels(c, actors, sx, sy, dpr);
    }
  }

  drawCells(c, v, P, line) {
    const g = decodeGrid(this.game.debug_cells(this.player, v.x0, v.y0, v.x1, v.y1));
    if (!g) return;
    for (let y = g.y0; y < g.y0 + g.h; y++) {
      for (let x = g.x0; x < g.x0 + g.w; x++) {
        const f = g.at(x, y);
        if (!(f & CELL.EXPLORED)) continue;
        let fill = null;
        if (f & CELL.FOOTPRINT) fill = f & CELL.FOOTPRINT_PASSABLE ? 'rgba(90, 160, 255, 0.18)' : 'rgba(90, 160, 255, 0.38)';
        else if (f & CELL.BLOCKED && f & CELL.WATER) fill = 'rgba(60, 200, 220, 0.18)';
        else if (f & CELL.BLOCKED) fill = 'rgba(230, 70, 50, 0.32)';
        if (fill) {
          c.fillStyle = fill;
          c.fillRect(x * P, y * P, P, P);
        }
        if (f & CELL.UNITS) {
          c.fillStyle = 'rgba(120, 240, 120, 0.85)';
          c.fillRect(x * P + P / 2 - line(2), y * P + P / 2 - line(2), line(4), line(4));
        }
      }
    }
    c.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    c.lineWidth = line(1);
    c.beginPath();
    for (let x = g.x0; x <= g.x0 + g.w; x++) {
      c.moveTo(x * P, g.y0 * P);
      c.lineTo(x * P, (g.y0 + g.h) * P);
    }
    for (let y = g.y0; y <= g.y0 + g.h; y++) {
      c.moveTo(g.x0 * P, y * P);
      c.lineTo((g.x0 + g.w) * P, y * P);
    }
    c.stroke();
  }

  drawFlow(c, v, P, line) {
    let data = null;
    for (const id of this.ctx.input.selection) {
      data = this.game.debug_flow(this.player, id, v.x0, v.y0, v.x1, v.y1);
      if (data && data.length > 0) break;
    }
    if (!data || data.length < 6) return;
    const [gx, gy] = data;
    const g = decodeGrid(data, 2);
    if (g) {
      c.strokeStyle = 'rgba(255, 230, 120, 0.7)';
      c.lineWidth = line(1.2);
      c.beginPath();
      for (let y = g.y0; y < g.y0 + g.h; y++) {
        for (let x = g.x0; x < g.x0 + g.w; x++) {
          const d = g.at(x, y);
          if (d >= DIRS.length) continue;
          const [dx, dy] = DIRS[d];
          const len = Math.hypot(dx, dy);
          const [ux, uy] = [dx / len, dy / len];
          const [cx, cy] = [(x + 0.5) * P, (y + 0.5) * P];
          const [tx, ty] = [cx + ux * P * 0.35, cy + uy * P * 0.35];
          c.moveTo(cx - ux * P * 0.25, cy - uy * P * 0.25);
          c.lineTo(tx, ty);
          // Arrow head.
          c.moveTo(tx, ty);
          c.lineTo(tx - (ux - uy * 0.6) * P * 0.18, ty - (uy + ux * 0.6) * P * 0.18);
          c.moveTo(tx, ty);
          c.lineTo(tx - (ux + uy * 0.6) * P * 0.18, ty - (uy - ux * 0.6) * P * 0.18);
        }
      }
      c.stroke();
    }
    c.strokeStyle = 'rgba(255, 230, 120, 1)';
    c.lineWidth = line(2);
    c.strokeRect(gx * P + line(1), gy * P + line(1), P - line(2), P - line(2));
  }

  drawGoals(c, actors, P, line) {
    c.setLineDash([line(4), line(3)]);
    c.lineWidth = line(1);
    c.strokeStyle = 'rgba(255, 230, 120, 0.8)';
    c.beginPath();
    for (const a of actors) {
      if (!a.goal) continue;
      c.moveTo(a.x, a.y);
      c.lineTo((a.goal[0] + 0.5) * P, (a.goal[1] + 0.5) * P);
    }
    c.stroke();
    c.setLineDash([]);
  }

  drawFootprints(c, actors, P, line) {
    c.lineWidth = line(1.5);
    for (const a of actors) {
      const color = this.ctx.colors[a.owner] ?? [1, 1, 1];
      c.strokeStyle = rgba(color, 0.9);
      if (a.building) {
        const b = a.building;
        c.strokeRect(b.cx * P, b.cy * P, b.w * P, b.h * P);
      } else if (a.radius > 0) {
        c.beginPath();
        c.arc(a.x, a.y - a.altitude, a.radius, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  drawCombat(c, actors, line) {
    c.lineWidth = line(1);
    for (const a of actors) {
      if (a.weapons.length === 0) continue;
      const color = this.ctx.colors[a.owner] ?? [1, 1, 1];
      const seen = new Set();
      for (const w of a.weapons) {
        if (w.range <= 0 || seen.has(w.range)) continue;
        seen.add(w.range);
        c.strokeStyle = rgba(color, 0.55);
        c.beginPath();
        c.arc(a.x, a.y, w.range, 0, Math.PI * 2);
        c.stroke();
        if (w.minRange > 0) {
          c.setLineDash([line(3), line(3)]);
          c.beginPath();
          c.arc(a.x, a.y, w.minRange, 0, Math.PI * 2);
          c.stroke();
          c.setLineDash([]);
        }
      }
      if (a.target) {
        c.strokeStyle = 'rgba(255, 80, 60, 0.9)';
        c.beginPath();
        c.moveTo(a.x, a.y - a.altitude);
        c.lineTo(a.target[0], a.target[1]);
        c.stroke();
      }
    }
  }

  drawLabels(c, actors, sx, sy, dpr) {
    c.font = `${Math.round(11 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    for (const a of actors) {
      const x = sx(a.x);
      let y = sy(a.y - a.altitude) - (a.building ? (a.building.h * this.pxPerCell * this.ctx.input.camera.zoom * dpr) / 2 : 12 * dpr);
      const lines = [];
      if (this.prefs.health) lines.push([`${a.hp}/${a.maxHp}`, a.hp * 2 > a.maxHp ? '#b8f08a' : a.hp * 4 > a.maxHp ? '#f0d060' : '#ff7a60']);
      if (this.prefs.tags) lines.push([`#${a.id} ${a.type} P${a.owner + 1}${a.activity ? ` ${a.activity}` : ''}`, '#e8e4cf']);
      for (const [text, color] of lines) {
        const w = c.measureText(text).width + 6 * dpr;
        c.fillStyle = 'rgba(0, 0, 0, 0.6)';
        c.fillRect(x - w / 2, y - 13 * dpr, w, 13 * dpr);
        c.fillStyle = color;
        c.fillText(text, x, y - 1 * dpr);
        y -= 14 * dpr;
      }
    }
  }
}
