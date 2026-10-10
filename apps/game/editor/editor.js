// WebRA map editor: boot, panels, commands, shortcuts and the render loop.
// Reuses the game's engine package (actor catalog, generated maps, validation,
// and the preview that draws the map's actors exactly as a game does:
// js/world.js), WebGPU renderer, sprite atlas and installed content (js/art.js).

import init, { Game, base_rules_json } from '../pkg/webra_sim.js';
import { NEUTRAL_COLOR, Renderer, TEAM_COLORS } from '../js/renderer.js';
import { AnimClock } from '../js/anim.js';
import { artActors } from '../js/gameart.js';
import { defaultRegistry } from '../js/registry.js';
import { settings } from '../js/settings.js';
import { EditorArt } from './js/art.js';
import { PREVIEW_NEUTRAL, PreviewWorld } from './js/world.js';
import { TEST_MAP_KEY } from '../js/maploader.js';
import { MapDoc } from './js/doc.js';
import { EditorView, isTyping } from './js/view.js';
import { Controller, TOOLS, teamOf } from './js/controller.js';
import { Minimap, previewCanvas } from './js/preview.js';
import { RulesPanel, MODDED_WARNING, loadRulesBase } from './js/rulespanel.js';
import { ApiError, fetchMap, listMaps, publishMap, shareLink } from './js/online.js';
import { BRUSH_SIZES } from './js/edits.js';
import { SYMMETRY_MODES } from './js/symmetry.js';
import {
  LIMITS,
  TERRAIN,
  TERRAIN_NAMES,
  BIOMES,
  byteLength,
  canonicalJson,
  createMap,
  isModded,
  mapFileName,
  parseMap,
  validateMap,
} from './js/mapformat.js';
import { countOverrides } from './js/overrides.js';
import { download, el, store } from './js/ui.js';
import { segmented } from '../js/ui/controls.js';
import { importOramap, isOramapFile, ORAMAP_MAX_BYTES } from '../js/oramap/index.js';
import { renderReport } from '../js/oramap/report.js';

const DRAFT_KEY = 'webra.editor.draft';
/** Tool choices and the author name live in the settings registry (js/registry.js, "extra" group, editor* keys). */
const PREF_KEYS = ['material', 'size', 'ore', 'gems', 'symmetry', 'grid'];
const prefKey = (k) => `editor${k[0].toUpperCase()}${k.slice(1)}`;

const MATERIALS = [
  { t: TERRAIN.CLEAR, key: '1', color: '#3e582c' },
  { t: TERRAIN.ROUGH, key: '2', color: '#605c3a' },
  { t: TERRAIN.ROCK, key: '3', color: '#807666' },
  { t: TERRAIN.WATER, key: '4', color: '#244666' },
  { t: TERRAIN.TREE, key: '5', color: '#1c3618' },
  { t: TERRAIN.FORD, key: '6', color: '#4a7076' },
  { t: TERRAIN.ROAD, key: '7', color: '#766852' },
  { t: TERRAIN.BEACH, key: '8', color: '#b0a070' },
  { t: TERRAIN.RIVER, key: '9', color: '#2c5270' },
  { t: TERRAIN.WALL, key: '0', color: '#60605c' },
];

/**
 * The neutral world of OpenRA maps (engine/src/neutral.rs) by its OpenRA
 * map editor category (rules_json world.category); bridges by their own.
 */
const WORLD_GROUPS = [
  { name: 'Tech buildings', category: 'Tech building' },
  { name: 'Civilian buildings', category: 'Civilian building' },
  { name: 'Civilians', category: 'Civilian infantry' },
  { name: 'Trees', category: 'Tree' },
  { name: 'Decorations', category: 'Decoration' },
  { name: 'Ore and gem mines', category: 'Resource spawn' },
];
const isWorld = (a) => !!a.world?.bridge || !!a.world?.bridgeHut || WORLD_GROUPS.some((g) => g.category === a.world?.category);
const isWall = (a) => a.world?.category === 'Wall';
const PALETTE_GROUPS = [
  { name: 'Structures', test: (a) => a.kind === 'building' && a.queue === 0 && !isWorld(a) },
  { name: 'Defenses', test: (a) => a.kind === 'building' && a.queue === 1 && !isWall(a) && !a.name.startsWith('Fake') && !isWorld(a) },
  { name: 'Walls', test: (a) => isWall(a) },
  { name: 'Fakes', test: (a) => a.kind === 'building' && a.name.startsWith('Fake') },
  { name: 'Infantry', test: (a) => a.kind === 'infantry' && !isWorld(a) },
  { name: 'Vehicles', test: (a) => a.kind === 'vehicle' },
  // OpenRA's crates and husks (engine/src/crates.rs, husks.rs), as in its editor.
  { name: 'Crates', test: (a) => a.kind === 'crate' },
  { name: 'Husks', test: (a) => a.kind === 'husk' },
  ...WORLD_GROUPS.map((g) => ({ name: g.name, test: (a) => a.world?.category === g.category })),
  // Bridges bring their template's terrain when placed (js/edits.js stampBridge).
  { name: 'Bridges', test: (a) => !!a.world?.bridge },
];

/** Hide palette actors that do not belong to the map's biome (OpenRA MapEditorData tilesets). */
function filterPaletteByBiome() {
  const biome = doc.meta.biome ?? 'temperate';
  document.querySelectorAll('.palette-item').forEach((b) => {
    const a = catalog[b.dataset.actor];
    const biomes = a?.world?.biomes;
    const bridge = a?.world?.bridge;
    b.hidden = (Array.isArray(biomes) && !biomes.includes(biome)) || (!!bridge && !bridge[biome]);
  });
}

