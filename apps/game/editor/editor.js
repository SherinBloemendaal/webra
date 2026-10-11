// WebRA map editor: boot, panels, commands, shortcuts and the render loop.
// Reuses the game's engine package (actor catalog, map generator, validation,
// fairness checks, and the preview that draws the map's actors exactly as a
// game does: js/world.js), WebGPU renderer, sprite atlas, installed content
// (js/art.js), themed controls, tooltips and hotkey registry.

import init, { Game, base_rules_json } from '../pkg/webra_sim.js';
import { NEUTRAL_COLOR, Renderer, TEAM_COLORS } from '../js/renderer.js';
import { AnimClock } from '../js/anim.js';
import { artActors } from '../js/gameart.js';
import { defaultRegistry } from '../js/registry.js';
import { settings } from '../js/settings.js';
import { HotkeyRegistry, comboFromEvent, formatCombo, isMac, isReservedCombo } from '../js/hotkeys.js';
import { attachTooltip } from '../js/ui/tooltip.js';
import { segmented, slider, toggle } from '../js/ui/controls.js';
import { TEST_MAP_KEY, TEST_SETUP_KEY } from '../js/maploader.js';
import { importOramap, isOramapFile, ORAMAP_MAX_BYTES } from '../js/oramap/index.js';
import { renderReport } from '../js/oramap/report.js';
import { EditorArt } from './js/art.js';
import { PREVIEW_NEUTRAL, PreviewWorld } from './js/world.js';
import { MapDoc } from './js/doc.js';
import { EditorView, isTyping } from './js/view.js';
import { Controller, teamOf } from './js/controller.js';
import { COMMANDS, MATERIAL_KEYS, PAINT_LAYERS, TOOLS, actionName } from './js/commands.js';
import { Minimap, previewCanvas } from './js/preview.js';
import { RulesPanel, MODDED_WARNING, loadRulesBase } from './js/rulespanel.js';
import { ApiError, fetchMap, listMaps, publishMap, shareLink } from './js/online.js';
import { BRUSH_SIZES, copyRegion, clearRegion, regionFromData, regionToData, transformRegion } from './js/edits.js';
import { SYMMETRY_MODES, modeFits } from './js/symmetry.js';
import { cropMap, resizeMap, shiftMap, turnMap } from './js/transform.js';
import { findFixes } from './js/fixes.js';
import { LAYERS, fairnessView, historyList, keysList, layersList, problemsView, stampsList } from './js/panels.js';
import { mapSizeDialog, modal, newMapDialog, testPlayDialog, BIOME_CHOICES } from './js/dialogs.js';
import { editorIcon } from './js/icons.js';
import { actorStateView, editSetup, optionsView, parseTags, slotsView } from './js/setup.js';
import { PALETTE_GROUPS } from './js/palette.js';
import { LIMITS, TERRAIN, TERRAIN_NAMES, byteLength, canonicalJson, createMap, isModded, mapFileName, mapFileText, parseMap, validateMap } from './js/mapformat.js';
import { applyFix, openMapFile } from './js/upgrade.js';
import { mapThumbnail } from '../js/protocol.js';
import { LensArt } from '../js/maplens/source.js';
import { MapLens } from '../js/maplens/lens.js';
import { resolveGameScale, screenOf } from '../js/scale.js';
import { countOverrides } from './js/overrides.js';
import { download, el, store } from './js/ui.js';

const DRAFT_KEY = 'webra.editor.draft';
/**
 * The last opened file's format version story (js/upgrade.js openMapFile):
 * `notice` (upgraded, or why it is not compatible) stays until the map is
 * saved; `problems` with their quick fixes until fixed.
 */
let opened = { notice: null, problems: [] };
/** Recovery copies: the last maps worked on, kept when the draft moves on to another map. */
const RECOVERY_KEY = 'webra.editor.recovery';
const RECOVERY_COPIES = 3;
const RECOVERY_EVERY_MS = 2 * 60 * 1000;
const STAMPS_KEY = 'webra.editor.stamps';
const STAMPS_MAX = 24;
/** Tool choices and the author name live in the settings registry (js/registry.js, "extra" group, editor* keys). */
const PREF_KEYS = ['material', 'size', 'ore', 'gems', 'symmetry', 'paint', 'shapeFill', 'autoShore'];
const prefKey = (k) => `editor${k[0].toUpperCase()}${k.slice(1)}`;

const MATERIALS = [
  { t: TERRAIN.CLEAR, color: '#3e582c' },
  { t: TERRAIN.ROUGH, color: '#605c3a' },
  { t: TERRAIN.ROCK, color: '#807666' },
  { t: TERRAIN.WATER, color: '#244666' },
  { t: TERRAIN.TREE, color: '#1c3618' },
  { t: TERRAIN.FORD, color: '#4a7076' },
  { t: TERRAIN.ROAD, color: '#766852' },
  { t: TERRAIN.BEACH, color: '#b0a070' },
  { t: TERRAIN.RIVER, color: '#2c5270' },
  { t: TERRAIN.WALL, color: '#60605c' },
];
const MATERIAL_HINTS = {
  [TERRAIN.CLEAR]: 'Open ground: units drive, structures stand, ore lies.',
  [TERRAIN.ROUGH]: 'Rough ground: slower, holds ore, no structures.',
  [TERRAIN.ROCK]: 'Rock and cliffs: nobody passes.',
  [TERRAIN.WATER]: 'Water: ships only. Shores get their tiles from the land around them.',
  [TERRAIN.TREE]: 'Trees: each cell becomes a tree in the game.',
  [TERRAIN.FORD]: 'Ford: a river crossing for ground units; land to ships.',
  [TERRAIN.ROAD]: 'Road: faster, structures may stand on it. Pieces join up by themselves.',
  [TERRAIN.BEACH]: 'Beach: sand by the water; landing craft run up on it.',
  [TERRAIN.RIVER]: 'River: water that bridges can span.',
  [TERRAIN.WALL]: 'Wall terrain: blocks like rock.',
};

const $ = (sel) => document.querySelector(sel);

const state = {
  tool: 'brush',
  paint: 'terrain',
  material: TERRAIN.WATER,
  size: 3,
  ore: 8,
  gems: 3,
  symmetry: 'none',
  shapeFill: true,
  autoShore: false,
  actorType: null,
  owner: -1,
  facing: 0,
  layers: { grid: true, actors: true, spawns: true, resources: false, passability: false, buildable: false, zones: false, rush: false, reach: false, fog: false },
  /** The spawn whose start the fog preview shows. */
  fogSpawn: 0,
  region: null,
  clip: null,
  pasteLayers: { terrain: true, resources: true, actors: true },
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
/** The magnifier over the Map tab's thumbnail (js/maplens): the map in the game's art. */
let thumbLens = null;
let keys;
let engineResult = null;
let jsResult = null;
const animClock = new AnimClock();
const tips = [];

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
    thumbLens = new MapLens({
      art: new LensArt({ Game, memory: () => wasm.memory, content: art.content }),
      gameScale: () => resolveGameScale(settings.get('gameScale'), { ...screenOf(window), ratio: window.devicePixelRatio || 1 }),
    });
    await start();
  } catch (err) {
    fail(err);
  }
}