const SHORTCUTS = [
  ['B F R O C E S A V', 'Brush, fill, rectangle, ore, gems (crystals), eraser, spawns, actor, select'],
  ['1 to 0', 'Terrain: clear, rough, rock, water, trees, ford, road, beach, river, wall'],
  ['[ and ]', 'Brush size (1, 3, 5, 9)'],
  ['- and =', 'Ore or gem density'],
  ['M', 'Cycle symmetry mode'],
  ['G', 'Toggle grid'],
  [', and .', 'Rotate the actor to place (and selected units)'],
  ['Delete', 'Delete the selected actors or spawn'],
  ['Escape', 'Cancel the current drag, clear the selection'],
  ['Right drag', 'Brush and rectangle paint clear ground, ore and gem brushes remove ore or gems, actor tool deletes'],
  ['Arrows, middle drag, Space + drag', 'Pan the map'],
  ['Wheel', 'Zoom at the cursor'],
  ['Home', 'Fit the whole map'],
  ['Ctrl+Z, Ctrl+Shift+Z (Ctrl+Y)', 'Undo, redo'],
  ['Ctrl+S, Ctrl+O, Ctrl+Alt+N', 'Save, open (also OpenRA .oramap), new map'],
  ['Ctrl+Enter', 'Test play'],
  ['?', 'This help'],
];

const $ = (sel) => document.querySelector(sel);

const state = {
  tool: 'brush',
  material: TERRAIN.WATER,
  size: 3,
  ore: 8,
  gems: 3,
  symmetry: 'none',
  grid: true,
  actorType: null,
  owner: -1,
  facing: 0,
};

let doc;
let view;
let ctl;
let catalog;
let actorList;
let rulesBase;
let minimap;
let renderer;
let art;
let preview;
let engineResult = null;
let jsResult = null;
const animClock = new AnimClock();

// ---- Boot ---------------------------------------------------------------------------

async function boot() {
  const bootEl = $('#boot');
  const fail = (err) => {
    bootEl.hidden = false;
    bootEl.classList.add('error');
    bootEl.textContent = `The editor cannot start: ${err?.message ?? err}.`;
    console.error(err);
  };
  let wasm;
  try {
    wasm = await init();
    const engineRules = JSON.parse(new Game(1, 'allies', 'soviet', 48).rules_json());
    actorList = engineRules.actors;
    catalog = Object.fromEntries(actorList.map((a) => [a.id, a]));
    rulesBase = await loadRulesBase();
  } catch (err) {
    fail(err);
    return;
  }
  try {
    renderer = await Renderer.create($('#view'));
  } catch (err) {
    fail(new Error(`${err?.message ?? err} It needs a browser with WebGPU (Chrome or Edge 113+, Safari 26+)`));
    return;
  }
  try {
    // Installed content is read before the first frame, as a game does.
    art = new EditorArt({ settings });
    await art.load();
    // Neutral actors (trees, civilians, tech buildings) in the civilian tan, as in a game (js/main.js).
    TEAM_COLORS[PREVIEW_NEUTRAL] = NEUTRAL_COLOR.slice();
    animClock.watchReducedMotion();
    preview = new PreviewWorld({ Game, memory: () => wasm.memory, prepare: (g) => art.applyTo(g) });
    await start();
  } catch (err) {
    fail(err);
  }
}

async function start() {
  loadPrefs();
  const { map, note } = await initialMap();
  doc = new MapDoc(map);
  view = new EditorView($('#view'), renderer, {
    down: (c, e) => ctl.down(c, e),
    move: (c, e) => ctl.move(c, e),
    up: (c, e) => ctl.up(c, e),
    leave: () => ctl.leave(),
  });
  ctl = new Controller(doc, view, catalog, state, {
    status: (text) => toast(text),
    hover: (cell) => updateStatus(cell),
    selectionChanged: () => renderSelection(),
  });
  minimap = new Minimap($('#minimap'), (x, y) => view.centerOn(x, y));
  applyArt();
  art.onChange(() => {
    applyArt();
    syncGraphics();
  });

  buildTools();
  buildMapPane();
  buildActorsPane();
  new RulesPanel($('[data-pane="rules"]'), doc, rulesBase);
  buildOnlinePane();
  bindTopbar();
  bindTabs();
  bindKeys();
  bindDrop();

  doc.onChange(onDocChange);
  view.setMap(doc);
  requestAnimationFrame(() => view.fit());
  onDocChange({ cells: true, objects: true, meta: true, resized: true }, { initial: true });
  $('#boot').hidden = true;
  if (note) toast(note);
  window.webraEditor = { doc, view, ctl, catalog, rulesBase, state, art, preview };
  requestAnimationFrame(frame);
}

/**
 * The sprite atlas of the map's biome with the art in use (installed
 * content or WebRA's), as a game on the map builds it (js/gameart.js).
 */
let artBiome = null;
function applyArt() {
  const biome = doc.meta.biome ?? 'temperate';
  artBiome = biome;
  const { atlas } = art.build(artActors(actorList), biome, renderer.maxTextureSize);
  renderer.setAtlas(atlas);
  ctl.overlays = atlas.overlays;
  preview.reprepare();
  view.terrainDirty = true;
  if (document.querySelector('.palette-item')) renderPaletteIcons();
}

/** Map to open: `?map=<id>`, else the autosaved draft, else a new map. */
async function initialMap() {
  const id = new URLSearchParams(location.search).get('map');
  if (id) {
    try {
      const { map } = await fetchMap(id);
      return { map, note: `Opened published map "${map.name}".` };
    } catch (err) {
      return { map: newBlankMap(), note: `Could not open map ${id}: ${err.message}` };
    }
  }
  const draft = store.get(DRAFT_KEY);
  if (draft) {
    try {
      const { map, savedAt } = JSON.parse(draft);
      new MapDoc(map); // throws on undecodable layers
      return { map, note: `Restored your draft from ${new Date(savedAt).toLocaleString()}.` };
    } catch {
      store.remove(DRAFT_KEY);
    }
  }
  return { map: newBlankMap(), note: null };
}

function newBlankMap(width = 96, height = 96, base = TERRAIN.CLEAR) {
  return createMap({ width, height, base, name: 'Untitled', author: defaultRegistry().get('extra', 'editorAuthor') || 'Commander' });
}

function loadPrefs() {
  const p = defaultRegistry().group('extra');
  for (const k of PREF_KEYS) state[k] = p[prefKey(k)];
}

function savePrefs() {
  defaultRegistry().patch('extra', Object.fromEntries(PREF_KEYS.map((k) => [prefKey(k), state[k]])));
}

// ---- Render loop --------------------------------------------------------------------------

let last = performance.now();
let minimapTime = 0;
/** The map changed since the preview was built (js/world.js). */
let previewDirty = true;
/** When installed terrain tiles were last planned (they take a while on big maps). */
let tilesTime = 0;
const TILES_EVERY_MS = 250;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  animClock.advance(now - last, false);
  last = now;
  view.update(dt);
  if (previewDirty) {
    previewDirty = false;
    preview.update(JSON.stringify(doc.toMap()));
    if (preview.error) console.warn('Map preview:', preview.error);
    view.terrainDirty = true;
  }
  if (view.terrainDirty) {
    // Installed tiles are planned for the whole map: during a stroke at most a few times a second.
    const tiled = art.originalActive || art.content?.enabledPacks().some((p) => p.manifest.terrain);
    if (!tiled || !ctl.gesture || now - tilesTime > TILES_EVERY_MS) {
      tilesTime = now;
      view.updateTerrain(doc, preview.terrain(), (bytes) => art.terrain(doc.meta.biome ?? 'temperate', bytes, doc.width, doc.height));
    }
  }
  const scene = ctl.scene();
  view.draw(animClock.uniform(), preview.sprites(view.viewRect()), scene);
  placeLabels(scene.labels);
  if (now - minimapTime > 66) {
    minimapTime = now;
    minimap.draw(doc, catalog, view.viewRect());
  }
  requestAnimationFrame(frame);
}

const labelEls = [];
function placeLabels(labels) {
  const root = $('#labels');
  while (labelEls.length < labels.length) {
    const e = el('div', { class: 'spawn-label' });
    root.append(e);
    labelEls.push(e);
  }
  const cam = view.camera;
  labelEls.forEach((e, i) => {
    const l = labels[i];
    if (!l) {
      e.hidden = true;
      return;
    }
    e.hidden = false;
    e.textContent = l.text;
    const c = TEAM_COLORS[l.team];
    e.style.color = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    e.style.fontSize = `${Math.max(11, Math.min(40, 30 * cam.zoom))}px`;
    e.style.transform = `translate(${(l.x - cam.x) * cam.zoom}px, ${(l.y - cam.y) * cam.zoom}px) translate(-50%, -50%)`;
    e.classList.toggle('selected', l.selected);
  });
}

// ---- Document changes ---------------------------------------------------------------------

let autosaveTimer = 0;
let validateTimer = 0;

function onDocChange(change, { initial = false } = {}) {
  if (change.resized) view.setMap(doc);
  if (change.cells || change.objects || change.resized || change.meta || change.rules) previewDirty = true;
  if (change.cells || change.objects || change.resized) minimap.invalidate();
  if (change.meta || change.resized) {
    syncMetaFields();
    view.setBiome(doc.meta.biome ?? 'temperate');
    // Trees, ice and huts follow the biome (art/world.js), and so does the original theater.
    if ((doc.meta.biome ?? 'temperate') !== artBiome) applyArt();
    minimap.invalidate();
  }
  if (change.objects || change.resized) {
    renderOwnerOptions();
    renderSelection();
  }
  updateUndoButtons();
  updateModded();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(runValidation, initial ? 0 : 250);
  if (!initial) {
    $('#save-state').textContent = 'Unsaved draft...';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosave, 800);
  }
  document.title = `${doc.meta.name || 'Untitled'} - WebRA Map Editor`;
}

function autosave() {
  const ok = store.set(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), map: doc.toMap() }));
  $('#save-state').textContent = ok ? 'Draft saved in this browser' : 'Draft not saved (browser storage unavailable)';
}