async function start() {
  loadPrefs();
  const { map: raw, note } = await initialMap();
  const first = openMapFile(raw);
  doc = new MapDoc(first.map ?? newBlankMap());
  opened = { notice: first.notice ?? null, problems: first.problems ?? [] };
  view = new EditorView($('#view'), renderer, {
    down: (c, e) => ctl.down(c, e),
    move: (c, e) => ctl.move(c, e),
    up: (c, e) => ctl.up(c, e),
    leave: () => ctl.leave(),
    cancel: () => ctl.cancel(),
  });
  ctl = new Controller(doc, view, catalog, state, {
    status: (text) => toast(text),
    hover: (cell) => updateStatus(cell),
    selectionChanged: () => renderSelection(),
    regionChanged: () => syncRegion(),
    picked: (what) => picked(what),
    endPaste: () => setTool('region'),
  });
  minimap = new Minimap($('#minimap'), (x, y) => view.centerOn(x, y), (f, x, y) => view.zoomAround(f, x, y));
  applyArt();
  art.onChange(() => {
    applyArt();
    syncGraphics();
  });

  keys = new HotkeyRegistry(settings);
  buildTopbar();
  buildTools();
  buildViewbar();
  buildPanels();
  bindKeys();
  bindDrop();

  doc.onChange(onDocChange);
  view.setMap(doc);
  requestAnimationFrame(() => view.fit());
  onDocChange({ cells: true, objects: true, meta: true, resized: true }, { initial: true });
  $('#boot').hidden = true;
  if (note || first.notice) toast([note, first.notice].filter(Boolean).join(' '), first.status !== 'current' && first.status !== 'upgraded');
  window.webraEditor = { doc, view, ctl, catalog, rulesBase, state, art, preview, keys };
  setInterval(saveRecovery, RECOVERY_EVERY_MS);
  window.addEventListener('pagehide', () => {
    autosave();
    saveRecovery();
  });
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
  state.layers.grid = p.editorGrid;
  const saved = p.editorLayers ?? {};
  for (const l of LAYERS) if (typeof saved[l.key] === 'boolean' && l.key !== 'grid') state.layers[l.key] = saved[l.key];
}

function savePrefs() {
  const layers = Object.fromEntries(LAYERS.filter((l) => l.key !== 'grid').map((l) => [l.key, !!state.layers[l.key]]));
  defaultRegistry().patch('extra', { ...Object.fromEntries(PREF_KEYS.map((k) => [prefKey(k), state[k]])), editorGrid: state.layers.grid, editorLayers: layers });
}

// ---- Render loop --------------------------------------------------------------------------

let last = performance.now();
let minimapTime = 0;
/** The map changed since the preview was built (js/world.js). */
let previewDirty = true;
/** The engine checks (Game.editor_cells, editor_report) are out of date. */
let analysisDirty = true;
/** When installed terrain tiles were last planned (they take a while on big maps). */
let tilesTime = 0;
const TILES_EVERY_MS = 250;

/** Previews built so far, and the fog shown (js/world.js, Game.editor_fog). */
let previewBuilds = 0;
let shownFog = 'clear';

/** Layers that need the engine's cell checks. */
const ANALYSIS_LAYERS = ['passability', 'buildable', 'zones', 'rush', 'reach'];

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  animClock.advance(now - last, false);
  last = now;
  view.update(dt);
  if (previewDirty) {
    previewDirty = false;
    if (preview.update(JSON.stringify(doc.toMap()))) previewBuilds++;
    if (preview.error) console.warn('Map preview:', preview.error);
    view.terrainDirty = true;
    analysisDirty = true;
  }
  if (analysisDirty && preview.game && (ANALYSIS_LAYERS.some((k) => state.layers[k]) || activeTab === 'check')) {
    analysisDirty = false;
    ctl.analysis = preview.game.editor_cells();
    if (activeTab === 'check') renderFairness();
  }
  // Fog preview: what the chosen spawn sees at the start, else everything visible.
  const fogKey = state.layers.fog && preview.game ? `${previewBuilds}:${state.fogSpawn}` : 'clear';
  if (fogKey !== shownFog) {
    shownFog = fogKey;
    view.uploadFog(fogKey === 'clear' ? null : preview.game.editor_fog(state.fogSpawn));
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
  const actors = state.layers.actors ? preview.sprites(view.viewRect()) : new Float32Array(0);
  view.draw(animClock.uniform(), actors, scene);
  placeLabels(state.layers.spawns ? scene.labels : []);
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
    e.style.setProperty('--team', teamCss(l.team));
    e.style.fontSize = `${Math.max(11, Math.min(40, 30 * cam.zoom))}px`;
    e.style.transform = `translate(${(l.x - cam.x) * cam.zoom}px, ${(l.y - cam.y) * cam.zoom}px) translate(-50%, -50%)`;
    e.classList.toggle('selected', l.selected);
  });
}

const teamCss = (team) => `rgb(${TEAM_COLORS[team].map((v) => Math.round(v * 255)).join(',')})`;

// ---- Document changes ---------------------------------------------------------------------

let autosaveTimer = 0;
let validateTimer = 0;