function updateUndoButtons() {
  const u = $('[data-cmd="undo"]');
  const r = $('[data-cmd="redo"]');
  u.disabled = !doc.canUndo;
  r.disabled = !doc.canRedo;
  u.title = doc.canUndo ? `Undo ${doc.undoStack[doc.undoStack.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
  r.title = doc.canRedo ? `Redo ${doc.redoStack[doc.redoStack.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo';
}

function updateModded() {
  const map = { rules: doc.rules };
  const modded = isModded(map);
  $('#modded-badge').hidden = !modded;
  const n = countOverrides(doc.rules);
  const dot = $('#rules-count');
  dot.hidden = n === 0;
  dot.textContent = String(n);
}

// ---- Validation ---------------------------------------------------------------------------

/** Validate with the engine (source of truth) and the editor's located checks. */
function validateNow() {
  const map = doc.toMap();
  const text = JSON.stringify(map);
  engineResult = JSON.parse(Game.validate_map(text));
  jsResult = validateMap(map, { catalog, rulesBase });
  return { map, text, engine: engineResult, js: jsResult };
}

function runValidation() {
  const { text, engine, js } = validateNow();
  const box = $('#validation');
  const head = $('#validation-head');
  const bytes = byteLength(text);
  head.className = `verdict ${engine.ok ? 'ok' : 'bad'}`;
  head.textContent = engine.ok
    ? `Valid map${js.warnings.length ? `, ${js.warnings.length} warning${js.warnings.length === 1 ? '' : 's'}` : ''}`
    : `${engine.errors.length} error${engine.errors.length === 1 ? '' : 's'}: fix before publishing`;
  const items = [];
  for (const e of engine.errors) items.push(el('li', { class: 'error' }, e));
  // Located issues from the editor's checks: click to jump there.
  for (const i of js.issues) {
    if (i.level === 'error' && engine.errors.length === 0) {
      // The editor found something the engine accepts: show it as a warning.
      items.push(issueItem({ ...i, level: 'warning' }));
    } else if (i.level === 'warning' || i.x !== undefined) {
      items.push(issueItem(i));
    }
  }
  box.replaceChildren(...items);
  $('#map-stats').textContent =
    `${doc.width} x ${doc.height} cells, ${doc.spawns.length} spawns, ${doc.actors.length} actors, ` +
    `${(bytes / 1024).toFixed(1)} KiB of ${LIMITS.maxBytes / 1024} KiB` +
    (engine.hash ? `, hash ${engine.hash.slice(0, 12)}` : '');
}

function issueItem(i) {
  const located = i.x !== undefined && i.y !== undefined;
  return el(
    'li',
    {
      class: `${i.level}${located ? ' jump' : ''}`,
      title: located ? 'Show on the map' : '',
      onclick: located ? () => view.centerOnCell(i.x, i.y) : undefined,
    },
    i.message,
  );
}

// ---- Tools pane ----------------------------------------------------------------------------

function buildTools() {
  const root = $('#tools');
  const toolButtons = TOOLS.map((t) =>
    el('button', { type: 'button', class: 'tool', 'data-tool': t.id, title: `${t.label} (${t.key}): ${t.hint}`, onclick: () => setTool(t.id) }, [
      el('kbd', {}, t.key),
      el('span', {}, t.label),
    ]),
  );
  const materials = MATERIALS.map((m) =>
    el('button', { type: 'button', class: 'swatch', 'data-material': String(m.t), title: `${TERRAIN_NAMES[m.t]} (${m.key})`, onclick: () => setMaterial(m.t) }, [
      el('i', { style: `background:${m.color}` }),
      el('span', {}, TERRAIN_NAMES[m.t]),
    ]),
  );
  const sizes = BRUSH_SIZES.map((n) =>
    el('button', { type: 'button', class: 'seg', 'data-size': String(n), title: `Brush size ${n}`, onclick: () => setSize(n) }, String(n)),
  );
  const ore = el('input', { type: 'range', id: 'ore-density', min: '1', max: String(LIMITS.maxOre), value: String(state.ore), oninput: () => setOre(Number(ore.value)) });
  const gems = el('input', { type: 'range', id: 'gem-density', min: '1', max: String(LIMITS.maxGems), value: String(state.gems), oninput: () => setGems(Number(gems.value)) });
  const symmetry = el(
    'select',
    { id: 'symmetry', onchange: () => setSymmetry(symmetry.value) },
    SYMMETRY_MODES.map((m) => el('option', { value: m.id }, m.label)),
  );
  const grid = el('input', { type: 'checkbox', id: 'grid', onchange: () => setGrid(grid.checked) });
  root.append(
    el('h2', {}, 'Tools'),
    el('div', { class: 'tool-list' }, toolButtons),
    el('div', { class: 'opt', 'data-for': 'brush fill rect' }, [el('h2', {}, 'Terrain'), el('div', { class: 'swatches' }, materials)]),
    el('div', { class: 'opt', 'data-for': 'brush ore gems eraser' }, [el('h2', {}, 'Brush size'), el('div', { class: 'segs' }, sizes)]),
    el('div', { class: 'opt', 'data-for': 'ore' }, [
      el('h2', {}, ['Ore density ', el('span', { id: 'ore-value', class: 'muted' })]),
      ore,
      el('p', { class: 'hint' }, 'Ore only lies on clear or rough ground. It grows back and spreads when the lobby allows ore regrowth.'),
    ]),
    el('div', { class: 'opt', 'data-for': 'gems' }, [
      el('h2', {}, ['Gem density ', el('span', { id: 'gem-value', class: 'muted' })]),
      gems,
      el('p', { class: 'hint' }, 'Gems only lie on clear or rough ground. A bale of gems pays twice as much as ore; gems never grow back.'),
    ]),
    el('div', { class: 'opt', 'data-for': 'actor' }, [
      el('h2', {}, 'Actor'),
      el('p', { id: 'actor-pick', class: 'hint' }),
      el('p', { class: 'hint' }, ['Facing ', el('span', { id: 'facing-value' }), ' (, and . rotate)']),
    ]),
    el('h2', {}, 'Symmetry'),
    symmetry,
    el('label', { class: 'check' }, [grid, ' Grid (G)']),
    el('p', { id: 'tool-hint', class: 'hint' }),
  );
  syncTools();
}

function syncTools() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  document.querySelectorAll('[data-material]').forEach((b) => b.classList.toggle('active', Number(b.dataset.material) === state.material));
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === state.size));
  document.querySelectorAll('#tools .opt').forEach((o) => (o.hidden = !o.dataset.for.split(' ').includes(state.tool)));
  $('#ore-value').textContent = `${state.ore} / ${LIMITS.maxOre}`;
  $('#ore-density').value = String(state.ore);
  $('#gem-value').textContent = `${state.gems} / ${LIMITS.maxGems}`;
  $('#gem-density').value = String(state.gems);
  $('#symmetry').value = state.symmetry;
  $('#grid').checked = state.grid;
  $('#facing-value').textContent = `${state.facing} / 1024`;
  const info = state.actorType ? catalog[state.actorType] : null;
  $('#actor-pick').textContent = info ? `${info.name} (${info.id}) for ${ownerName(state.owner)}` : 'Pick an actor in the Actors tab.';
  $('#tool-hint').textContent = TOOLS.find((t) => t.id === state.tool).hint;
  document.querySelectorAll('.palette-item').forEach((b) => b.classList.toggle('active', b.dataset.actor === state.actorType));
  $('#view').dataset.tool = state.tool;
}

function setTool(t) {
  ctl.cancel();
  state.tool = t;
  if (t === 'actor') showTab('actors');
  syncTools();
}

function setMaterial(t) {
  state.material = t;
  if (!['brush', 'fill', 'rect'].includes(state.tool)) state.tool = 'brush';
  savePrefs();
  syncTools();
}

function setSize(n) {
  state.size = n;
  savePrefs();
  syncTools();
}

function setOre(n) {
  state.ore = Math.max(1, Math.min(LIMITS.maxOre, n));
  savePrefs();
  syncTools();
}

function setGems(n) {
  state.gems = Math.max(1, Math.min(LIMITS.maxGems, n));
  savePrefs();
  syncTools();
}

/** - and =: the density of the gem brush when it is active, else of the ore brush. */
function stepDensity(d) {
  if (state.tool === 'gems') return setGems(state.gems + d);
  return setOre(state.ore + d);
}