function onDocChange(change, { initial = false } = {}) {
  if (change.resized) view.setMap(doc);
  if (change.cells || change.objects || change.resized || change.meta) previewDirty = true;
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
  if ((change.meta || change.objects || change.resized) && activeTab === 'setup') renderSetup();
  updateUndoButtons();
  updateModded();
  if (activeTab === 'history') renderHistory();
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

// ---- Recovery copies ------------------------------------------------------------------------

function recoveryCopies() {
  try {
    const list = JSON.parse(store.get(RECOVERY_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.savedAt === 'number' && r.map) : [];
  } catch {
    return [];
  }
}

/**
 * Keep a copy of the map now and then (and when the page goes away): the
 * last few maps worked on, one copy per map name, so a crash, a closed tab
 * or a "New map" too many loses little. Restored from the History tab.
 */
function saveRecovery() {
  if (!doc) return;
  const map = doc.toMap();
  const list = recoveryCopies().filter((r) => r.map.name !== map.name);
  list.unshift({ savedAt: Date.now(), map });
  for (let n = Math.min(list.length, RECOVERY_COPIES); n > 0; n--) {
    // Large maps may not fit next to the draft: keep fewer copies.
    if (store.set(RECOVERY_KEY, JSON.stringify(list.slice(0, n)))) break;
  }
  if (activeTab === 'history') renderHistory();
}

function updateUndoButtons() {
  const u = $('[data-cmd="undo"]');
  const r = $('[data-cmd="redo"]');
  if (!u || !r) return;
  u.disabled = !doc.canUndo;
  r.disabled = !doc.canRedo;
}

function updateModded() {
  const modded = isModded({ rules: doc.rules });
  $('#modded-badge').hidden = !modded;
  const n = countOverrides(doc.rules);
  const dot = $('#rules-count');
  if (dot) {
    dot.hidden = n === 0;
    dot.textContent = String(n);
  }
}

// ---- Validation -----------------------------------------------------------------------------

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
  const fixes = findFixes(doc, catalog);
  const head = $('#validation-head');
  const bytes = byteLength(text);
  const problems = engine.errors.length + fixes.length;
  head.className = `verdict ${engine.ok ? 'ok' : 'bad'}`;
  head.textContent = engine.ok
    ? `Valid map${js.warnings.length ? `, ${js.warnings.length} warning${js.warnings.length === 1 ? '' : 's'}` : ''}`
    : `${engine.errors.length} error${engine.errors.length === 1 ? '' : 's'}: fix before test play or publishing`;
  $('#validation').replaceChildren(
    openedView(),
    problemsView(
      { engine, issues: js.issues, fixes },
      (p, f) => {
        doc.begin(f.label);
        f.apply(doc);
        doc.commit();
        toast(`${f.label}: done.`);
      },
      (x, y) => view.centerOnCell(x, y),
    ),
  );
  const tab = $('[data-tab="check"]');
  tab.classList.toggle('bad', !engine.ok);
  $('#check-count').hidden = problems === 0;
  $('#check-count').textContent = String(problems);
  renderThumbnail();
  $('#map-stats').textContent =
    `${doc.width} x ${doc.height} cells, ${doc.spawns.length} spawns, ${doc.actors.length} actors, ` +
    `${(bytes / 1024).toFixed(1)} KiB of ${LIMITS.maxBytes / 1024} KiB` +
    (engine.hash ? `, hash ${engine.hash.slice(0, 12)}` : '');
}

/**
 * How the file was opened (map versions, js/upgrade.js): the upgrade notice
 * and the problems of a map opened best effort with their quick fixes, until
 * saved or fixed.
 */
function openedView() {
  const items = [];
  if (opened.notice) items.push(el('li', { class: 'notice' }, el('span', { class: 'issue-text' }, opened.notice)));
  for (const p of opened.problems) {
    const located = Number.isInteger(p.x) && Number.isInteger(p.y);
    const actions = p.fixed
      ? [el('span', { class: 'muted' }, `Fixed: ${p.fixed} (undo with ${keyOf('undo') || 'Ctrl+Z'}).`)]
      : [
          located ? el('button', { type: 'button', class: 'link', onclick: () => view.centerOnCell(p.x, p.y) }, 'Show') : null,
          ...(p.fixes ?? []).map((f) => el('button', { type: 'button', class: 'fix', onclick: () => fixOpened(p, f) }, f.label)),
        ];
    items.push(el('li', { class: p.fixed ? 'ok' : p.fixes?.length ? 'error' : 'warning' }, [el('span', { class: 'issue-text' }, p.message), el('span', { class: 'issue-actions' }, actions)]));
  }
  return items.length ? el('ul', { class: 'issues opened' }, items) : el('span', { hidden: true });
}

function fixOpened(p, fix) {
  let next;
  try {
    next = applyFix(doc.toMap(), fix);
  } catch (err) {
    toast(`This fix cannot be applied: ${err.message}`, true);
    return;
  }
  p.fixed = fix.label;
  doc.replace(next, fix.label);
}

/** The map list's thumbnail of this map (protocol mapThumbnail, as the server draws it). */
function renderThumbnail() {
  const canvas = $('#map-thumb');
  if (!canvas) return;
  const map = doc.toMap();
  const { width, height, rgba } = mapThumbnail(map);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  // Its magnifier shows the map as a game draws it (read on the first hover after a change).
  if (thumbLens) {
    if (thumbLens.image !== canvas) thumbLens.attach(canvas);
    const json = JSON.stringify(map);
    thumbLens.setSource(json, (lensArt) => lensArt.fromMap(json), { width, height });
  }
}

function renderFairness() {
  const box = $('#fairness');
  if (!box || !preview.game) return;
  let report = null;
  try {
    report = JSON.parse(preview.game.editor_report());
  } catch (err) {
    box.replaceChildren(el('p', { class: 'error' }, `The checks failed: ${err.message ?? err}`));
    return;
  }
  box.replaceChildren(fairnessView(report, (k) => teamCss(teamOf(k)), (k) => view.centerOnCell(doc.spawns[k][0] + 1, doc.spawns[k][1] + 2)));
}

// ---- Top bar ---------------------------------------------------------------------------------

/** A button for a command: its icon, its label, and a tooltip with its key. */
function commandButton(name, { icon, label, text = true, primary = false } = {}) {
  const cmd = COMMANDS.find((c) => c.name === name);
  const b = el('button', { type: 'button', class: `cmd${primary ? ' primary' : ''}${text ? '' : ' icon-only'}`, 'data-cmd': name, 'aria-label': label ?? cmd.label, onclick: () => run(name) }, [
    icon ? editorIcon(icon) : null,
    text ? el('span', {}, label ?? cmd.label) : null,
  ]);
  tips.push(attachTooltip(b, () => ({ title: cmd.label, hotkey: keyOf(name) })));
  return b;
}

/** The key bound to a tool or command now, formatted, or ''. */
function keyOf(id) {
  const k = keys.bindingsFor(actionName(id))[0];
  return k ? formatCombo(k) : '';
}

function buildTopbar() {
  const file = el('div', { class: 'group', role: 'group', 'aria-label': 'File' }, [
    commandButton('new', { label: 'New' }),
    commandButton('open', { label: 'Open' }),
    commandButton('save', { label: 'Save' }),
    commandButton('png', { label: 'PNG' }),
  ]);
  const edit = el('div', { class: 'group', role: 'group', 'aria-label': 'Edit' }, [
    commandButton('undo', { icon: 'undo', text: false }),
    commandButton('redo', { icon: 'redo', text: false }),
  ]);
  const map = el('div', { class: 'group', role: 'group', 'aria-label': 'Map' }, [
    el('button', { type: 'button', class: 'cmd', onclick: () => sizeDialog(), title: 'Resize, crop, shift, turn or mirror the map' }, 'Size'),
  ]);
  $('#commands').append(file, edit, map);
  $('#actions').append(
    commandButton('test', { icon: 'play', label: 'Test play', primary: true }),
    commandButton('publish', { icon: 'upload', label: 'Publish' }),
    commandButton('help', { icon: 'help', text: false }),
    el('button', { type: 'button', class: 'cmd icon-only panels-toggle', 'aria-label': 'Panels', 'aria-expanded': 'false', onclick: (e) => togglePanels(e.currentTarget) }, editorIcon('panels')),
  );
}

/** Phones: the side panels slide over the map. */
function togglePanels(button) {
  const open = document.body.classList.toggle('panels-open');
  button.setAttribute('aria-expanded', String(open));
}

// ---- Tools ------------------------------------------------------------------------------------

function buildTools() {
  const root = $('#tools');
  const toolButtons = TOOLS.filter((t) => t.id !== 'paste').map((t) => {
    const b = el('button', { type: 'button', class: 'tool', 'data-tool': t.id, 'aria-label': t.label, onclick: () => setTool(t.id) }, [editorIcon(t.icon), el('span', { class: 'tool-label' }, t.label)]);
    tips.push(attachTooltip(b, () => ({ title: t.label, hotkey: keyOf(`tool.${t.id}`), desc: t.hint }), { side: 'right' }));
    return b;
  });
  const paint = segmented({ name: 'paint-layer', label: 'Paint', options: PAINT_LAYERS, value: state.paint, block: true, onChange: (v) => setPaint(v) });
  paint.root.id = 'paint-layer';
  const materials = MATERIALS.map((m, k) => {
    const chip = el('i');
    chip.style.setProperty('--swatch', m.color);
    const b = el('button', { type: 'button', class: 'swatch', 'data-material': String(m.t), 'aria-label': TERRAIN_NAMES[m.t], onclick: () => setMaterial(m.t) }, [chip, el('span', {}, TERRAIN_NAMES[m.t])]);
    tips.push(attachTooltip(b, () => ({ title: TERRAIN_NAMES[m.t], hotkey: keyOf(`material.${k}`), desc: MATERIAL_HINTS[m.t] })));
    return b;
  });
  const sizes = segmented({ name: 'brush-size', label: 'Brush size', options: BRUSH_SIZES.map((n) => ({ value: String(n), label: String(n) })), value: String(state.size), block: true, onChange: (v) => setSize(Number(v)) });
  sizes.root.id = 'brush-size';
  const ore = slider({ id: 'ore-density', label: 'Ore density', min: 1, max: LIMITS.maxOre, value: state.ore, format: (v) => `${v} / ${LIMITS.maxOre}`, onInput: (v) => setOre(v) });
  const gems = slider({ id: 'gem-density', label: 'Gem density', min: 1, max: LIMITS.maxGems, value: state.gems, format: (v) => `${v} / ${LIMITS.maxGems}`, onInput: (v) => setGems(v) });
  const fillShapes = toggle({ id: 'shape-fill', label: 'Filled', hint: 'Rectangles and ellipses filled, or only their border.', checked: state.shapeFill, onChange: (on) => setPref('shapeFill', on) });
  const shore = toggle({ id: 'auto-shore', label: 'Beaches along water', hint: 'Painting water turns the land next to it into beach.', checked: state.autoShore, onChange: (on) => setPref('autoShore', on) });
  const symmetry = el('select', { id: 'symmetry', class: 'ui-input', 'aria-label': 'Symmetry', onchange: () => setSymmetry(symmetry.value) }, SYMMETRY_MODES.map((m) => el('option', { value: m.id }, m.label)));
  const pasteLayer = (key, label) => toggle({ label, checked: state.pasteLayers[key], small: true, onChange: (on) => (state.pasteLayers[key] = on) }).row;
  root.append(
    el('div', { class: 'tool-list', role: 'toolbar', 'aria-label': 'Tools' }, toolButtons),
    el('div', { class: 'tool-options' }, [
      el('section', { class: 'opt', 'data-for': 'brush line rect ellipse fill' }, [el('h2', {}, 'Paint'), paint.root]),
      el('section', { class: 'opt', 'data-for': 'brush line rect ellipse fill', 'data-paint': 'terrain' }, [el('h2', {}, 'Terrain'), el('div', { class: 'swatches' }, materials)]),
      el('section', { class: 'opt', 'data-for': 'brush line eraser' }, [el('h2', {}, 'Brush size'), sizes.root]),
      el('section', { class: 'opt', 'data-for': 'brush line rect ellipse fill', 'data-paint': 'ore' }, [ore.row, el('p', { class: 'hint' }, 'Ore lies on clear or rough ground and roads. It grows back and spreads when the lobby allows ore regrowth.')]),
      el('section', { class: 'opt', 'data-for': 'brush line rect ellipse fill', 'data-paint': 'gems' }, [gems.row, el('p', { class: 'hint' }, 'Gems pay twice as much as ore and never grow back.')]),
      el('section', { class: 'opt', 'data-for': 'rect ellipse' }, [fillShapes.row]),
      el('section', { class: 'opt', 'data-for': 'brush line rect ellipse fill', 'data-paint': 'terrain' }, [shore.row]),
      el('section', { class: 'opt', 'data-for': 'actor' }, [el('h2', {}, 'Actor'), el('p', { id: 'actor-pick', class: 'hint' }), el('p', { class: 'hint' }, ['Facing ', el('span', { id: 'facing-value' })])]),
      el('section', { class: 'opt', 'data-for': 'region' }, [
        el('h2', {}, 'Region'),
        el('p', { id: 'region-info', class: 'hint' }),
        el('div', { class: 'row wrap' }, [
          el('button', { type: 'button', onclick: () => run('copy') }, 'Copy'),
          el('button', { type: 'button', onclick: () => run('cut') }, 'Cut'),
          el('button', { type: 'button', onclick: () => run('delete') }, 'Clear'),
          el('button', { type: 'button', onclick: () => saveStamp() }, 'Save as stamp'),
          el('button', { type: 'button', onclick: () => cropToRegion() }, 'Crop map'),
        ]),
      ]),
      el('section', { class: 'opt', 'data-for': 'paste' }, [
        el('h2', {}, 'Paste'),
        el('p', { id: 'clip-info', class: 'hint' }),
        el('div', { class: 'row wrap' }, [
          el('button', { type: 'button', onclick: () => run('turnClip') }, 'Turn'),
          el('button', { type: 'button', onclick: () => run('mirrorClipX') }, 'Mirror'),
          el('button', { type: 'button', onclick: () => run('mirrorClipY') }, 'Flip'),
        ]),
        pasteLayer('terrain', 'Terrain'),
        pasteLayer('resources', 'Ore and gems'),
        pasteLayer('actors', 'Actors'),
      ]),
      el('section', { class: 'opt always' }, [el('h2', {}, 'Symmetry'), symmetry, el('p', { id: 'symmetry-note', class: 'hint' })]),
      el('p', { id: 'tool-hint', class: 'hint' }),
    ]),
  );
  syncTools();
}

function syncTools() {
  document.querySelectorAll('[data-tool]').forEach((b) => {
    const on = b.dataset.tool === state.tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-material]').forEach((b) => b.classList.toggle('active', Number(b.dataset.material) === state.material));
  document.querySelectorAll('#tools .opt').forEach((o) => {
    if (o.classList.contains('always')) return;
    const forTool = o.dataset.for.split(' ').includes(state.tool);
    const forPaint = !o.dataset.paint || o.dataset.paint === state.paint || !TOOLS.find((t) => t.id === state.tool)?.paint;
    o.hidden = !forTool || !forPaint;
  });
  $('#paint-layer') && document.querySelectorAll('#paint-layer input').forEach((i) => (i.checked = i.value === state.paint));
  document.querySelectorAll('#brush-size input').forEach((i) => (i.checked = Number(i.value) === state.size));
  $('#symmetry').value = state.symmetry;
  for (const o of $('#symmetry').options) o.disabled = !modeFits(o.value, doc.width, doc.height);
  $('#symmetry-note').textContent = modeFits(state.symmetry, doc.width, doc.height) ? '' : 'This map is not square: the quarter turns and diagonals are left out.';
  $('#facing-value').textContent = `${state.facing} / 1024 (, and . turn it)`;
  const info = state.actorType ? catalog[state.actorType] : null;
  $('#actor-pick').textContent = info ? `${info.name} (${info.id}) for ${ownerName(state.owner)}` : 'Pick an actor in the Actors tab.';
  $('#tool-hint').textContent = TOOLS.find((t) => t.id === state.tool).hint;
  document.querySelectorAll('.palette-item').forEach((b) => b.classList.toggle('active', b.dataset.actor === state.actorType));
  $('#view').dataset.tool = state.tool;
  syncRegion();
}

function syncRegion() {
  const r = state.region;
  const info = $('#region-info');
  if (info) info.textContent = r ? `${r.x1 - r.x0 + 1} x ${r.y1 - r.y0 + 1} cells at ${r.x0},${r.y0}. Drag inside it to move it.` : 'Drag on the map to select cells.';
  const c = state.clip;
  const ci = $('#clip-info');
  if (ci) ci.textContent = c ? `${c.w} x ${c.h} cells, ${c.actors.length} actor${c.actors.length === 1 ? '' : 's'}. Click to paste; right click stops.` : 'Copy a region or pick a stamp.';
}

function setTool(t) {
  ctl.cancel();
  if (t === 'paste' && !state.clip) {
    toast('Copy a region (M, then Ctrl+C) or pick a stamp first.');
    return;
  }
  state.tool = t;
  if (t === 'actor') showTab('actors');
  syncTools();
}

function setPaint(p) {
  state.paint = p;
  if (!TOOLS.find((t) => t.id === state.tool)?.paint) state.tool = 'brush';
  savePrefs();
  syncTools();
}

function setMaterial(t) {
  state.material = t;
  state.paint = 'terrain';
  if (!TOOLS.find((x) => x.id === state.tool)?.paint) state.tool = 'brush';
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
  const r = $('#ore-density');
  if (r && Number(r.value) !== state.ore) r.value = String(state.ore);
  syncTools();
}

function setGems(n) {
  state.gems = Math.max(1, Math.min(LIMITS.maxGems, n));
  savePrefs();
  const r = $('#gem-density');
  if (r && Number(r.value) !== state.gems) r.value = String(state.gems);
  syncTools();
}

function setPref(key, value) {
  state[key] = value;
  savePrefs();
}

function setSymmetry(m) {
  state.symmetry = m;
  savePrefs();
  syncTools();
  toast(`Symmetry: ${SYMMETRY_MODES.find((s) => s.id === m).label}`);
}

/** - and =: the density of the gem paint when it is active, else of the ore paint. */
function stepDensity(d) {
  if (state.paint === 'gems') return setGems(state.gems + d);
  return setOre(state.ore + d);
}

function picked(what) {
  if (what.kind === 'actor') {
    state.tool = 'actor';
    renderOwnerOptions();
    renderPaletteIcons();
    toast(`Picked ${catalog[state.actorType]?.name ?? state.actorType} for ${ownerName(state.owner)}.`);
  } else {
    if (!TOOLS.find((t) => t.id === state.tool)?.paint) state.tool = 'brush';
    toast(what.kind === 'terrain' ? `Picked ${TERRAIN_NAMES[what.terrain]}.` : `Picked ${what.kind}, density ${what.density}.`);
    savePrefs();
  }
  syncTools();
}

// ---- View bar ---------------------------------------------------------------------------------

function buildViewbar() {
  $('#viewbar').append(
    commandButton('zoomIn', { icon: 'zoomIn', text: false }),
    commandButton('zoomOut', { icon: 'zoomOut', text: false }),
    commandButton('fit', { icon: 'fit', text: false }),
  );
}

// ---- Side panels -------------------------------------------------------------------------------

const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'actors', label: 'Actors' },
  { id: 'setup', label: 'Setup' },
  { id: 'layers', label: 'Layers' },
  { id: 'check', label: 'Check', badge: 'check-count' },
  { id: 'rules', label: 'Rules', badge: 'rules-count' },
  { id: 'history', label: 'History' },
  { id: 'stamps', label: 'Stamps' },
  { id: 'online', label: 'Online' },
];
let activeTab = 'map';