function setSymmetry(m) {
  state.symmetry = m;
  savePrefs();
  syncTools();
  toast(`Symmetry: ${SYMMETRY_MODES.find((s) => s.id === m).label}`);
}

function setGrid(on) {
  state.grid = on;
  savePrefs();
  syncTools();
}

// ---- Map pane --------------------------------------------------------------------------------

function buildMapPane() {
  const pane = $('[data-pane="map"]');
  const field = (key, label, max, multiline = false) => {
    const input = el(multiline ? 'textarea' : 'input', {
      id: `meta-${key}`,
      maxlength: String(max),
      rows: multiline ? '3' : undefined,
      oninput: () => {
        doc.begin(`Edit ${label.toLowerCase()}`, `meta.${key}`);
        doc.touchMeta();
        doc.meta[key] = input.value;
        doc.commit();
        if (key === 'author') defaultRegistry().set('extra', 'editorAuthor', input.value);
      },
    });
    return el('label', { class: 'field stacked' }, [el('span', { class: 'label' }, `${label} `), input]);
  };
  pane.append(
    el('h2', {}, 'Properties'),
    field('name', 'Name', LIMITS.nameMax),
    field('author', 'Author', LIMITS.authorMax),
    field('description', 'Description', LIMITS.descriptionMax, true),
    el('label', { class: 'field stacked', title: 'Terrain look and weather of the map. Not a rules change: the map stays unmodded.' }, [
      el('span', { class: 'label' }, 'Biome '),
      el(
        'select',
        {
          id: 'meta-biome',
          onchange: (e) => {
            doc.begin('Edit biome', 'meta.biome');
            doc.touchMeta();
            doc.meta.biome = e.target.value;
            doc.commit();
          },
        },
        BIOMES.map((b) => el('option', { value: b }, b.charAt(0).toUpperCase() + b.slice(1))),
      ),
    ]),
    graphicsControl(),
    el('p', { id: 'map-stats', class: 'hint' }),
    el('h2', {}, 'Validation'),
    el('div', { id: 'validation-head', class: 'verdict' }),
    el('ul', { id: 'validation', class: 'issues' }),
    el('p', { class: 'hint' }, 'Checked by the game engine. Click an entry with a location to jump there.'),
  );
}

/**
 * The Graphics choice of the game (registry game.graphics, the game menu's
 * Settings): the map, palette and previews in WebRA's art or the original
 * Red Alert graphics installed on this device. Publishing never sends art:
 * a map is its data only.
 */
let graphicsChoice = null;
function graphicsControl() {
  graphicsChoice = segmented({
    name: 'editor-graphics',
    label: 'Graphics',
    options: [
      { value: 'webra', label: 'WebRA' },
      { value: 'original', label: 'Original' },
    ],
    value: art.graphics,
    describedBy: 'graphics-note',
    onChange: (v) => {
      art.graphics = v;
    },
  });
  const wrap = el('div', { class: 'field stacked' }, [el('span', { class: 'label' }, 'Graphics'), graphicsChoice.root, el('p', { id: 'graphics-note', class: 'hint' })]);
  syncGraphics();
  return wrap;
}

function syncGraphics() {
  if (!graphicsChoice) return;
  graphicsChoice.set(art.graphics);
  const has = art.hasOriginal;
  graphicsChoice.setDisabled('original', !has);
  graphicsChoice.setTitle('original', has ? '' : 'Install the original content in the game first (start screen, Original content).');
  const note = $('#graphics-note');
  if (note) {
    note.textContent = !has
      ? 'The original Red Alert graphics are not installed on this device: install them from the game\'s Original content dialog to edit with them.'
      : art.originalActive
        ? 'The map is drawn with the original Red Alert graphics, as in a game with Graphics set to Original.'
        : 'The map is drawn with WebRA\'s own art. The choice is the game\'s Graphics setting.';
  }
}

function syncMetaFields() {
  for (const k of ['name', 'author', 'description']) {
    const input = $(`#meta-${k}`);
    if (input && input.value !== doc.meta[k]) input.value = doc.meta[k];
  }
  const biome = $('#meta-biome');
  if (biome && biome.value !== (doc.meta.biome ?? 'temperate')) biome.value = doc.meta.biome ?? 'temperate';
  filterPaletteByBiome();
}

// ---- Actors pane ----------------------------------------------------------------------------

function ownerName(owner) {
  return owner < 0 ? 'neutral' : `spawn ${owner + 1}`;
}

function buildActorsPane() {
  const pane = $('[data-pane="actors"]');
  const owner = el('select', {
    id: 'owner',
    onchange: () => {
      state.owner = Number(owner.value);
      renderPaletteIcons();
      syncTools();
    },
  });
  const groups = PALETTE_GROUPS.map((g) => {
    const actors = Object.values(catalog).filter(g.test);
    if (!actors.length) return null;
    return el('details', { class: 'palette-group', open: true }, [
      el('summary', {}, `${g.name} (${actors.length})`),
      el(
        'div',
        { class: 'palette' },
        actors.map((a) =>
          el(
            'button',
            {
              type: 'button',
              class: 'palette-item',
              'data-actor': a.id,
              title: `${a.name} (${a.id})${a.kind === 'building' ? `, ${a.width}x${a.height}` : ''}`,
              onclick: () => {
                state.actorType = a.id;
                setTool('actor');
              },
            },
            [el('canvas', { width: '48', height: '40' }), el('span', {}, a.name)],
          ),
        ),
      ),
    ]);
  });
  pane.append(
    el('div', { id: 'selection-box' }),
    el('h2', {}, 'Place for'),
    owner,
    el('p', { class: 'hint' }, 'Pre-placed actors belong to a spawn (the player who starts there) or are neutral.'),
    ...groups,
  );
  renderOwnerOptions();
  renderPaletteIcons();
  filterPaletteByBiome();
}

function renderOwnerOptions() {
  const owner = $('#owner');
  if (!owner) return;
  if (state.owner >= doc.spawns.length) state.owner = -1;
  owner.replaceChildren(
    el('option', { value: '-1' }, 'Neutral'),
    ...doc.spawns.map((_, k) => el('option', { value: String(k) }, `Spawn ${k + 1}`)),
  );
  owner.value = String(state.owner);
}