function buildPanels() {
  const tabs = $('#side .tabs');
  const panes = $('#panes');
  for (const t of TABS) {
    tabs.append(
      el('button', { type: 'button', role: 'tab', id: `tab-${t.id}`, 'data-tab': t.id, 'aria-controls': `pane-${t.id}`, onclick: () => showTab(t.id) }, [
        t.label,
        t.badge ? el('span', { id: t.badge, class: 'dot', hidden: true }) : null,
      ]),
    );
    panes.append(el('section', { class: 'pane', id: `pane-${t.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`, 'data-pane': t.id, hidden: true }));
  }
  buildMapPane();
  buildActorsPane();
  buildLayersPane();
  buildCheckPane();
  new RulesPanel($('[data-pane="rules"]'), doc, rulesBase);
  buildOnlinePane();
  showTab('map');
}

function showTab(name) {
  activeTab = name;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
  if (name === 'history') renderHistory();
  if (name === 'stamps') renderStamps();
  if (name === 'setup') renderSetup();
  if (name === 'check') analysisDirty = true;
}

// ---- Map pane ----------------------------------------------------------------------------------

function buildMapPane() {
  const pane = $('[data-pane="map"]');
  const field = (key, label, max, multiline = false) => {
    const input = el(multiline ? 'textarea' : 'input', {
      id: `meta-${key}`,
      class: 'ui-input',
      maxlength: String(max),
      rows: multiline ? '4' : undefined,
      oninput: () => {
        doc.begin(`Edit ${label.toLowerCase()}`, `meta.${key}`);
        doc.touchMeta();
        doc.meta[key] = input.value;
        doc.commit();
        if (key === 'author') defaultRegistry().set('extra', 'editorAuthor', input.value);
      },
    });
    return el('label', { class: 'field stacked' }, [el('span', { class: 'label' }, label), input]);
  };
  pane.append(
    el('h2', {}, 'Map'),
    field('name', 'Name', LIMITS.nameMax),
    field('author', 'Author', LIMITS.authorMax),
    field('description', 'Description and briefing', LIMITS.descriptionMax, true),
    tagsField(),
    el('label', { class: 'field stacked', title: 'Terrain look and weather of the map. Not a rules change: the map stays unmodded.' }, [
      el('span', { class: 'label' }, 'Biome'),
      el(
        'select',
        {
          id: 'meta-biome',
          class: 'ui-input',
          onchange: (e) => {
            doc.begin('Edit biome', 'meta.biome');
            doc.touchMeta();
            doc.meta.biome = e.target.value;
            doc.commit();
          },
        },
        BIOME_CHOICES.map((b) => el('option', { value: b.value }, b.label)),
      ),
    ]),
    graphicsControl(),
    el('div', { class: 'row wrap' }, [el('button', { type: 'button', onclick: () => sizeDialog() }, 'Size and turns...'), el('button', { type: 'button', onclick: () => run('new') }, 'New or generate...')]),
    el('p', { id: 'map-stats', class: 'hint' }),
    el('h2', {}, 'Thumbnail'),
    el('canvas', { id: 'map-thumb', class: 'map-thumb', width: '1', height: '1', role: 'img', 'aria-label': 'The thumbnail the map list shows' }),
    el('p', { class: 'hint' }, 'Drawn from the map itself (terrain, ore, actors, spawns in their slot colours), never from installed art: what the community map list shows. Point at it for a closer look in the game\'s art.'),
    el('p', { class: 'hint' }, 'Player slots and the game options the lobby starts with are in the Setup tab. Custom maps carry no scripts.'),
  );
}

/** Tags: comma separated, kept lower case (packages/protocol mapsetup.js). */
function tagsField() {
  const input = el('input', {
    id: 'meta-tags',
    class: 'ui-input',
    placeholder: 'For example: 2 players, naval, islands',
    onchange: () => {
      const tags = parseTags(input.value);
      editSetup(doc, 'Edit tags', (meta) => (meta.tags = tags), 'meta.tags');
      input.value = tags.join(', ');
    },
  });
  return el('label', { class: 'field stacked' }, [el('span', { class: 'label' }, 'Tags'), input, el('span', { class: 'hint' }, 'Up to 8, separated by commas. The map list shows them.')]);
}

/** The Setup tab: player slots and the lobby options the map sets and locks. */
function renderSetup() {
  const pane = $('[data-pane="setup"]');
  const scroll = pane.scrollTop;
  pane.replaceChildren(
    el('h2', {}, 'Player slots'),
    el('p', { class: 'hint' }, 'What each slot holds when the map is loaded in a lobby, slot k starting at spawn k. Locked parts cannot be changed by the players.'),
    slotsView(doc, (k) => teamCss(teamOf(k))),
    el('h2', {}, 'Game options'),
    el('p', { class: 'hint' }, 'The options the lobby starts with on this map. Locked ones cannot be changed by the host; online the server enforces them.'),
    optionsView(doc),
  );
  pane.scrollTop = scroll;
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
    block: true,
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
      ? "The original Red Alert graphics are not installed on this device: install them from the game's Original content dialog to edit with them."
      : art.originalActive
        ? 'The map is drawn with the original Red Alert graphics, as in a game with Graphics set to Original.'
        : "The map is drawn with WebRA's own art. The choice is the game's Graphics setting.";
  }
}

function syncMetaFields() {
  for (const k of ['name', 'author', 'description']) {
    const input = $(`#meta-${k}`);
    if (input && input.value !== doc.meta[k]) input.value = doc.meta[k];
  }
  const tags = $('#meta-tags');
  if (tags && document.activeElement !== tags) tags.value = (doc.meta.tags ?? []).join(', ');
  const biome = $('#meta-biome');
  if (biome && biome.value !== (doc.meta.biome ?? 'temperate')) biome.value = doc.meta.biome ?? 'temperate';
  filterPalette();
  if ($('#symmetry')) syncTools();
}

// ---- Actors pane ------------------------------------------------------------------------------

function ownerName(owner) {
  return owner < 0 ? 'neutral' : `spawn ${owner + 1}`;
}

function buildActorsPane() {
  const pane = $('[data-pane="actors"]');
  const owner = el('select', {
    id: 'owner',
    class: 'ui-input',
    onchange: () => {
      state.owner = Number(owner.value);
      renderPaletteIcons();
      syncTools();
    },
  });
  const search = el('input', { type: 'search', id: 'palette-search', class: 'ui-input', placeholder: 'Find an actor', 'aria-label': 'Find an actor', oninput: () => filterPalette() });
  const groups = PALETTE_GROUPS.map((g) => {
    const actors = Object.values(catalog).filter(g.test);
    if (!actors.length) return null;
    return el('details', { class: 'palette-group', open: !['Fakes', 'Husks', 'Decorations', 'Civilians', 'Other structures'].includes(g.name) }, [
      el('summary', {}, `${g.name} (${actors.length})`),
      el(
        'div',
        { class: 'palette' },
        actors.map((a) => {
          const b = el(
            'button',
            {
              type: 'button',
              class: 'palette-item',
              'data-actor': a.id,
              'aria-label': a.name,
              onclick: () => {
                state.actorType = a.id;
                setTool('actor');
              },
            },
            [el('canvas', { width: '64', height: '48' }), el('span', {}, a.name)],
          );
          tips.push(attachTooltip(b, () => ({ title: a.name, desc: `${a.id}${a.kind === 'building' ? `, ${a.width} x ${a.height} cells` : ''}${a.description ? `. ${a.description}` : ''}` })));
          return b;
        }),
      ),
    ]);
  });
  pane.append(
    el('div', { id: 'selection-box' }),
    el('h2', {}, 'Place for'),
    owner,
    el('p', { class: 'hint' }, 'Pre-placed actors belong to a spawn (the player who starts there) or are neutral, like the civilians and trees of OpenRA maps.'),
    search,
    ...groups,
  );
  renderOwnerOptions();
  renderPaletteIcons();
  filterPalette();
}

/** Hide palette actors that do not belong to the map's biome (OpenRA MapEditorData tilesets) or do not match the search. */
function filterPalette() {
  const biome = doc.meta.biome ?? 'temperate';
  const q = ($('#palette-search')?.value ?? '').trim().toLowerCase();
  document.querySelectorAll('.palette-item').forEach((b) => {
    const a = catalog[b.dataset.actor];
    const biomes = a?.world?.biomes;
    const bridge = a?.world?.bridge;
    const wrongBiome = (Array.isArray(biomes) && !biomes.includes(biome)) || (!!bridge && !bridge[biome]);
    const miss = q && !`${a.name} ${a.id}`.toLowerCase().includes(q);
    b.hidden = wrongBiome || !!miss;
  });
  document.querySelectorAll('.palette-group').forEach((g) => {
    g.hidden = ![...g.querySelectorAll('.palette-item')].some((b) => !b.hidden);
    if (q && !g.hidden) g.open = true;
  });
}