/** Palette pictures in the owner's colour, from the art in use (js/art.js paintPalette). */
function renderPaletteIcons() {
  const team = TEAM_COLORS[teamOf(state.owner)];
  document.querySelectorAll('.palette-item').forEach((b) => {
    const actor = catalog[b.dataset.actor];
    const source = art.paintPalette(b.querySelector('canvas'), actor, ctl.order.get(actor.id) ?? -1, team);
    b.dataset.art = source;
  });
}

function renderSelection() {
  const box = $('#selection-box');
  if (!box) return;
  const sel = [...ctl.selection];
  if (!sel.length) {
    box.replaceChildren();
    return;
  }
  const owners = new Set(sel.map((a) => a.owner));
  const owner = el(
    'select',
    { onchange: () => ctl.setOwnerOfSelection(Number(owner.value)) },
    [el('option', { value: '-1' }, 'Neutral'), ...doc.spawns.map((_, k) => el('option', { value: String(k) }, `Spawn ${k + 1}`))],
  );
  owner.value = owners.size === 1 ? String([...owners][0]) : '';
  const names = sel.length === 1 ? `${catalog[sel[0].type]?.name ?? sel[0].type} at ${sel[0].x},${sel[0].y}` : `${sel.length} actors`;
  box.replaceChildren(
    el('h2', {}, 'Selection'),
    el('p', {}, names),
    el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Owner'), owner]),
    el('button', { type: 'button', onclick: () => ctl.deleteSelection() }, 'Delete (Del)'),
  );
}

// ---- Online pane ------------------------------------------------------------------------------

function buildOnlinePane() {
  const pane = $('[data-pane="online"]');
  pane.append(
    el('h2', {}, 'Publish'),
    el('p', { class: 'hint' }, 'Upload the map so others can play it. Published maps are public and identified by their hash.'),
    el('button', { type: 'button', class: 'primary wide', onclick: () => publish() }, 'Publish map'),
    el('div', { id: 'publish-result' }),
    el('h2', {}, ['Published maps ', el('button', { type: 'button', class: 'link', onclick: () => browse() }, 'Refresh')]),
    el('div', { id: 'browse' }, el('p', { class: 'hint' }, 'Press Refresh to list published maps.')),
  );
}

async function publish() {
  showTab('online');
  const out = $('#publish-result');
  const { map, engine } = validateNow();
  if (!engine.ok) {
    out.replaceChildren(el('p', { class: 'error' }, 'Fix the validation errors first (Map tab).'));
    showTab('map');
    return;
  }
  if (engine.modded && !confirm(`${MODDED_WARNING}\n\nPublish this MODDED map anyway?`)) return;
  out.replaceChildren(el('p', { class: 'hint' }, 'Publishing...'));
  try {
    const { id, hash, localHash } = await publishMap(map);
    const link = shareLink(id);
    const linkInput = el('input', { type: 'text', readonly: 'readonly', value: link, onfocus: () => linkInput.select() });
    out.replaceChildren(
      el('p', { class: 'ok' }, `Published. Map id: ${id}`),
      el('div', { class: 'row' }, [
        linkInput,
        el('button', { type: 'button', onclick: () => copy(link) }, 'Copy link'),
      ]),
      hash && hash !== localHash ? el('p', { class: 'error' }, `The server's hash (${hash.slice(0, 12)}) differs from the editor's (${localHash.slice(0, 12)}).`) : null,
    );
  } catch (err) {
    out.replaceChildren(el('p', { class: 'error' }, err instanceof ApiError ? err.message : `Publishing failed: ${err.message}`));
  }
}

async function browse() {
  const box = $('#browse');
  box.replaceChildren(el('p', { class: 'hint' }, 'Loading...'));
  let maps;
  try {
    maps = await listMaps();
  } catch (err) {
    box.replaceChildren(el('p', { class: 'error' }, err.message));
    return;
  }
  if (!maps.length) {
    box.replaceChildren(el('p', { class: 'hint' }, 'No published maps yet.'));
    return;
  }
  box.replaceChildren(
    el(
      'ul',
      { class: 'map-list' },
      maps.map((m) =>
        el('li', {}, [
          el('div', { class: 'title' }, [String(m.name ?? m.id), m.modded ? el('span', { class: 'badge modded' }, 'MODDED') : null]),
          el('div', { class: 'muted' }, `${m.author ?? '?'}, ${m.width}x${m.height}, ${m.players} players, ${m.downloads ?? 0} downloads`),
          el('div', { class: 'row' }, [
            el('button', { type: 'button', onclick: () => openPublished(m) }, 'Open'),
            el('button', { type: 'button', class: 'link', onclick: () => copy(shareLink(m.id)) }, 'Copy play link'),
          ]),
        ]),
      ),
    ),
  );
}

async function openPublished(m) {
  try {
    const { map } = await fetchMap(m.id, m.hash);
    loadMap(map, `Open ${m.name}`);
    toast(`Opened "${map.name}".`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied.');
  } catch {
    toast(`Copy this link: ${text}`);
  }
}

// ---- Commands ---------------------------------------------------------------------------------

function loadMap(map, label) {
  const res = validateMap(map, { catalog, rulesBase });
  try {
    doc.replace(map, label);
  } catch (err) {
    toast(`Cannot open this map: ${err.message}`, true);
    return false;
  }
  ctl.selection.clear();
  view.fit();
  if (!res.ok) toast(`Opened with ${res.errors.length} validation error(s); see the Map tab.`, true);
  return true;
}

function openFile(file) {
  if (!file) return;
  if (isOramapFile(file.name)) {
    importOramapFile(file);
    return;
  }
  if (file.size > LIMITS.maxBytes * 2) {
    toast('That file is far too large for a map.', true);
    return;
  }
  file.text().then((text) => {
    let map;
    try {
      map = parseMap(text);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    if (loadMap(map, `Open ${file.name}`)) toast(`Opened ${file.name}.`);
  });
}

/**
 * Import an OpenRA .oramap package: convert it (js/oramap), show the import
 * report, and open the result for editing once the author confirms. Rules
 * the conversion kept make a modded map; the report repeats the modded
 * warning, and the author may open the map without them.
 */
async function importOramapFile(file) {
  if (file.size > ORAMAP_MAX_BYTES) {
    toast(`That .oramap file is larger than ${ORAMAP_MAX_BYTES / 1024 / 1024} MiB.`, true);
    return;
  }
  let result;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    result = await importOramap(bytes, {
      baseRules: JSON.parse(base_rules_json()),
      validate: (json) => JSON.parse(Game.validate_map(json)),
      fileName: file.name,
    });
  } catch (err) {
    showImportReport(err?.report ?? null, null, `Could not import ${file.name}: ${err?.message ?? err}`);
    return;
  }
  showImportReport(result.report, result.map, null);
}

function showImportReport(report, map, failure) {
  $('#import-report')?.remove();
  const open = (withRules) => {
    const m = withRules ? map : { ...map, rules: null };
    if (loadMap(m, `Import ${report.title}`)) toast(`Imported "${report.title}".`);
  };
  const buttons = [];
  if (map) {
    buttons.push(el('button', { type: 'submit', class: 'primary', value: 'open', onclick: () => open(true) }, map.rules ? 'Open with its rules (MODDED)' : 'Open in the editor'));
    if (map.rules) buttons.push(el('button', { type: 'submit', value: 'plain', onclick: () => open(false) }, 'Open without rules'));
  }
  buttons.push(el('button', { type: 'submit', value: 'cancel' }, map ? 'Cancel' : 'Close'));
  const dialog = el('dialog', { id: 'import-report', class: 'menu-card dialog wide' }, [
    el('form', { method: 'dialog' }, [
      el('h1', {}, 'OpenRA map import'),
      failure ? el('p', { class: 'error' }, failure) : null,
      map?.rules ? el('p', { class: 'error' }, MODDED_WARNING) : null,
      report ? renderReport(report) : null,
      map && report?.validation && !report.validation.ok ? el('p', { class: 'hint' }, 'Fix the listed problems in the editor before test play or publishing.') : null,
      el('div', { class: 'row' }, buttons),
    ]),
  ]);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function saveFile() {
  const map = doc.toMap();
  download(new Blob([canonicalJson(map)], { type: 'application/json' }), mapFileName(map.name));
  toast('Map downloaded.');
}

function exportPng() {
  const scale = Math.max(1, Math.min(8, Math.floor(1024 / Math.max(doc.width, doc.height))));
  previewCanvas(doc, catalog, scale).toBlob((blob) => {
    if (blob) download(blob, mapFileName(doc.meta.name).replace(/\.webra-map\.json$/, '.png'));
  }, 'image/png');
}

async function testPlay() {
  const { map, engine } = validateNow();
  if (!engine.ok && !confirm(`The map has validation errors:\n\n${engine.errors.join('\n')}\n\nThe game may refuse it. Test anyway?`)) return;
  const text = canonicalJson(map);
  try {
    sessionStorage.setItem(TEST_MAP_KEY, text);
  } catch {
    toast('Cannot hand the map to the game: browser storage is blocked.', true);
    return;
  }
  // window.open copies sessionStorage into the new tab (no noopener on purpose).
  const url = new URL('./?editorTest=1', document.baseURI).href;
  if (!window.open(url, '_blank')) location.href = url;
}

function newMapDialog() {
  const width = el('input', { type: 'number', min: String(LIMITS.minSize), max: String(LIMITS.maxSize), value: String(doc.width) });
  const height = el('input', { type: 'number', min: String(LIMITS.minSize), max: String(LIMITS.maxSize), value: String(doc.height) });
  const base = el('select', {}, MATERIALS.map((m) => el('option', { value: String(m.t) }, TERRAIN_NAMES[m.t])));
  const seed = el('input', { type: 'number', min: '0', value: String(Math.floor(Math.random() * 100000)) });
  const players = el('select', {}, [2, 3, 4, 5, 6, 7, 8].map((n) => el('option', { value: String(n) }, `${n} players`)));
  const genSize = el('input', { type: 'number', min: String(LIMITS.minSize), max: String(LIMITS.maxSize), value: '96' });
  const option = (v) => el('option', { value: v }, v.charAt(0).toUpperCase() + v.slice(1));
  const genStyle = el('select', {}, ['random', 'land', 'rivers', 'lakes', 'islands'].map(option));
  const genBiome = el('select', {}, ['random', ...BIOMES].map(option));
  // Tech buildings (OpenRA's map generator option "Buildings", engine mapgen/settlements.rs).
  const techLabels = { none: 'None', standard: 'Standard', extra: 'Extra', oilonly: 'Oil only', oilrush: 'Oil rush' };
  const genTech = el('select', {}, Object.entries(techLabels).map(([v, label]) => el('option', { value: v }, label)));
  genTech.value = 'standard';
  const hasTech = typeof Game.generated_map_with === 'function';
  const hasGenerator = typeof Game.generated_map === 'function';
  const hasStyles = typeof Game.generated_map_styled === 'function';
  const kind = (v) => el('input', { type: 'radio', name: 'newkind', value: v, checked: v === 'blank' });
  const blankRadio = kind('blank');
  const genRadio = kind('generated');
  genRadio.disabled = !hasGenerator;
  const error = el('p', { class: 'error' });
  const dialog = el('dialog', { class: 'menu-card dialog' }, [
    el('form', { method: 'dialog' }, [
      el('h1', {}, 'New map'),
      el('label', { class: 'check' }, [blankRadio, ' Blank map']),
      el('div', { class: 'indent' }, [
        el('label', {}, ['Width ', width]),
        el('label', {}, ['Height ', height]),
        el('label', {}, ['Terrain ', base]),
      ]),
      el('label', { class: 'check' }, [genRadio, ' Generated skirmish map']),
      el('div', { class: 'indent' }, [
        el('label', {}, ['Size ', genSize]),
        el('label', {}, ['Players ', players]),
        el('label', {}, ['Seed ', seed]),
        hasStyles ? el('label', {}, ['Style ', genStyle]) : null,
        hasStyles ? el('label', {}, ['Biome ', genBiome]) : null,
        hasTech ? el('label', {}, ['Tech buildings ', genTech]) : null,
        hasGenerator ? null : el('p', { class: 'hint' }, 'Needs an engine build with Game.generated_map.'),
      ]),
      el('p', { class: 'hint' }, 'The current map stays in the undo history.'),
      error,
      el('div', { class: 'row' }, [
        el('button', { type: 'submit', value: 'cancel' }, 'Cancel'),
        el('button', { type: 'submit', value: 'ok', class: 'primary' }, 'Create'),
      ]),
    ]),
  ]);
  const num = (input) => Number(input.value);
  const inRange = (n) => Number.isInteger(n) && n >= LIMITS.minSize && n <= LIMITS.maxSize;
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue !== 'ok') return;
    let map;
    if (genRadio.checked) {
      if (!inRange(num(genSize))) return toast(`Size must be ${LIMITS.minSize}..${LIMITS.maxSize}.`, true);
      const genSeed = Math.max(0, num(seed)) >>> 0;
      map = JSON.parse(
        hasTech
          ? Game.generated_map_with(genSeed, num(genSize), num(players), genStyle.value, genBiome.value, genTech.value)
          : hasStyles
            ? Game.generated_map_styled(genSeed, num(genSize), num(players), genStyle.value, genBiome.value)
            : Game.generated_map(genSeed, num(genSize), num(players)),
      );
      map.author = defaultRegistry().get('extra', 'editorAuthor') || map.author;
    } else {
      if (!inRange(num(width)) || !inRange(num(height))) return toast(`Width and height must be ${LIMITS.minSize}..${LIMITS.maxSize}.`, true);
      map = newBlankMap(num(width), num(height), Number(base.value));
    }
    loadMap(map, 'New map');
  });
  document.body.append(dialog);
  dialog.showModal();
}