function renderOwnerOptions() {
  const fog = $('#fog-spawn');
  if (fog) {
    if (state.fogSpawn >= doc.spawns.length) state.fogSpawn = 0;
    fog.replaceChildren(...doc.spawns.map((_, k) => el('option', { value: String(k) }, `Spawn ${k + 1}`)));
    fog.value = String(state.fogSpawn);
  }
  const owner = $('#owner');
  if (!owner) return;
  if (state.owner >= doc.spawns.length) state.owner = -1;
  owner.replaceChildren(el('option', { value: '-1' }, 'Neutral'), ...doc.spawns.map((_, k) => el('option', { value: String(k) }, `Spawn ${k + 1}`)));
  owner.value = String(state.owner);
}

/** Palette pictures in the owner's colour, from the art in use (js/art.js paintPalette). */
function renderPaletteIcons() {
  const team = TEAM_COLORS[teamOf(state.owner)];
  document.querySelectorAll('.palette-item').forEach((b) => {
    const actor = catalog[b.dataset.actor];
    b.dataset.art = art.paintPalette(b.querySelector('canvas'), actor, ctl.order.get(actor.id) ?? -1, team);
  });
}

/** The selected actors' properties (owner, facing) or the selected spawn. */
let selectionKey = '';
function renderSelection() {
  const box = $('#selection-box');
  if (!box) return;
  const sel = [...ctl.selection];
  // While a control of the box is in use (a slider being dragged), its own changes do not rebuild it.
  const key = `${ctl.selectedSpawn}|${sel.map((a) => `${a.type}@${a.x},${a.y}`).join('|')}`;
  if (key === selectionKey && box.contains(document.activeElement) && document.activeElement.type === 'range') return;
  selectionKey = key;
  if (!sel.length && ctl.selectedSpawn < 0) {
    box.replaceChildren();
    return;
  }
  if (!sel.length) {
    const k = ctl.selectedSpawn;
    const [x, y] = doc.spawns[k];
    const owned = doc.actors.filter((a) => a.owner === k).length;
    box.replaceChildren(
      el('h2', {}, `Spawn ${k + 1}`),
      el('p', {}, `At ${x},${y}. ${owned} pre-placed actor${owned === 1 ? '' : 's'} belong to it.`),
      el('div', { class: 'row' }, [el('button', { type: 'button', class: 'danger', onclick: () => ctl.deleteSelection() }, 'Remove spawn')]),
    );
    return;
  }
  const owners = new Set(sel.map((a) => a.owner));
  const owner = el(
    'select',
    { class: 'ui-input', onchange: () => ctl.setOwnerOfSelection(Number(owner.value)) },
    [el('option', { value: '-1' }, 'Neutral'), ...doc.spawns.map((_, k) => el('option', { value: String(k) }, `Spawn ${k + 1}`))],
  );
  owner.value = owners.size === 1 ? String([...owners][0]) : '';
  const units = sel.filter((a) => catalog[a.type]?.kind !== 'building');
  const facings = new Set(units.map((a) => a.facing));
  const facing = slider({
    label: 'Facing',
    min: 0,
    max: 1023,
    step: 32,
    value: facings.size === 1 ? [...facings][0] : 0,
    format: (v) => `${v} (${['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(v / 128) % 8]})`,
    onInput: (v) => ctl.setOnSelection('Change facing', (a, info) => info?.kind !== 'building' && (a.facing = v)),
  });
  const names = sel.length === 1 ? `${catalog[sel[0].type]?.name ?? sel[0].type} at ${sel[0].x},${sel[0].y}` : `${sel.length} actors`;
  box.replaceChildren(
    el('h2', {}, 'Selection'),
    el('p', {}, names),
    el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Owner'), owner]),
    units.length ? facing.row : null,
    actorStateView(sel, catalog, ctl),
    el('div', { class: 'row' }, [el('button', { type: 'button', class: 'danger', onclick: () => ctl.deleteSelection() }, `Delete (${keyOf('delete')})`)]),
  );
}

// ---- Layers pane ---------------------------------------------------------------------------------

function buildLayersPane() {
  const pane = $('[data-pane="layers"]');
  const fogSpawn = el('select', { id: 'fog-spawn', class: 'ui-input', 'aria-label': 'Fog preview of spawn', onchange: () => (state.fogSpawn = Number(fogSpawn.value)) });
  pane.append(
    el('h2', {}, 'Show on the map'),
    layersList(state.layers, (key, on) => setLayer(key, on)),
    el('label', { class: 'field stacked' }, [el('span', { class: 'label' }, 'Fog preview of'), fogSpawn]),
    el('p', { class: 'hint' }, 'Passability, buildable ground, zones, rush paths and reach are measured by the game engine on the map as a game starts it (trees, structures and walls block).'),
  );
}

function setLayer(key, on) {
  state.layers[key] = on;
  if (ANALYSIS_LAYERS.includes(key)) analysisDirty = true;
  savePrefs();
  const box = document.querySelectorAll('.layers input')[LAYERS.findIndex((l) => l.key === key)];
  if (box && box.checked !== on) box.checked = on;
}

// ---- Check pane ---------------------------------------------------------------------------------

function buildCheckPane() {
  $('[data-pane="check"]').append(
    el('h2', {}, 'Problems'),
    el('div', { id: 'validation-head', class: 'verdict' }),
    el('div', { id: 'validation' }),
    el('p', { class: 'hint' }, 'Checked by the game engine. Show jumps to the place; the buttons repair it as one undo step.'),
    el('h2', {}, 'Fairness'),
    el('div', { id: 'fairness' }),
  );
}

// ---- History pane --------------------------------------------------------------------------------

function renderHistory() {
  const pane = $('[data-pane="history"]');
  const copies = recoveryCopies();
  pane.replaceChildren(
    el('h2', {}, 'History'),
    historyList(doc.undoStack, doc.redoStack, (steps) => goHistory(steps)),
    el('p', { class: 'hint' }, `Up to 200 steps. Your draft is saved in this browser as you work.`),
    el('h2', {}, 'Recovery copies'),
    copies.length
      ? el(
          'ul',
          { class: 'recovery' },
          copies.map((c) =>
            el('li', {}, [
              el('span', {}, `${c.map.name || 'Untitled'}, ${c.map.width} x ${c.map.height}, ${new Date(c.savedAt).toLocaleString()}`),
              el('button', { type: 'button', class: 'link', onclick: () => loadMap(c.map, `Restore ${c.map.name || 'copy'}`) && toast('Restored. Undo brings back the map you had.') }, 'Restore'),
            ]),
          ),
        )
      : el('p', { class: 'hint' }, 'Copies of the maps you work on are kept every two minutes and when the page closes.'),
  );
}

function goHistory(steps) {
  for (let i = 0; i < Math.abs(steps); i++) (steps < 0 ? doc.undo() : doc.redo());
  toast(steps < 0 ? `Back ${-steps} step${steps === -1 ? '' : 's'}.` : `Forward ${steps} step${steps === 1 ? '' : 's'}.`);
}

// ---- Stamps --------------------------------------------------------------------------------------