function helpOverlay() {
  if ($('#help')) return $('#help').close();
  const dialog = el('dialog', { id: 'help', class: 'menu-card dialog wide' }, [
    el('form', { method: 'dialog' }, [
      el('h1', {}, 'Shortcuts'),
      el('table', { class: 'keys' }, SHORTCUTS.map(([k, d]) => el('tr', {}, [el('th', {}, k), el('td', {}, d)]))),
      el('p', { class: 'hint' }, 'Spawns are the top-left cell of each player\'s 3x4 construction yard and need clear ground. Ore and gems only lie on clear or rough ground.'),
      el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary' }, 'Close')),
    ]),
  ]);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

const COMMANDS = {
  new: newMapDialog,
  open: () => $('#file-input').click(),
  save: saveFile,
  png: exportPng,
  undo: () => {
    const label = doc.undo();
    if (label) toast(`Undo: ${label}`);
  },
  redo: () => {
    const label = doc.redo();
    if (label) toast(`Redo: ${label}`);
  },
  test: testPlay,
  publish,
  help: helpOverlay,
};

function bindTopbar() {
  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => COMMANDS[b.dataset.cmd]()));
  $('#file-input').addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
}

function bindTabs() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
}

function bindDrop() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    openFile(e.dataTransfer?.files?.[0]);
  });
}

// ---- Keyboard ---------------------------------------------------------------------------------

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod) {
      const run = (cmd) => {
        e.preventDefault();
        COMMANDS[cmd]();
      };
      if (k === 'z' && e.shiftKey) return run('redo');
      if (k === 'z' || k === 'y') {
        if (isTyping(e)) return; // let fields undo their own text
        return run(k === 'y' ? 'redo' : 'undo');
      }
      if (k === 's') return run('save');
      if (k === 'o') return run('open');
      if (k === 'n' && e.altKey) return run('new');
      if (k === 'enter') return run('test');
      return;
    }
    if (isTyping(e) || e.altKey) return;
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) return setTool(tool.id);
    const mat = MATERIALS.find((m) => m.key === e.key);
    if (mat) return setMaterial(mat.t);
    switch (e.key) {
      case '[':
      case ']': {
        const i = BRUSH_SIZES.indexOf(state.size) + (e.key === ']' ? 1 : -1);
        return setSize(BRUSH_SIZES[Math.max(0, Math.min(BRUSH_SIZES.length - 1, i))]);
      }
      case '-':
        return stepDensity(-1);
      case '=':
      case '+':
        return stepDensity(1);
      case 'm':
      case 'M': {
        const i = SYMMETRY_MODES.findIndex((s) => s.id === state.symmetry);
        return setSymmetry(SYMMETRY_MODES[(i + 1) % SYMMETRY_MODES.length].id);
      }
      case 'g':
      case 'G':
        return setGrid(!state.grid);
      case ',':
      case '.':
        ctl.rotate(e.key === '.' ? 1 : -1);
        return syncTools();
      case 'Delete':
      case 'Backspace':
        if (ctl.deleteSelection()) e.preventDefault();
        return;
      case 'Escape':
        if (!ctl.cancel()) {
          ctl.selection.clear();
          ctl.selectedSpawn = -1;
          renderSelection();
        }
        return;
      case 'Home':
        return view.fit();
      case '?':
        return helpOverlay();
    }
  });
}

// ---- Status and toasts ---------------------------------------------------------------------------

function updateStatus(cell) {
  const s = $('#status');
  if (!cell || !doc.inside(cell.x, cell.y)) {
    s.textContent = `${doc.width} x ${doc.height}  |  ${SYMMETRY_MODES.find((m) => m.id === state.symmetry).label}`;
    return;
  }
  const i = doc.idx(cell.x, cell.y);
  const ore = doc.ore[i] ? `, ore ${doc.ore[i]}` : doc.gems[i] ? `, gems ${doc.gems[i]}` : '';
  s.textContent = `${cell.x}, ${cell.y}  ${TERRAIN_NAMES[doc.terrain[i]]}${ore}  |  zoom ${view.camera.zoom.toFixed(2)}`;
}

let toastTimer = 0;
function toast(text, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 2600);
}

boot();