function loadStamps() {
  try {
    const list = JSON.parse(store.get(STAMPS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((s) => s && typeof s.name === 'string' && s.region) : [];
  } catch {
    return [];
  }
}

function saveStamps(list) {
  if (!store.set(STAMPS_KEY, JSON.stringify(list))) toast('The stamps could not be saved (browser storage is full or blocked).', true);
}

async function saveStamp() {
  const r = state.region;
  if (!r) return toast('Select a region first (M).');
  const name = el('input', { class: 'ui-input', maxlength: '40', value: `Stamp ${loadStamps().length + 1}` });
  const ok = await modal({ title: 'Save as stamp', body: [el('label', { class: 'field stacked' }, [el('span', { class: 'label' }, 'Name'), name])], buttons: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', primary: true }] });
  if (ok !== 'ok') return;
  const list = loadStamps();
  if (list.length >= STAMPS_MAX) return toast(`At most ${STAMPS_MAX} stamps: delete one first.`, true);
  list.push({ name: name.value.trim() || 'Stamp', savedAt: Date.now(), region: regionToData(copyRegion(doc, catalog, r.x0, r.y0, r.x1, r.y1)) });
  saveStamps(list);
  toast('Saved as a stamp (Stamps tab).');
  if (activeTab === 'stamps') renderStamps();
}

function renderStamps() {
  const pane = $('[data-pane="stamps"]');
  const list = loadStamps();
  pane.replaceChildren(
    el('h2', {}, 'Stamps'),
    el('p', { class: 'hint' }, 'Regions you saved: bases, bridges with their banks, ore fields, villages. They are kept in this browser.'),
    stampsList(list, {
      onUse: (k) => {
        try {
          startPaste(regionFromData(list[k].region));
        } catch (err) {
          toast(`This stamp cannot be used: ${err.message}`, true);
        }
      },
      onRename: async (k) => {
        const name = el('input', { class: 'ui-input', maxlength: '40', value: list[k].name });
        if ((await modal({ title: 'Rename stamp', body: [name], buttons: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Rename', primary: true }] })) !== 'ok') return;
        list[k].name = name.value.trim() || list[k].name;
        saveStamps(list);
        renderStamps();
      },
      onDelete: (k) => {
        list.splice(k, 1);
        saveStamps(list);
        renderStamps();
      },
    }),
  );
}

function startPaste(clip) {
  state.clip = clip;
  setTool('paste');
}

// ---- Online pane -----------------------------------------------------------------------------------

function buildOnlinePane() {
  const pane = $('[data-pane="online"]');
  pane.append(
    el('h2', {}, 'Publish'),
    el('p', { class: 'hint' }, 'Upload the map so others can play it. Published maps are public and identified by their hash. Only the map data is sent, never pictures or installed graphics.'),
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
    out.replaceChildren(el('p', { class: 'error' }, 'Fix the problems first (Check tab).'));
    showTab('check');
    return;
  }
  if (engine.modded && !confirm(`${MODDED_WARNING}\n\nPublish this MODDED map anyway?`)) return;
  out.replaceChildren(el('p', { class: 'hint' }, 'Publishing...'));
  try {
    const { id, hash, localHash } = await publishMap(map);
    const link = shareLink(id);
    const linkInput = el('input', { type: 'text', class: 'ui-input', readonly: 'readonly', value: link, onfocus: () => linkInput.select() });
    out.replaceChildren(
      el('p', { class: 'ok' }, `Published. Map id: ${id}`),
      el('div', { class: 'row' }, [linkInput, el('button', { type: 'button', onclick: () => copy(link) }, 'Copy link')]),
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
          typeof m.thumbnail === 'string' && m.thumbnail.startsWith('/api/maps/') ? el('img', { class: 'map-thumb', src: m.thumbnail, alt: '', loading: 'lazy' }) : null,
          el('div', { class: 'title' }, [String(m.name ?? m.id), m.modded ? el('span', { class: 'badge modded' }, 'MODDED') : null]),
          Array.isArray(m.tags) && m.tags.length ? el('div', { class: 'muted' }, m.tags.join(', ')) : null,
          el('div', { class: 'muted' }, `${m.author ?? '?'}, ${m.width}x${m.height}, ${m.players} players, ${m.downloads ?? 0} downloads`),
          el('div', { class: 'row' }, [el('button', { type: 'button', onclick: () => openPublished(m) }, 'Open'), el('button', { type: 'button', class: 'link', onclick: () => copy(shareLink(m.id)) }, 'Copy play link')]),
        ]),
      ),
    ),
  );
}

async function openPublished(m) {
  try {
    const { map } = await fetchMap(m.id, m.hash);
    loadMap(map, `Open ${m.name}`, `Opened "${map.name}".`);
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

// ---- Commands ---------------------------------------------------------------------------------------

/**
 * Open a parsed map file (any format version, js/upgrade.js) as one undoable
 * step. `done` is the toast on success; the upgrade notice or the reason a
 * map is not compatible goes with it and stays in the Check tab until saved.
 */
function loadMap(raw, label, done = null) {
  const next = openMapFile(raw);
  if (!next.map) {
    toast(`Cannot open this map: ${next.error}`, true);
    return false;
  }
  const res = validateMap(next.map, { catalog, rulesBase });
  try {
    doc.replace(next.map, label);
  } catch (err) {
    toast(`Cannot open this map: ${err.message}`, true);
    return false;
  }
  opened = { notice: next.notice ?? null, problems: next.problems ?? [] };
  runValidation();
  ctl.selection.clear();
  ctl.setRegion(null);
  view.fit();
  if (next.notice) toast([done, next.notice].filter(Boolean).join(' '), next.status !== 'upgraded');
  else if (!res.ok) toast(`${done ?? ''} It has ${res.errors.length} problem(s); see the Check tab.`.trim(), true);
  else if (done) toast(done);
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
    loadMap(map, `Open ${file.name}`, `Opened ${file.name}.`);
  });
}

/**
 * Import an OpenRA .oramap package: convert it (js/oramap), show the import
 * report, and open the result for editing once the author confirms. Rules
 * the conversion kept make a modded map; the report repeats the modded
 * warning, and the author may open the map without them. Lua scripts are
 * never imported (custom maps carry no scripts).
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
    loadMap(m, `Import ${report.title}`, `Imported "${report.title}".`);
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
      el('div', { class: 'row end' }, buttons),
    ]),
  ]);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function saveFile() {
  const map = doc.toMap();
  // A file of the current format, stamped with this release (docs/contracts.md "Map versions").
  download(new Blob([mapFileText(map)], { type: 'application/json' }), mapFileName(map.name));
  // Saved: the upgrade (or repair) is kept now.
  opened = { notice: null, problems: opened.problems.filter((p) => !p.fixed) };
  runValidation();
  toast('Map downloaded.');
}

function exportPng() {
  const scale = Math.max(1, Math.min(8, Math.floor(1024 / Math.max(doc.width, doc.height))));
  previewCanvas(doc, catalog, scale).toBlob((blob) => {
    if (blob) download(blob, mapFileName(doc.meta.name).replace(/\.webra-map\.json$/, '.png'));
  }, 'image/png');
}

let lastTest = null;
async function testPlay() {
  const { map, engine } = validateNow();
  if (!engine.ok && !confirm(`The map has problems:\n\n${engine.errors.join('\n')}\n\nThe game may refuse it. Test anyway?`)) return;
  const setup = await testPlayDialog({ spawns: doc.spawns.length, last: lastTest, setup: doc.meta });
  if (!setup) return;
  lastTest = setup;
  const r = view.viewRect();
  const text = canonicalJson(map);
  try {
    sessionStorage.setItem(TEST_MAP_KEY, text);
    sessionStorage.setItem(
      TEST_SETUP_KEY,
      JSON.stringify({ players: setup.players, movement: setup.movement, camera: setup.camera ? [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2] : null, autostart: setup.autostart }),
    );
  } catch {
    toast('Cannot hand the map to the game: browser storage is blocked.', true);
    return;
  }
  // window.open copies sessionStorage into the new tab (no noopener on purpose).
  const url = new URL('./?editorTest=1', document.baseURI).href;
  if (!window.open(url, '_blank')) location.href = url;
}

async function newMap() {
  let choice;
  try {
    choice = await newMapDialog({ width: doc.width, height: doc.height, materials: MATERIALS.map((m) => m.t), generator: typeof Game.generated_map_with === 'function' });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (!choice) return;
  saveRecovery();
  let map;
  if (choice.kind === 'generated') {
    map = JSON.parse(Game.generated_map_with(choice.seed, choice.size, choice.players, choice.style, choice.biome, choice.tech));
    map.author = defaultRegistry().get('extra', 'editorAuthor') || map.author;
  } else {
    map = newBlankMap(choice.width, choice.height, choice.base);
  }
  loadMap(map, 'New map');
}

async function sizeDialog() {
  const choice = await mapSizeDialog({ width: doc.width, height: doc.height, region: state.region });
  if (!choice) return;
  applyTransform(choice);
}

function cropToRegion() {
  if (!state.region) return toast('Select a region first (M).');
  applyTransform({ op: 'crop' });
}

/** Resize, crop, shift, turn or mirror the whole map as one undo step. */
function applyTransform(choice) {
  const map = doc.toMap();
  let result;
  try {
    if (choice.op === 'resize') {
      const ox = Math.round((choice.width - map.width) * choice.anchorX);
      const oy = Math.round((choice.height - map.height) * choice.anchorY);
      result = resizeMap(map, catalog, choice.width, choice.height, ox, oy);
    } else if (choice.op === 'crop') {
      const r = state.region;
      result = cropMap(map, catalog, r.x0, r.y0, r.x1, r.y1);
    } else if (choice.op === 'shift') {
      result = shiftMap(map, catalog, choice.dx, choice.dy);
    } else {
      result = turnMap(map, catalog, choice.op);
    }
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const label = { resize: 'Resize map', crop: 'Crop map', shift: 'Shift map', rotate90: 'Turn map right', rotate270: 'Turn map left', rotate180: 'Turn map', flipX: 'Mirror map', flipY: 'Flip map' }[choice.op];
  if (loadMap(result.map, label)) {
    const d = result.dropped;
    const lost = [d.spawns ? `${d.spawns} spawn${d.spawns === 1 ? '' : 's'}` : '', d.actors ? `${d.actors} actor${d.actors === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    toast(lost ? `${label}: ${lost} off the map were removed. Undo brings them back.` : `${label}.`);
  }
}

function helpOverlay() {
  if ($('#help')) return $('#help').close();
  let listening = null;
  const body = el('div', {});
  const render = () =>
    body.replaceChildren(
      el('p', {}, 'Tools paint with symmetry: every edit also lands at its mirror images. Right drag undoes what a tool does (paints clear ground, removes ore). Middle drag, Space and drag, two fingers or the arrow keys move the map; the wheel and pinching zoom.'),
      keysList(keys.list().filter((a) => a.context === 'editor'), {
        listening,
        mac: isMac(),
        onRebind: (name) => {
          listening = name;
          render();
        },
        onReset: (name) => {
          keys.reset(name);
          render();
        },
      }),
      el('p', { class: 'hint' }, 'Keys are kept with the game\'s (game menu, Settings, Controls) and follow your account.'),
    );
  const capture = (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      listening = null;
      render();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    const reserved = isReservedCombo(combo);
    if (reserved) {
      toast(reserved, true);
      return;
    }
    const r = keys.rebind(listening, combo);
    if (r.displaced) toast(`${formatCombo(combo)} moved from "${keys.list().find((a) => a.name === r.displaced)?.label}".`);
    listening = null;
    render();
  };
  render();
  modal({
    id: 'help',
    title: 'Shortcuts',
    wide: true,
    body: [body],
    buttons: [{ value: 'close', label: 'Close', primary: true }],
    onOpen: (dialog) => dialog.addEventListener('keydown', capture, true),
  });
}

/** Copy the region to the clipboard (Ctrl+C), also for Cut. */
function copyRegionCmd(cut) {
  const r = state.region;
  if (!r) return toast('Select a region first (M).');
  state.clip = copyRegion(doc, catalog, r.x0, r.y0, r.x1, r.y1);
  if (cut) {
    doc.begin('Cut region');
    clearRegion(doc, catalog, r.x0, r.y0, r.x1, r.y1);
    doc.commit();
  }
  syncRegion();
  toast(`${cut ? 'Cut' : 'Copied'} ${state.clip.w} x ${state.clip.h} cells. Ctrl+V pastes.`);
}

function transformClip(op) {
  if (!state.clip) return;
  state.clip = transformRegion(state.clip, catalog, op);
  syncRegion();
}

const COMMAND_RUN = {
  new: newMap,
  open: () => $('#file-input').click(),
  save: saveFile,
  png: exportPng,
  test: testPlay,
  publish,
  undo: () => {
    const label = doc.undo();
    if (label) toast(`Undo: ${label}`);
  },
  redo: () => {
    const label = doc.redo();
    if (label) toast(`Redo: ${label}`);
  },
  copy: () => copyRegionCmd(false),
  cut: () => copyRegionCmd(true),
  paste: () => (state.clip ? setTool('paste') : toast('Nothing copied yet.')),
  delete: () => ctl.deleteSelection(),
  selectAll: () => {
    setTool('select');
    ctl.selectAll();
  },
  turnClip: () => transformClip('rotate'),
  mirrorClipX: () => transformClip('flipX'),
  mirrorClipY: () => transformClip('flipY'),
  rotateLeft: () => {
    ctl.rotate(-1);
    syncTools();
  },
  rotateRight: () => {
    ctl.rotate(1);
    syncTools();
  },
  sizeDown: () => setSize(BRUSH_SIZES[Math.max(0, BRUSH_SIZES.indexOf(state.size) - 1)]),
  sizeUp: () => setSize(BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, BRUSH_SIZES.indexOf(state.size) + 1)]),
  densityDown: () => stepDensity(-1),
  densityUp: () => stepDensity(1),
  paintTerrain: () => setPaint('terrain'),
  paintOre: () => setPaint('ore'),
  paintGems: () => setPaint('gems'),
  symmetry: () => {
    const usable = SYMMETRY_MODES.filter((m) => modeFits(m.id, doc.width, doc.height));
    const i = usable.findIndex((s) => s.id === state.symmetry);
    setSymmetry(usable[(i + 1) % usable.length].id);
  },
  zoomIn: () => view.zoomBy(1.25),
  zoomOut: () => view.zoomBy(0.8),
  fit: () => view.fit(),
  grid: () => setLayer('grid', !state.layers.grid),
  layerPassability: () => setLayer('passability', !state.layers.passability),
  layerZones: () => setLayer('zones', !state.layers.zones),
  help: helpOverlay,
};

function run(name) {
  COMMAND_RUN[name]?.();
}

function bindDrop() {
  $('#file-input').addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    openFile(e.dataTransfer?.files?.[0]);
  });
}

// ---- Keyboard ---------------------------------------------------------------------------------------

/**
 * Every tool, terrain and command is an action of the hotkey registry
 * (context "editor"): rebindable in the Shortcuts dialog, kept with the
 * game's keys. Escape always cancels; Space held pans (js/view.js).
 */
function bindKeys() {
  const reg = (id, label, group, defaults, fn) => keys.registerAction(actionName(id), defaults, fn, { label, group: `Map editor: ${group}`, context: 'editor' });
  for (const t of TOOLS) if (t.key) reg(`tool.${t.id}`, t.label, 'Tools', [t.key], () => setTool(t.id));
  MATERIALS.forEach((m, k) => reg(`material.${k}`, TERRAIN_NAMES[m.t], 'Terrain', [MATERIAL_KEYS[k]], () => setMaterial(m.t)));
  for (const c of COMMANDS) reg(c.name, c.label, c.group, c.keys, () => run(c.name));
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      if (!ctl.cancel()) {
        if (state.tool === 'paste') setTool('region');
        ctl.selection.clear();
        ctl.selectedSpawn = -1;
        ctl.setRegion(null);
        renderSelection();
      }
      return;
    }
    // Text fields keep their keys (and their own undo).
    if (isTyping(e)) return;
    keys.handle(e);
  });
}

// ---- Status and toasts ---------------------------------------------------------------------------

function updateStatus(cell) {
  const s = $('#status');
  const sym = SYMMETRY_MODES.find((m) => m.id === state.symmetry).label;
  if (!cell || !doc.inside(cell.x, cell.y)) {
    s.textContent = `${doc.width} x ${doc.height}  |  symmetry: ${sym}`;
    return;
  }
  const i = doc.idx(cell.x, cell.y);
  const ore = doc.ore[i] ? `, ore ${doc.ore[i]}` : doc.gems[i] ? `, gems ${doc.gems[i]}` : '';
  const zone = ctl.analysis?.[i];
  const z = zone !== undefined && zone >> 8 !== 255 && (state.layers.zones || activeTab === 'check') ? `, zone of spawn ${(zone >> 8) + 1}` : '';
  s.textContent = `${cell.x}, ${cell.y}  ${TERRAIN_NAMES[doc.terrain[i]]}${ore}${z}  |  zoom ${view.camera.zoom.toFixed(2)}  |  symmetry: ${sym}`;
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
