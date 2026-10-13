// Pre-game skirmish lobby: map preview, player slots and game options.
// All DOM is built inside the given root. The chosen setup is reported
// through onStart / onStress; the last used setup is kept in localStorage
// when it is available and the lobby works the same without it. Slot rules,
// stored-settings migration and the options shape live in lobby-state.js.

import {
  applyMapSetup,
  keepLockedOptions,
  optionLockedBy,
  slotLockedBy,
  LOBBY_SELECT_OPTIONS,
  LOBBY_TOGGLE_OPTIONS,
  MAP_STORAGE_KEY,
  NAME_MAX,
  DEFAULT_NAME,
  UNITS_MIN,
  UNITS_MAX,
  MAX_SLOTS,
  MAP_FILE_MAX_BYTES,
  MODDED_WARNING,
  MAP_SIZES,
  STARTING_CASH,
  STARTING_UNITS,
  TECH_LEVELS,
  TECH_BUILDINGS,
  GAME_SPEEDS,
  TIME_LIMITS,
  HANDICAPS,
  MAP_STYLES,
  BIOMES,
  WEATHER_MODES,
  SLOT_TYPES,
  BOT_TYPES,
  TEAMS,
  TEAM_COUNT,
  FACTION_GROUPS,
  FACTIONS,
  randomSeed,
  parseSeed,
  parseUnits,
  cleanName,
  minMapSize,
  suggestedMapSize,
  slotTypeValue,
  activeCount,
  sanitizeState,
  canAddSlot,
  addSlot,
  canRemoveSlot,
  removeSlot,
  setSlotType,
  setColor,
  startProblem,
  buildOptions,
  storedSettings,
  inspectMapFile,
  spawnMarkers,
  withDefaults,
  aiName,
  battlefieldKey,
  clearSpawnPicks,
  setSpawnPick,
  settleSpawnPicks,
} from './lobby-state.js';
import { SpawnMarkers } from './spawnpick.js';
import { battlefieldSpawns } from '../protocol/spawns.js';
import { defaultRegistry } from './registry.js';
import { infoTip, describedBy } from './infotip.js';
import { ModePicker } from './modepicker.js';
import { presetOptions } from './modes.js';
import { renderReport } from './oramap/report.js';
import { isOramapFile, ORAMAP_MAX_BYTES } from './oramap/index.js';
import { switchInput } from './ui/controls.js';
import { mapLibrary } from './maplibrary.js';
import { attachTooltip } from './ui/tooltip.js';
import { applyBulk, planBulk } from './lobby-bulk.js';
import { BulkBar } from './lobby-bulkbar.js';

// Game option rows: the key in options (also its help text in js/help.js),
// its label and choices. Map style, biome, tech buildings and weather are the
// World group of the Battlefield panel.
const SELECT_OPTIONS = LOBBY_SELECT_OPTIONS;
const TOGGLE_OPTIONS = LOBBY_TOGGLE_OPTIONS;

/** Every option of the lobby with a "?" (tests check each one has help). */
export const HELP_KEYS = [
  'mode',
  'mapSource',
  'mapSize',
  'mapStyle',
  'biome',
  'techBuildings',
  'weather',
  'mapFile',
  'seed',
  ...SELECT_OPTIONS.map((o) => o.key),
  ...TOGGLE_OPTIONS.map((o) => o.key),
  'player',
  'color',
  'faction',
  'team',
  'handicap',
  'spawn',
  'bulk',
];

let uid = 0;

/** Create an element with an optional class and text. */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

/** Build a <select>; choices are {value,label} or groups {label, items}. */
/**
 * Keep a select's tooltip on its chosen option, so a select too narrow for
 * its text (player slots on small screens) still tells it in full. Call it
 * after the select's own change listener, which may put the value back.
 */
function titleFollowsChoice(select) {
  const sync = () => {
    select.title = [...select.querySelectorAll('option')].find((o) => o.value === select.value)?.textContent ?? '';
  };
  sync();
  select.addEventListener('change', sync);
}

function buildSelect(choices, className) {
  const select = el('select', className);
  const add = (parent, c) => {
    const o = el('option', null, c.label);
    o.value = String(c.value);
    parent.append(o);
  };
  for (const c of choices) {
    if (c.items) {
      const g = el('optgroup');
      g.label = c.label;
      for (const item of c.items) add(g, item);
      select.append(g);
    } else {
      add(select, c);
    }
  }
  return select;
}

// ---- Storage ---------------------------------------------------------------

function readJson(key) {
  let raw = null;
  try {
    raw = globalThis.localStorage ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeJson(key, data) {
  try {
    if (!globalThis.localStorage) return;
    if (data === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Storage full, blocked or unavailable: the lobby simply forgets.
  }
}

/**
 * The last skirmish setup from the settings registry (js/registry.js, which
 * also migrated the older lobby keys); sanitizeState checks it.
 */
function loadStored() {
  return defaultRegistry().get('lobby', 'lastOptions');
}


// ---- Colour picker -----------------------------------------------------------

/**
 * Custom colour dropdown: a button that opens a swatch listbox. Keyboard:
 * Enter / Space / ArrowDown open it, arrows move, Home / End jump,
 * Enter / Space pick, Escape / Tab close.
 */
class ColorPicker {
  constructor(lobby, slot) {
    this.lobby = lobby;
    this.slot = slot;
    this.active = 0;
    this.open = false;
    this.onOutside = (e) => {
      if (!this.root.contains(e.target)) this.close(false);
    };

    const id = `lobby-color-${++uid}`;
    this.root = el('div', 'lobby-color');

    this.button = el('button', 'lobby-color-btn');
    this.button.type = 'button';
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.setAttribute('aria-controls', id);
    attachTooltip(this.button, () => ({
      title: `Color: ${this.lobby.colorName(this.lobby.state.players[this.slot].color)}`,
      desc: 'Pick a color. Picking a color used by another player swaps the two.',
    }));
    this.swatch = el('span', 'lobby-swatch');
    this.button.append(this.swatch, el('span', 'lobby-caret'));

    this.list = el('div', 'lobby-color-list');
    this.list.id = id;
    this.list.hidden = true;
    this.list.tabIndex = -1;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Player color');

    this.options = lobby.colors.map((c, i) => {
      const o = el('div', 'lobby-color-opt');
      o.id = `${id}-${i}`;
      o.setAttribute('role', 'option');
      o.dataset.index = String(i);
      const sw = el('span', 'lobby-swatch');
      sw.style.background = rgbCss(c);
      const tag = el('span', 'lobby-color-tag');
      o.append(sw, tag);
      o.addEventListener('click', () => this.pick(i));
      o.addEventListener('pointermove', () => this.setActive(i));
      this.list.append(o);
      const rec = { node: o, tag, owner: -1 };
      attachTooltip(
        o,
        () => ({
          title: this.lobby.colorName(i),
          desc: rec.owner >= 0 ? `Used by Player ${rec.owner + 1}: picking it swaps colors.` : '',
        }),
        { side: 'right' },
      );
      return rec;
    });

    this.button.addEventListener('click', () => (this.open ? this.close(true) : this.show()));
    this.button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.show();
      }
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('focusout', (e) => {
      if (this.open && !this.root.contains(e.relatedTarget)) this.close(false);
    });

    this.root.append(this.button, this.list);
  }

  render() {
    const players = this.lobby.state.players;
    const color = players[this.slot].color;
    const name = this.lobby.colorName(color);
    this.swatch.style.background = rgbCss(this.lobby.colors[color]);
    this.button.setAttribute('aria-label', `Color: ${name}`);
    this.options.forEach((rec, i) => {
      const { node, tag } = rec;
      const owner = players.findIndex((p, s) => s !== this.slot && p.color === i);
      rec.owner = owner;
      node.setAttribute('aria-selected', i === color ? 'true' : 'false');
      node.classList.toggle('taken', owner >= 0);
      tag.textContent = owner >= 0 ? `P${owner + 1}` : '';
      const label = this.lobby.colorName(i);
      node.setAttribute('aria-label', owner >= 0 ? `${label}, used by Player ${owner + 1}` : label);
    });
  }

  setActive(i) {
    const n = this.options.length;
    this.active = ((i % n) + n) % n;
    this.options.forEach(({ node }, j) => node.classList.toggle('active', j === this.active));
    this.list.setAttribute('aria-activedescendant', this.options[this.active].node.id);
  }

  show() {
    if (this.open || this.button.disabled) return;
    this.lobby.closePickers(this);
    this.open = true;
    this.render();
    this.list.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.setActive(this.lobby.state.players[this.slot].color);
    this.list.focus();
    document.addEventListener('pointerdown', this.onOutside, true);
  }

  close(focusButton) {
    if (!this.open) return;
    this.open = false;
    this.list.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onOutside, true);
    if (focusButton) this.button.focus();
  }

  pick(i) {
    this.lobby.setColor(this.slot, i);
    this.close(true);
  }

  onKey(e) {
    const cols = 4;
    switch (e.key) {
      case 'ArrowRight':
        this.setActive(this.active + 1);
        break;
      case 'ArrowLeft':
        this.setActive(this.active - 1);
        break;
      case 'ArrowDown':
        this.setActive(this.active + cols);
        break;
      case 'ArrowUp':
        this.setActive(this.active - cols);
        break;
      case 'Home':
        this.setActive(0);
        break;
      case 'End':
        this.setActive(this.options.length - 1);
        break;
      case 'Enter':
      case ' ':
        this.pick(this.active);
        break;
      case 'Escape':
        this.close(true);
        break;
      case 'Tab':
        this.close(false);
        return; // let focus move on
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

// ---- Lobby -------------------------------------------------------------------

export class Lobby {
  /**
   * @param {HTMLElement} root the <section id="menu"> element
   * @param {{
   *   colors: number[][],
   *   colorNames: string[],
   *   maps?: {
   *     preview: (seed: number, size: number, players: number) => Uint8Array,
   *     spawns: (seed: number, size: number, players: number) => number[][],
   *     validate: (json: string) => {ok: boolean, errors: string[], modded: boolean, hash: string},
   *     filePreview: (json: string) => Uint8Array,
   *     importOramap?: (bytes: Uint8Array, fileName: string) => Promise<{json: string, report: object}>,
   *     versions?: object,  the map format version registry (tests; the protocol's by default)
   *   },
   *   mapPreview?: (seed: number, size: number) => Uint8Array,
   *   lens?: () => import('./maplens/lens.js').MapLens,  a magnifier over the preview (js/maplens)
   *   onStart: (options: object) => void,
   *   onStress: (opts: {seed: number, units: number}) => void,
   * }} config `maps` gives player-count previews and map files; without it
   *   only `mapPreview` (two players) is used and map files are unavailable.
   */
  constructor(root, config) {
    this.root = root;
    this.colors = config.colors;
    this.colorNames = config.colorNames || [];
    this.maps = config.maps || null;
    this.legacyPreview = config.mapPreview || null;
    this.lens = config.lens?.() ?? null;
    this.onStart = config.onStart;
    this.onStress = config.onStress;
    this.blocked = false;
    this.previewFrame = 0;
    this.spawnCache = { key: '', cells: [] };
    /** The battlefield the picked spawns belong to (lobby-state battlefieldKey); null until the first preview. */
    this.spawnField = null;
    /** The spawn markers of the last preview (lobby-state spawnMarkers). */
    this.markerList = [];

    const stored = loadStored();
    this.state = sanitizeState(withDefaults(stored, defaultRegistry().group('lobby'), this.colors.length), this.colors.length);
    /** The game mode the player picked last (js/modes.js ids); the options decide whether it still applies. */
    this.storedMode = typeof stored?.mode === 'string' && stored.mode.length <= 64 ? stored.mode : null;
    /** Installed map file: { json, info, accepted } or null. */
    this.mapFile = this.loadStoredMap();
    // A map installed before the library existed joins it too.
    if (this.mapFile) this.addToLibrary(this.mapFile.json, 'file');
    /** A modded map waiting for the player to accept its rules. */
    this.pendingMap = null;
    /** Report of the last .oramap import (shown until another map is picked). */
    this.importReport = null;
    if (this.state.mapSource === 'file' && !this.mapFile) this.state.mapSource = 'random';
    this.pickers = [];
    this.slotRows = [];

    this.build();
    this.renderAll();

    this.onDocKey = (e) => this.handleEnter(e);
    document.addEventListener('keydown', this.onDocKey);
  }

  colorName(i) {
    return this.colorNames[i] || `Color ${i + 1}`;
  }

  // ---- Public API ------------------------------------------------------------

  /** Show an error banner and disable both start buttons. */
  showError(message) {
    this.blocked = true;
    this.errorText.textContent = String(message);
    this.errorBox.hidden = false;
    this.startBtn.disabled = true;
    this.stressBtn.disabled = true;
  }

  /** The current setup in the shape onStart receives. */
  getOptions() {
    return buildOptions(this.state, this.mapFile ? this.mapFile.json : null);
  }

  /**
   * Show the stress test controls (the start screen's More menu): the unit
   * count and its start button, hidden again with their Close button.
   */
  openStress() {
    this.stressBox.hidden = false;
    this.unitsInput.focus();
  }

  closeStress() {
    this.stressBox.hidden = true;
  }

  // ---- Map files ---------------------------------------------------------------

  loadStoredMap() {
    if (!this.maps) return null;
    const stored = readJson(MAP_STORAGE_KEY);
    if (!stored || typeof stored.json !== 'string') return null;
    const info = inspectMapFile(stored.json, this.maps.validate, this.maps.versions);
    // Only a map that still validates, and whose rules were accepted, comes back.
    if (!info.ok || (info.modded && stored.accepted !== info.hash)) return null;
    // Stored by an older release: it comes back upgraded (no notice: the player's file is not at hand).
    return { json: info.json, info: { ...info, upgrade: null }, accepted: true };
  }

  /** Spawn count and acceptance of the installed map, for startProblem. */
  mapFileStatus() {
    return this.mapFile ? { spawns: this.mapFile.info.spawns, accepted: this.mapFile.accepted, setup: this.mapFile.info.setup ?? null } : null;
  }

  spawnLimit() {
    return this.state.mapSource === 'file' && this.mapFile ? this.mapFile.info.spawns : MAX_SLOTS;
  }

  async loadMapFile(file) {
    this.mapErrors = [];
    this.importReport = null;
    if (isOramapFile(file.name)) {
      await this.importOramapFile(file);
      return;
    }
    if (file.size > MAP_FILE_MAX_BYTES) {
      this.mapErrors = ['The map file is larger than 1 MiB.'];
      this.renderMapSource();
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      this.mapErrors = [`Could not read the file: ${err?.message ?? err}`];
      this.renderMapSource();
      return;
    }
    this.offerMapText(text, 'file');
  }

  /**
   * Convert an OpenRA .oramap package (js/oramap) and offer the result like
   * any map file: validation, then the modded warning when it carries rules.
   * The import report stays on screen so the player sees what was converted,
   * skipped and ignored (Lua and unsupported rules are never applied).
   */
  async importOramapFile(file) {
    this.state.mapSource = 'file';
    if (!this.maps.importOramap) {
      this.mapErrors = ['OpenRA maps cannot be imported here.'];
      this.renderMapSource();
      return;
    }
    if (file.size > ORAMAP_MAX_BYTES) {
      this.mapErrors = [`The .oramap file is larger than ${ORAMAP_MAX_BYTES / 1024 / 1024} MiB.`];
      this.renderMapSource();
      return;
    }
    let result;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      result = await this.maps.importOramap(bytes, file.name);
    } catch (err) {
      this.importReport = err?.report ?? null;
      this.mapErrors = [`Could not import ${file.name}: ${err?.message ?? err}`];
      this.renderMapSource();
      return;
    }
    this.importReport = result.report;
    this.offerMapText(result.json, 'oramap');
  }

  /**
   * Offer a map (file contents, editor test play or a published map from a
   * link): validate it, and install it right away, or after the player
   * accepts the warning when it is modded. `source` (js/maplibrary.js
   * LIBRARY_SOURCES) says where it came from for the map library.
   */
  offerMapText(text, source = 'file', setup = null) {
    this.mapErrors = [];
    this.state.mapSource = 'file';
    const info = inspectMapFile(text, this.maps.validate, this.maps.versions);
    if (!info.ok) {
      this.mapErrors = info.errors;
      this.renderMapSource();
      return;
    }
    // An older format version arrives upgraded (info.json); the notice shows with the map.
    if (info.modded) {
      // Modded maps are installed only after the player accepts the warning.
      this.pendingMap = { json: info.json, info, source, setup };
      this.renderMapSource();
      this.acceptBtn.focus();
      return;
    }
    this.installMap(info.json, info, source, setup);
  }

  /**
   * The map editor's test play setup (js/maploader.js loadTestSetup): its
   * slots, checked like stored lobby settings (the player keeps their name
   * and colour), and with `autostart` the game starts at once.
   */
  applyTestSetup(setup) {
    const me = this.state.players.find((p) => p.type === 'human');
    const players = setup.players.slice(0, this.spawnLimit()).map((p) => ({ ...p, name: p.type === 'human' ? me?.name : DEFAULT_NAME, color: p.type === 'human' ? me?.color : undefined }));
    // The movement model the editor picked, unless the map locks its own.
    const movement = optionLockedBy(this.state, this.mapFile?.info.setup ?? null, 'movement') ? this.state.movement : (setup.movement ?? this.state.movement);
    const clean = sanitizeState({ ...this.state, players, movement }, this.colors.length);
    this.state.players = clean.players;
    this.state.movement = clean.movement;
    this.renderAll();
    this.renderSlots();
    if (setup.autostart) queueMicrotask(() => this.start());
  }

  /** Show why a requested map (for example from a link) could not be loaded. */
  reportMapProblem(message) {
    this.mapErrors = [String(message)];
    this.state.mapSource = 'file';
    this.renderMapSource();
  }

  installMap(json, info, source = 'file', setup = null) {
    this.pendingMap = null;
    this.mapErrors = [];
    this.mapFile = { json, info, accepted: true };
    this.state.mapSource = 'file';
    writeJson(MAP_STORAGE_KEY, { json, accepted: info.modded ? info.hash : true });
    this.addToLibrary(json, source);
    // The map's slots and options (map format version 2): where the lobby starts on this map.
    applyMapSetup(this.state, info.setup, this.colors.length, info.spawns);
    this.renderAll();
    this.renderMapSource();
    this.renderSlots();
    this.schedulePreview();
    if (setup) this.applyTestSetup(setup);
  }

  /**
   * Keep an installed map in the local map library (js/maplibrary.js), so a
   * host can share it in an online lobby. The engine already accepted it.
   */
  addToLibrary(json, source) {
    if (!this.maps) return;
    mapLibrary()
      .add(json, { source })
      .catch((err) => console.warn('Map library:', err?.message ?? err));
  }

  /**
   * Unload the map file: the lobby goes back to the generated map with the
   * generator settings and seed it had before the file came (they are kept
   * while a file is loaded), and forgets the file (it stays in the map
   * library). The slots stay as they are. The spawn picks clear with the
   * battlefield, as on every map change.
   */
  unloadMap() {
    this.mapFile = null;
    this.pendingMap = null;
    this.importReport = null;
    this.mapErrors = [];
    writeJson(MAP_STORAGE_KEY, null);
    this.state.mapSource = 'random';
    this.renderAll();
    this.sourceBtns.file.focus();
  }

  setMapSource(source) {
    if (source !== 'file') this.importReport = null;
    if (source === 'file' && !this.mapFile) {
      this.fileInput.click();
      return;
    }
    this.state.mapSource = source;
    this.renderMapSource();
    this.renderSlots();
    this.schedulePreview();
  }

  // ---- DOM construction --------------------------------------------------------

  build() {
    this.root.textContent = '';
    const lobby = el('div', 'lobby');

    // Title bar: the screen's name (the WebRA name and the other screens
    // are in the start screen's main menu, index.html #start-nav).
    const head = el('header', 'lobby-head');
    const title = el('h2', 'lobby-title', 'Skirmish');
    title.id = 'lobby-title';
    title.tabIndex = -1;
    const tag = el('p', 'lobby-tagline', 'Pick your side, set the battlefield and deploy.');
    head.append(title, tag);
    lobby.setAttribute('aria-labelledby', title.id);

    // Error banner.
    this.errorBox = el('div', 'lobby-error');
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.hidden = true;
    this.errorText = el('span', 'lobby-error-text');
    this.errorBox.append(el('span', 'lobby-error-icon', '!'), this.errorText);

    const body = el('div', 'lobby-body');
    body.append(this.buildMapPanel(), this.buildSidePanels());

    lobby.append(head, this.errorBox, body, this.buildBar());
    this.root.append(lobby);
  }

  panel(title, className) {
    const section = el('section', `lobby-panel ${className}`);
    const h2 = el('h2', 'lobby-panel-title', title);
    h2.id = `lobby-h-${++uid}`;
    section.setAttribute('aria-labelledby', h2.id);
    const content = el('div', 'lobby-panel-body');
    section.append(h2, content);
    return { section, content };
  }

  /**
   * A label + control row with the option's "?" help (js/help.js `helpKey`).
   * `target` is the element the label names (the control itself, or the
   * main input of a compound control).
   */
  field(labelText, control, helpKey, target = control) {
    const row = el('div', 'lobby-field');
    const head = el('span', 'lobby-field-head');
    const label = el('label', 'lobby-field-label', labelText);
    if (!target.id) target.id = `lobby-ctl-${++uid}`;
    label.htmlFor = target.id;
    head.append(label);
    if (helpKey) head.append(infoTip(helpKey, { label: labelText, describes: target }).root);
    row.append(head, control);
    return row;
  }

  buildMapPanel() {
    const { section, content } = this.panel('Battlefield', 'lobby-map');

    // Map source: generated from a seed, or a map file.
    const source = el('div', 'lobby-source');
    source.setAttribute('role', 'group');
    source.setAttribute('aria-label', 'Map');
    this.sourceBtns = {};
    for (const [value, label, title] of [
      ['random', 'Random map', 'A generated map from the seed and size below.'],
      ['file', 'Map file', 'Play on a .webra-map.json file, for example one made in the map editor.'],
    ]) {
      const b = el('button', 'lobby-btn lobby-source-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => this.setMapSource(value));
      this.sourceBtns[value] = b;
      source.append(b);
    }
    if (!this.maps) this.sourceBtns.file.disabled = true;
    source.append(infoTip('mapSource', { label: 'Map source', describes: Object.values(this.sourceBtns) }).root);

    const frame = el('div', 'lobby-preview');
    this.canvas = el('canvas', 'lobby-preview-canvas');
    this.canvas.setAttribute('role', 'img');
    this.ctx = this.canvas.getContext('2d');
    this.markers = el('div', 'lobby-markers');
    this.previewFail = el('div', 'lobby-preview-fail', 'Preview unavailable');
    this.previewFail.hidden = true;
    frame.append(this.canvas, this.markers, this.previewFail);
    this.lens?.attach(frame, this.canvas);
    // The start positions: click one to start there (js/spawnpick.js).
    this.spawnLayer = new SpawnMarkers(this.markers, { lens: this.lens, onPick: (a) => this.pickSpawn(a) });
    this.caption = el('p', 'lobby-preview-caption');

    this.mapSizeSelect = el('select', 'lobby-select');
    this.mapSizeSelect.addEventListener('change', () => {
      this.state.mapSize = Number(this.mapSizeSelect.value);
      this.renderCaption();
      this.schedulePreview();
    });

    // Layout and biome of the generated map (map files bring their own biome).
    this.styleSelect = buildSelect(MAP_STYLES, 'lobby-select');
    this.styleSelect.addEventListener('change', () => {
      this.state.mapStyle = this.styleSelect.value;
      this.optionEdited();
      this.renderCaption();
      this.schedulePreview();
    });
    this.biomeSelect = buildSelect(BIOMES, 'lobby-select');
    this.biomeSelect.addEventListener('change', () => {
      this.state.biome = this.biomeSelect.value;
      this.optionEdited();
      this.renderCaption();
      this.schedulePreview();
    });
    // Tech buildings of a generated map (map files bring their own buildings).
    this.techSelect = buildSelect(TECH_BUILDINGS, 'lobby-select');
    this.techSelect.addEventListener('change', () => {
      this.state.techBuildings = this.techSelect.value;
      this.optionEdited();
      // The lens shows the tech buildings the map gets.
      this.schedulePreview();
    });
    // Weather applies to map files too (they bring their biome, not the weather).
    this.weatherSelect = buildSelect(WEATHER_MODES, 'lobby-select');
    this.weatherSelect.addEventListener('change', () => {
      this.state.weather = this.weatherSelect.value;
      this.optionEdited();
    });

    this.seedInput = el('input', 'lobby-input lobby-seed');
    this.seedInput.type = 'text';
    this.seedInput.inputMode = 'numeric';
    this.seedInput.autocomplete = 'off';
    this.seedInput.spellcheck = false;
    this.seedInput.maxLength = 10;
    this.seedInput.addEventListener('input', () => {
      const seed = parseSeed(this.seedInput.value);
      this.seedInput.setAttribute('aria-invalid', seed === null ? 'true' : 'false');
      if (seed === null || seed === this.state.seed) return;
      this.state.seed = seed;
      this.renderCaption();
      this.schedulePreview();
    });
    this.seedInput.addEventListener('change', () => {
      // Leaving the field with an invalid value restores the last valid seed.
      if (parseSeed(this.seedInput.value) === null) this.renderSeed();
    });

    this.diceBtn = el('button', 'lobby-btn lobby-dice');
    this.diceBtn.type = 'button';
    this.diceBtn.setAttribute('aria-label', 'New seed');
    // On narrow screens the button is only the die (css/lobby.css).
    attachTooltip(this.diceBtn, () => ({ title: 'New seed', desc: 'Generate a new random seed for the map.' }));
    const die = el('span', 'lobby-die');
    die.setAttribute('aria-hidden', 'true');
    this.diceBtn.append(die, el('span', 'lobby-dice-text', 'New seed'));
    this.diceBtn.addEventListener('click', () => {
      this.state.seed = randomSeed();
      this.renderSeed();
      this.renderCaption();
      this.schedulePreview();
    });

    const seedRow = el('div', 'lobby-seed-row');
    seedRow.append(this.seedInput, this.diceBtn);

    // Map file: load button, details, modded warning and errors.
    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json,.oramap';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (file) this.loadMapFile(file);
    });
    this.loadBtn = el('button', 'lobby-btn', 'Load map file');
    this.loadBtn.type = 'button';
    this.loadBtn.title = 'Pick a .webra-map.json file or an OpenRA .oramap map';
    this.loadBtn.addEventListener('click', () => this.fileInput.click());
    this.mapInfo = el('div', 'lobby-mapinfo');
    this.mapInfo.setAttribute('aria-live', 'polite');

    this.moddedBox = el('div', 'lobby-modded');
    this.moddedBox.setAttribute('role', 'alertdialog');
    this.moddedBox.hidden = true;
    const moddedTitle = el('strong', null, 'Modded map');
    moddedTitle.id = `lobby-modded-${++uid}`;
    this.moddedBox.setAttribute('aria-labelledby', moddedTitle.id);
    this.moddedName = el('p', 'lobby-modded-name');
    const moddedButtons = el('div', 'lobby-modded-buttons');
    this.acceptBtn = el('button', 'lobby-btn lobby-btn-danger', 'Accept and install');
    this.acceptBtn.type = 'button';
    this.acceptBtn.addEventListener('click', () => {
      if (this.pendingMap) this.installMap(this.pendingMap.json, this.pendingMap.info, this.pendingMap.source, this.pendingMap.setup);
    });
    const cancel = el('button', 'lobby-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.pendingMap = null;
      this.renderMapSource();
      this.loadBtn.focus();
    });
    moddedButtons.append(this.acceptBtn, cancel);
    this.moddedBox.append(moddedTitle, this.moddedName, el('p', null, MODDED_WARNING), moddedButtons);

    this.mapErrorList = el('ul', 'lobby-map-errors');
    this.mapErrorList.setAttribute('role', 'alert');
    this.mapErrors = [];

    // Report of an OpenRA .oramap import: what was converted, skipped and ignored.
    this.importBox = el('div', 'lobby-import');
    this.importBox.setAttribute('aria-live', 'polite');
    this.importBox.hidden = true;

    // Back to the generated map (unloadMap).
    this.unloadBtn = el('button', 'lobby-btn', 'Unload map');
    this.unloadBtn.type = 'button';
    this.unloadBtn.title = 'Go back to the generated map and its seed';
    this.unloadBtn.addEventListener('click', () => this.unloadMap());

    const fileRow = el('div', 'lobby-file-row');
    fileRow.append(this.loadBtn, this.unloadBtn, this.fileInput);

    const fields = el('div', 'lobby-fields');
    this.sizeField = this.field('Map size', this.mapSizeSelect, 'mapSize');
    this.fileField = this.field('Map file', fileRow, 'mapFile', this.loadBtn);
    this.styleField = this.field('Map style', this.styleSelect, 'mapStyle');
    this.biomeField = this.field('Biome', this.biomeSelect, 'biome');
    this.techField = this.field('Tech buildings', this.techSelect, 'techBuildings');

    // The climate of the battlefield: layout, biome and weather together.
    const world = el('fieldset', 'lobby-world');
    world.append(
      el('legend', 'lobby-world-title', 'World'),
      this.styleField,
      this.biomeField,
      this.techField,
      this.field('Weather', this.weatherSelect, 'weather'),
    );
    // The seed makes the generated map, so it hides with the other generator
    // fields while a map file is in use; a game on a map file gets a new
    // seed of its own for its random events (start).
    this.seedField = this.field('Seed', seedRow, 'seed', this.seedInput);
    fields.append(this.sizeField, this.fileField, world, this.seedField);

    content.append(source, frame, this.caption, this.mapInfo, this.moddedBox, this.mapErrorList, this.importBox, fields);
    return section;
  }

  buildSidePanels() {
    const side = el('div', 'lobby-side');
    side.append(this.buildPlayersPanel(), this.buildOptionsPanel());
    return side;
  }

  buildPlayersPanel() {
    const { section, content } = this.panel('Players', 'lobby-players');
    // Bulk edit (js/lobby-bulkbar.js): select rows, apply one action to them.
    this.bulk = new BulkBar({
      context: 'skirmish',
      selectClass: 'lobby-select',
      buttonClass: 'lobby-btn',
      onApply: (id, selected) => this.applyBulk(id, selected),
    });
    this.slotTable = el('div', 'lobby-slots');
    this.slotTable.setAttribute('role', 'table');
    this.slotTable.setAttribute('aria-label', 'Player slots');
    // Column headers, with the help of each column (built once: rows come and go).
    this.slotHead = el('div', 'lobby-slot lobby-slot-head');
    this.slotHead.setAttribute('role', 'row');
    this.columnTips = {};
    for (const [label, key] of [['Player', 'player'], ['Color', 'color'], ['Faction', 'faction'], ['Team', 'team'], ['', null]]) {
      const c = el('div', 'lobby-cell', label);
      c.setAttribute('role', 'columnheader');
      if (key) {
        this.columnTips[key] = infoTip(key, { label });
        c.append(this.columnTips[key].root);
      }
      // The team column also holds the handicap (OpenRA's lobby column).
      if (key === 'team') {
        this.columnTips.handicap = infoTip('handicap', { label: 'Handicap' });
        c.append(' / Handicap', this.columnTips.handicap.root);
        // And the start position (OpenRA's spawn column).
        this.columnTips.spawn = infoTip('spawn', { label: 'Start' });
        c.append(' / Start', this.columnTips.spawn.root);
      }
      this.slotHead.append(c);
    }

    this.addBtn = el('button', 'lobby-btn lobby-add', 'Add player');
    this.addBtn.type = 'button';
    this.addBtn.addEventListener('click', () => {
      const slot = addSlot(this.state, this.colors.length, this.spawnLimit());
      if (slot < 0) return;
      this.afterPlayerCountChange();
      this.slotRows[slot]?.type?.focus();
    });
    this.slotHint = el('span', 'lobby-muted lobby-slot-hint');
    const foot = el('div', 'lobby-slots-foot');
    foot.append(this.addBtn, this.bulk.toggleBox, this.slotHint);

    content.append(this.bulk.root, this.slotTable, foot);
    return section;
  }

  /** The slots as js/lobby-bulk.js sees them: the map file's locks and which one is you. */
  bulkSlots() {
    const setup = this.mapFile?.info.setup ?? null;
    return this.state.players.map((p, k) => ({
      ...p,
      you: p.type === 'human',
      locked: ['team', 'faction', 'color', 'type'].filter((part) => slotLockedBy(this.state, setup, k, part)),
    }));
  }

  /** Apply bulk action `id` to the selected rows (all rows when none is). */
  applyBulk(id, selected) {
    const limit = this.spawnLimit();
    const plan = planBulk(this.bulkSlots(), id, { context: 'skirmish', selected, colorCount: this.colors.length, teamMax: TEAM_COUNT, maxActive: limit, maxRows: MAX_SLOTS });
    if (plan.error) return plan;
    const refused = applyBulk(this.state, plan, { colorCount: this.colors.length, maxActive: limit, addRow: () => addSlot(this.state, this.colors.length, limit) });
    if (refused) return { error: refused };
    this.afterPlayerCountChange();
    return plan;
  }

  /** (Re)build every slot row; slots come and go, so rows are not kept. */
  renderSlots() {
    this.closePickers(null);
    this.slotTable.textContent = '';
    this.pickers = [];
    this.slotRows = [];
    this.slotTable.append(this.slotHead);
    this.bulk.begin(this.state.players.length, { teamMax: TEAM_COUNT, players: activeCount(this.state) });
    this.state.players.forEach((p, slot) => this.slotTable.append(this.buildSlot(p, slot)));
    this.state.players.forEach((_, slot) => this.renderSlot(slot));
    this.bulk.sync();
    const limit = this.spawnLimit();
    this.addBtn.disabled = !canAddSlot(this.state, limit);
    const n = activeCount(this.state);
    this.slotHint.textContent =
      this.state.mapSource === 'file' && this.mapFile
        ? `${n} of ${limit} start positions used`
        : `${n} of ${MAX_SLOTS} players`;
    this.renderProblem();
  }

  buildSlot(player, slot) {
    const row = el('div', `lobby-slot lobby-slot-${player.type}`);
    row.setAttribute('role', 'row');
    const cell = (cls, label) => {
      const c = el('div', `lobby-cell ${cls}`);
      c.setAttribute('role', 'cell');
      c.dataset.label = label;
      row.append(c);
      return c;
    };
    const rec = { row };
    const closed = player.type === 'closed';

    // Player: name for you, slot type (with the AI's difficulty) and bot for
    // the others. They wrap under each other when the column is narrow.
    const cellPlayer = cell('lobby-cell-player', 'Player');
    const who = el('div', 'lobby-who');
    cellPlayer.append(el('span', 'lobby-badge', `P${slot + 1}`), who);
    this.bulk.decorate(row, cellPlayer, slot, `player ${slot + 1}`);
    if (player.type === 'human') {
      const name = el('input', 'lobby-input lobby-name');
      name.type = 'text';
      name.maxLength = NAME_MAX;
      name.autocomplete = 'off';
      name.spellcheck = false;
      name.placeholder = DEFAULT_NAME;
      name.value = player.name;
      name.setAttribute('aria-label', 'Your name');
      describedBy(name, this.columnTips.player);
      name.addEventListener('input', () => {
        this.state.players[slot].name = name.value;
      });
      name.addEventListener('change', () => {
        this.state.players[slot].name = cleanName(name.value);
        name.value = this.state.players[slot].name;
      });
      rec.name = name;
      who.append(name);
    } else {
      const type = buildSelect(SLOT_TYPES, 'lobby-select lobby-type');
      type.value = slotTypeValue(player);
      type.setAttribute('aria-label', `Player ${slot + 1} type`);
      describedBy(type, this.columnTips.player);
      type.addEventListener('change', () => {
        if (setSlotType(this.state, slot, type.value, this.spawnLimit())) {
          this.afterPlayerCountChange();
          this.slotRows[slot]?.name?.focus();
          this.slotRows[slot]?.type?.focus();
        } else {
          type.value = slotTypeValue(this.state.players[slot]);
          this.renderProblem(this.typeRefusal(slot, type.value));
        }
      });
      titleFollowsChoice(type);
      rec.type = type;
      who.append(type);
      // The OpenRA bot the AI plays (Rush, Normal, Turtle, Naval).
      if (player.type === 'ai') {
        const bot = buildSelect(BOT_TYPES, 'lobby-select lobby-bot');
        bot.value = player.bot ?? 'normal';
        bot.setAttribute('aria-label', `Player ${slot + 1} bot`);
        describedBy(bot, this.columnTips.player);
        bot.addEventListener('change', () => {
          this.state.players[slot].bot = bot.value;
        });
        titleFollowsChoice(bot);
        rec.bot = bot;
        who.append(bot);
      }
    }

    // Colour.
    const colorCell = cell('lobby-cell-color', 'Color');
    const picker = new ColorPicker(this, slot);
    picker.button.disabled = closed;
    describedBy(picker.button, this.columnTips.color);
    this.pickers[slot] = picker;
    colorCell.append(picker.root);

    // Faction.
    const factionCell = cell('lobby-cell-faction', 'Faction');
    const flag = el('span', 'lobby-flag');
    flag.setAttribute('aria-hidden', 'true');
    const faction = buildSelect(FACTION_GROUPS, 'lobby-select');
    faction.value = player.faction;
    faction.disabled = closed;
    faction.setAttribute('aria-label', `Player ${slot + 1} faction`);
    describedBy(faction, this.columnTips.faction);
    faction.addEventListener('change', () => {
      this.state.players[slot].faction = faction.value;
      this.renderSlot(slot);
    });
    titleFollowsChoice(faction);
    const factionRow = el('div', 'lobby-faction-row');
    factionRow.append(flag, faction);
    const desc = el('p', 'lobby-faction-desc');
    factionCell.append(factionRow, desc);
    Object.assign(rec, { flag, faction, desc });

    // Team.
    const teamCell = cell('lobby-cell-team', 'Team');
    const team = buildSelect(TEAMS, 'lobby-select');
    team.value = String(player.team);
    team.disabled = closed;
    team.setAttribute('aria-label', `Player ${slot + 1} team`);
    describedBy(team, this.columnTips.team);
    team.addEventListener('change', () => {
      this.state.players[slot].team = Number(team.value);
      this.renderProblem();
      // Separate team spawns move team mates together on the preview.
      this.schedulePreview();
    });
    titleFollowsChoice(team);
    // Handicap (OpenRA): less firepower and armour, slower production.
    const handicap = buildSelect(HANDICAPS, 'lobby-select lobby-handicap');
    handicap.value = String(player.handicap ?? 0);
    handicap.disabled = closed;
    handicap.setAttribute('aria-label', `Player ${slot + 1} handicap`);
    describedBy(handicap, this.columnTips.handicap);
    handicap.addEventListener('change', () => {
      this.state.players[slot].handicap = Number(handicap.value);
    });
    titleFollowsChoice(handicap);
    // Start position (OpenRA's spawn dropdown): automatic, or a spawn of the map (renderSpawnChoices fills it).
    const spawn = el('select', 'lobby-select lobby-spawn');
    spawn.disabled = closed;
    spawn.setAttribute('aria-label', `Player ${slot + 1} start position`);
    describedBy(spawn, this.columnTips.spawn);
    spawn.addEventListener('change', () => {
      this.pickSpawn({ slot, spawn: spawn.value === 'auto' ? null : Number(spawn.value) });
    });
    teamCell.append(team, handicap, spawn);
    Object.assign(rec, { team, handicap, spawn });

    // Remove.
    const removeCell = cell('lobby-cell-remove', '');
    const remove = el('button', 'lobby-btn lobby-remove');
    remove.type = 'button';
    remove.append(el('span', 'lobby-remove-x'));
    remove.setAttribute('aria-label', `Remove player ${slot + 1}`);
    attachTooltip(remove, () =>
      this.state.players[slot]?.type === 'human'
        ? { title: 'Remove this slot', desc: 'You cannot remove your own slot.' }
        : { title: 'Remove this slot', desc: canRemoveSlot(this.state, slot) ? `Remove player ${slot + 1} from the game.` : 'A game needs at least two players.' },
    );
    remove.disabled = !canRemoveSlot(this.state, slot);
    remove.addEventListener('click', () => {
      if (!removeSlot(this.state, slot)) return;
      this.afterPlayerCountChange();
      const next = this.slotRows[Math.min(slot, this.slotRows.length - 1)];
      (next?.type ?? next?.name ?? this.addBtn).focus();
    });
    removeCell.append(remove);

    this.slotRows[slot] = rec;
    return row;
  }

  /** Explain why a slot type change was refused. */
  typeRefusal(slot, value) {
    if (value === 'closed') return 'At least two players must take part.';
    return `This map has ${this.spawnLimit()} start positions; they are all taken.`;
  }

  buildOptionsPanel() {
    const { section, content } = this.panel('Game options', 'lobby-options');

    // Game mode: a bundle of the options below (js/modes.js).
    this.modePicker = new ModePicker({
      context: 'skirmish',
      registry: defaultRegistry(),
      preferred: this.storedMode,
      selectClass: 'lobby-select',
      buttonClass: 'lobby-btn',
      inputClass: 'lobby-input',
      onApply: (mode) => {
        Object.assign(this.state, presetOptions(mode.options));
        // A game mode never changes what the map file locks.
        if (this.state.mapSource === 'file') keepLockedOptions(this.state, this.mapFile?.info.setup);
        this.renderAll();
      },
    });

    const selects = el('div', 'lobby-fields lobby-option-grid');
    this.optionSelects = {};
    for (const opt of SELECT_OPTIONS) {
      const select = buildSelect(opt.choices, 'lobby-select');
      select.addEventListener('change', () => {
        const numeric = typeof opt.choices[0].value === 'number';
        this.state[opt.key] = numeric ? Number(select.value) : select.value;
        this.optionEdited();
      });
      this.optionSelects[opt.key] = select;
      selects.append(this.field(opt.label, select, opt.key));
    }

    const toggles = el('div', 'lobby-toggles');
    this.optionToggles = {};
    for (const opt of TOGGLE_OPTIONS) {
      const row = el('div', 'lobby-toggle-row');
      const label = el('label', 'lobby-toggle');
      const box = switchInput();
      box.addEventListener('change', () => {
        this.state[opt.key] = box.checked;
        this.optionEdited();
        this.renderCheats();
        if (opt.key === 'separateTeamSpawns') this.schedulePreview();
      });
      this.optionToggles[opt.key] = box;
      label.append(box, el('span', null, opt.label));
      row.append(label, infoTip(opt.key, { label: opt.label, describes: box }).root);
      toggles.append(row);
    }
    // Cheats change the game: say so plainly while the option is on.
    this.cheatsWarning = el('p', 'lobby-cheats-warning', 'Cheats enabled: the debug menu (` key) can build instantly, give cash and reveal the map.');
    this.cheatsWarning.setAttribute('role', 'status');

    content.append(this.modePicker.root, selects, toggles, this.cheatsWarning);
    return section;
  }

  /** An option was changed by hand: the mode list follows (a matching mode, or Custom). */
  optionEdited() {
    this.modePicker.optionChanged();
    this.renderMode();
  }

  renderMode() {
    this.modePicker.render(this.state);
  }

  renderCheats() {
    this.cheatsWarning.hidden = !this.state.cheats;
  }

  buildBar() {
    const bar = el('footer', 'lobby-bar');

    // The stress test: hidden until the main menu's More, Stress test opens it (openStress).
    const stress = el('div', 'lobby-stress');
    stress.hidden = true;
    stress.setAttribute('role', 'group');
    stress.setAttribute('aria-label', 'Stress test');
    stress.title = 'Spawns a large number of units on the current seed to measure performance.';
    this.stressBox = stress;
    const label = el('span', 'lobby-stress-label', 'Stress test');
    this.unitsInput = el('input', 'lobby-input lobby-units');
    this.unitsInput.type = 'number';
    this.unitsInput.min = String(UNITS_MIN);
    this.unitsInput.max = String(UNITS_MAX);
    this.unitsInput.step = '1';
    this.unitsInput.inputMode = 'numeric';
    this.unitsInput.setAttribute('aria-label', 'Stress test units');
    this.unitsInput.addEventListener('input', () => {
      const units = parseUnits(this.unitsInput.value);
      this.unitsInput.setAttribute('aria-invalid', units === null ? 'true' : 'false');
      if (units !== null) this.state.stressUnits = units;
    });
    this.unitsInput.addEventListener('change', () => {
      if (parseUnits(this.unitsInput.value) === null) this.renderUnits();
    });
    this.unitsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.stress();
      }
    });
    const unitsField = el('label', 'lobby-units-field');
    unitsField.append(this.unitsInput, el('span', 'lobby-muted', 'units'));

    this.stressBtn = el('button', 'lobby-btn lobby-btn-secondary', 'Start stress test');
    this.stressBtn.type = 'button';
    this.stressBtn.addEventListener('click', () => this.stress());
    const stressClose = el('button', 'lobby-btn', 'Close');
    stressClose.type = 'button';
    stressClose.setAttribute('aria-label', 'Close the stress test');
    stressClose.addEventListener('click', () => this.closeStress());
    stress.append(label, unitsField, this.stressBtn, stressClose);

    const go = el('div', 'lobby-go');
    this.problemText = el('p', 'lobby-problem');
    this.problemText.setAttribute('role', 'status');
    this.startBtn = el('button', 'lobby-btn lobby-btn-primary', 'Start game');
    this.startBtn.type = 'button';
    this.startBtn.title = 'Start the skirmish (Enter)';
    this.startBtn.addEventListener('click', () => this.start());
    go.append(this.problemText, this.startBtn);

    bar.append(stress, go);
    return bar;
  }

  // ---- Rendering ---------------------------------------------------------------

  renderAll() {
    const s = this.state;
    this.renderSeed();
    this.renderUnits();
    // Options the map file locks (map format version 2) cannot be changed here.
    const setup = this.mapFile?.info.setup ?? null;
    const lock = (control, key) => {
      const on = optionLockedBy(s, setup, key);
      control.disabled = on;
      control.title = on ? 'Locked by the map' : '';
    };
    for (const opt of SELECT_OPTIONS) {
      this.optionSelects[opt.key].value = String(s[opt.key]);
      lock(this.optionSelects[opt.key], opt.key);
    }
    for (const opt of TOGGLE_OPTIONS) {
      this.optionToggles[opt.key].checked = s[opt.key];
      lock(this.optionToggles[opt.key], opt.key);
    }
    this.weatherSelect.value = s.weather;
    lock(this.weatherSelect, 'weather');
    this.renderCheats();
    this.renderMode();
    this.renderMapSizes();
    this.renderMapSource();
    this.renderSlots();
    this.schedulePreview();
  }

  /** Slots were added, removed, opened or closed: sizes, rows and preview follow. */
  afterPlayerCountChange() {
    const n = activeCount(this.state);
    if (this.state.mapSize < minMapSize(n)) this.state.mapSize = suggestedMapSize(n);
    this.renderMapSizes();
    this.renderSlots();
    this.renderCaption();
    this.schedulePreview();
  }

  /** Size choices with the recommendation for the current player count. */
  renderMapSizes() {
    const n = activeCount(this.state);
    const min = minMapSize(n);
    const suggested = suggestedMapSize(n);
    this.mapSizeSelect.textContent = '';
    for (const m of MAP_SIZES) {
      const o = el('option', null, `${m.label} (${m.value} x ${m.value})${m.value === suggested ? ', recommended' : ''}`);
      o.value = String(m.value);
      o.disabled = m.value < min;
      if (o.disabled) o.textContent += ', too small';
      this.mapSizeSelect.append(o);
    }
    this.mapSizeSelect.value = String(this.state.mapSize);
  }

  renderMapSource() {
    const file = this.state.mapSource === 'file';
    for (const [value, b] of Object.entries(this.sourceBtns)) {
      b.setAttribute('aria-pressed', value === this.state.mapSource ? 'true' : 'false');
    }
    this.sizeField.hidden = file;
    this.styleField.hidden = file;
    this.biomeField.hidden = file;
    this.techField.hidden = file;
    this.seedField.hidden = file;
    this.styleSelect.value = this.state.mapStyle;
    this.biomeSelect.value = this.state.biome;
    this.techSelect.value = this.state.techBuildings;
    this.fileField.hidden = !file && !this.pendingMap;
    this.unloadBtn.hidden = !this.mapFile;
    this.loadBtn.textContent = this.mapFile ? 'Load another map' : 'Load map file';

    this.mapInfo.textContent = '';
    this.mapInfo.hidden = !file || !this.mapFile;
    if (file && this.mapFile) {
      const i = this.mapFile.info;
      const title = el('div', 'lobby-mapinfo-title');
      title.append(el('strong', null, i.name));
      if (i.modded) {
        const badge = el('span', 'lobby-modded-badge', 'MODDED');
        badge.title = MODDED_WARNING;
        title.append(badge);
      }
      this.mapInfo.append(
        title,
        el('span', 'lobby-muted', `by ${i.author}, ${i.width} x ${i.height}, ${i.spawns} start positions, ${capitalize(i.biome)}`),
      );
      // Map versions: a file of an older format version was upgraded (non-blocking).
      if (i.upgrade) {
        const notice = el('span', 'lobby-muted lobby-map-notice', i.upgrade.message);
        notice.setAttribute('role', 'status');
        this.mapInfo.append(notice);
      }
    }

    this.moddedBox.hidden = !this.pendingMap;
    if (this.pendingMap) {
      const i = this.pendingMap.info;
      this.moddedName.textContent = `"${i.name}" by ${i.author}`;
      this.fileField.hidden = false;
    }

    this.mapErrorList.textContent = '';
    this.mapErrorList.hidden = this.mapErrors.length === 0;
    for (const e of this.mapErrors) this.mapErrorList.append(el('li', null, e));

    this.importBox.textContent = '';
    this.importBox.hidden = !this.importReport;
    if (this.importReport) {
      const head = el('div', 'lobby-import-head');
      head.append(el('strong', null, 'OpenRA map import'));
      const close = el('button', 'lobby-btn', 'Hide report');
      close.type = 'button';
      close.addEventListener('click', () => {
        this.importReport = null;
        this.renderMapSource();
      });
      head.append(close);
      this.importBox.append(head, renderReport(this.importReport));
    }
    this.renderCaption();
  }

  renderSeed() {
    this.seedInput.value = String(this.state.seed);
    this.seedInput.setAttribute('aria-invalid', 'false');
  }

  renderUnits() {
    this.unitsInput.value = String(this.state.stressUnits);
    this.unitsInput.setAttribute('aria-invalid', 'false');
  }

  renderSlot(slot) {
    const p = this.state.players[slot];
    const rec = this.slotRows[slot];
    // Parts of the slot the map file locks (map format version 2).
    const setup = this.mapFile?.info.setup ?? null;
    const locked = (part) => slotLockedBy(this.state, setup, slot, part);
    const lockControl = (control, part) => {
      if (!control) return;
      if (locked(part)) {
        control.disabled = true;
        control.title = 'Locked by the map';
      }
    };
    lockControl(rec.faction, 'faction');
    lockControl(rec.team, 'team');
    lockControl(rec.type, 'type');
    if (locked('color')) this.pickers[slot].button.disabled = true;
    const f = FACTIONS.get(p.faction);
    rec.row.className = `lobby-slot lobby-slot-${p.type}`;
    rec.row.style.setProperty('--slot-color', p.type === 'closed' ? 'var(--l-edge)' : rgbCss(this.colors[p.color]));
    rec.flag.dataset.faction = p.faction;
    rec.desc.textContent = p.type === 'closed' ? 'Nobody plays in this slot.' : f.desc;
    this.pickers[slot].render();
    this.renderSpawnChoice(slot);
  }

  /**
   * Slot `slot`'s start position list: Automatic (with the spawn it gives
   * now), then the spawns of the map no other slot picked.
   */
  renderSpawnChoice(slot) {
    const p = this.state.players[slot];
    const select = this.slotRows[slot]?.spawn;
    if (!select) return;
    select.textContent = '';
    const option = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.append(o);
    };
    const auto = this.markerList.find((m) => m.slot === slot && !m.picked);
    option('auto', auto ? `Automatic (${auto.letter})` : 'Automatic');
    for (const m of this.markerList) {
      const other = this.state.players.some((q, i) => i !== slot && q.type !== 'closed' && q.spawn === m.index);
      if (!other) option(String(m.index), `Position ${m.letter}`);
    }
    select.value = Number.isInteger(p.spawn) && this.markerList.some((m) => m.index === p.spawn) ? String(p.spawn) : 'auto';
    select.disabled = p.type === 'closed' || this.markerList.length === 0;
    select.title = [...select.querySelectorAll('option')].find((o) => o.value === select.value)?.textContent ?? '';
  }

  /** The number of spawns of the battlefield the lobby shows. */
  spawnCount() {
    return battlefieldSpawns({ mapSpawns: this.state.mapSource === 'file' && this.mapFile ? this.mapFile.info.spawns : null, players: activeCount(this.state) });
  }

  /**
   * The picks belong to one battlefield: on another map, seed, size, style
   * or (generated maps) player count they are cleared, like OpenRA clears
   * them on a map change; picks a smaller map cannot hold go too.
   */
  syncSpawnField() {
    const key = battlefieldKey(this.state, this.mapFile?.info.hash ?? null);
    if (this.spawnField !== null && key !== this.spawnField) clearSpawnPicks(this.state);
    this.spawnField = key;
    settleSpawnPicks(this.state, this.spawnCount());
  }

  /** Carry out a pick on the preview or in a slot's start list ({ slot, spawn }: spawn null is automatic). */
  pickSpawn({ slot, spawn }) {
    this.syncSpawnField();
    if (setSpawnPick(this.state, slot, spawn, this.spawnCount())) this.schedulePreview();
    // Keep the list in step even when nothing changed (a refused pick).
    this.renderSpawnChoice(slot);
    this.renderProblem();
  }

  /** Show why the game cannot start (or a one-off message), and gate the start button. */
  renderProblem(message) {
    const problem = startProblem(this.state, this.mapFileStatus());
    this.problemText.textContent = message || problem || '';
    if (!this.blocked) this.startBtn.disabled = Boolean(problem);
  }

  renderCaption() {
    let text;
    if (this.state.mapSource === 'file' && this.mapFile) {
      const i = this.mapFile.info;
      text = `${i.name}, ${i.width} x ${i.height}`;
    } else {
      const m = MAP_SIZES.find((x) => x.value === this.state.mapSize);
      // Random style and biome: name what the seed picks.
      const look = this.maps?.describe ? `, ${this.maps.describe(this.state.seed, this.state.mapStyle, this.state.biome)}` : '';
      text = `${m.label} ${m.value} x ${m.value}${look}, ${activeCount(this.state)} players, seed ${this.state.seed}`;
    }
    this.caption.textContent = text;
    this.canvas.setAttribute('aria-label', `Map preview: ${text}`);
  }

  schedulePreview() {
    if (this.previewFrame) return;
    this.previewFrame = requestAnimationFrame(() => {
      this.previewFrame = 0;
      this.drawPreview();
    });
  }

  /** Spawn cells of the generated map, cached per seed, size, player count and style (the style shapes the map). */
  generatedSpawns(seed, size, players, style) {
    const key = `${seed}/${size}/${players}/${style}`;
    if (this.spawnCache.key !== key) this.spawnCache = { key, cells: this.maps.spawns(seed, size, players, style) };
    return this.spawnCache.cells;
  }

  drawPreview() {
    const file = this.state.mapSource === 'file' && this.mapFile;
    const n = activeCount(this.state);
    this.syncSpawnField();
    let width;
    let height;
    let spawns = [];
    try {
      let data;
      if (file) {
        ({ width, height } = this.mapFile.info);
        data = this.maps.filePreview(this.mapFile.json);
        spawns = this.mapFile.info.spawnCells;
      } else {
        width = height = this.state.mapSize;
        if (this.maps) {
          data = this.maps.preview(this.state.seed, width, n, this.state.mapStyle, this.state.biome);
          spawns = this.generatedSpawns(this.state.seed, width, n, this.state.mapStyle);
        } else {
          data = this.legacyPreview(this.state.seed, width);
        }
      }
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.canvas.style.aspectRatio = `${width} / ${height}`;
      const expected = width * height * 4;
      if (!data || typeof data.length !== 'number' || data.length !== expected) {
        throw new Error(`map preview returned ${data ? data.length : data} bytes, expected ${expected}`);
      }
      // Copy: the source may be a view into wasm memory that can move.
      this.ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
      this.previewFail.hidden = true;
    } catch (err) {
      console.error('Lobby map preview failed:', err);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.previewFail.hidden = false;
      spawns = [];
      this.lens?.clearSource();
      this.renderMarkers(spawns, width, height);
      return;
    }
    this.renderMarkers(spawns, width, height);
    this.setLensSource(file, width, height, n);
  }

  /**
   * The lens over the preview shows the same map, read when the pointer
   * first rests on it: a map file, or the generated map with the tech
   * buildings a game gets. The map's actors of player k take that player's colour.
   */
  setLensSource(file, width, height, players) {
    if (!this.lens) return;
    // The map's actors of player k (the k-th slot that plays, wherever it
    // starts) in that player's colour; colours change without reading the map again.
    const colors = this.state.players.filter((p) => p.type !== 'closed').map((p) => this.colors[p.color]);
    if (file) {
      const json = this.mapFile.json;
      this.lens.setSource(`file:${this.mapFile.info.hash}`, (art) => art.mapSteps(json), { width, height });
    } else if (this.maps) {
      const { seed, mapStyle: style, biome, techBuildings: tech } = this.state;
      this.lens.setSource(`gen:${seed}/${width}/${players}/${style}/${biome}/${tech}`, (art) => art.generatedSteps({ seed, size: width, players, style, biome, tech }), { width, height });
    } else {
      this.lens.clearSource();
      return;
    }
    this.lens.setColors?.(colors);
  }

  /** Lay the start markers over the preview (and into the lens); returns them (lobby-state spawnMarkers). */
  renderMarkers(spawns, width, height) {
    const list = spawnMarkers(spawns, width, height, this.state);
    this.markerList = list;
    const you = this.state.players.findIndex((p) => p.type === 'human');
    this.spawnLayer.render(list, {
      slots: this.state.players,
      you,
      host: true,
      colors: this.colors,
      nameOf: (k) => (this.state.players[k].type === 'human' ? cleanName(this.state.players[k].name) : aiName(this.state.players[k])),
      enabled: list.length > 0,
    });
    this.state.players.forEach((_, slot) => this.renderSpawnChoice(slot));
    return list;
  }

  // ---- Actions -------------------------------------------------------------------

  setColor(slot, color) {
    if (!setColor(this.state, slot, color)) return;
    this.state.players.forEach((_, s) => this.renderSlot(s));
    this.schedulePreview();
  }

  closePickers(except) {
    for (const p of this.pickers) if (p !== except) p.close(false);
  }

  /** Commit the seed field; focus it and return false when it is invalid. */
  commitSeed() {
    const seed = parseSeed(this.seedInput.value);
    if (seed === null) {
      this.seedInput.setAttribute('aria-invalid', 'true');
      this.seedInput.focus();
      return false;
    }
    this.state.seed = seed;
    return true;
  }

  persist() {
    const stored = { ...storedSettings(this.state), mode: this.modePicker.preferred ?? null };
    const me = stored.players?.find((p) => p.type === 'human');
    // Name, faction and colour of the player's own slot are also the account-wide defaults.
    defaultRegistry().patch('lobby', { lastOptions: stored, ...(me ? { name: me.name, faction: me.faction, color: me.color } : {}) });
  }

  start() {
    if (this.blocked || this.startBtn.disabled) return;
    // The seed field shows (and counts) only for a generated map.
    if (this.state.mapSource !== 'file' && !this.commitSeed()) return;
    const human = this.slotRows.find((r) => r.name);
    if (human) {
      const slot = this.slotRows.indexOf(human);
      this.state.players[slot].name = cleanName(human.name.value);
      human.name.value = this.state.players[slot].name;
    }
    const problem = startProblem(this.state, this.mapFileStatus());
    if (problem) {
      this.renderProblem();
      return;
    }
    this.closePickers(null);
    const options = this.getOptions();
    // A map file: the engine still draws crates, random factions, the AI and
    // the weather from the seed, and the hidden generator seed must not
    // decide them game after game. Each start gets a new one (the replay,
    // saves and Restart keep it); the lobby keeps its seed for the generated map.
    if (this.state.mapSource === 'file') options.seed = randomSeed();
    this.persist();
    this.onStart(options);
  }

  stress() {
    if (this.blocked || this.stressBtn.disabled) return;
    if (!this.commitSeed()) return;
    const units = parseUnits(this.unitsInput.value);
    if (units === null) {
      this.unitsInput.setAttribute('aria-invalid', 'true');
      this.unitsInput.focus();
      return;
    }
    this.state.stressUnits = units;
    this.closePickers(null);
    this.persist();
    this.onStress({ seed: this.state.seed, units });
  }

  /** Enter anywhere on the visible lobby starts the game. */
  handleEnter(e) {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.repeat) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (this.root.hidden || !this.root.isConnected || this.root.getClientRects().length === 0) return;
    const t = e.target;
    const onPage = t === document.body || t === document.documentElement || this.root.contains(t);
    if (!onPage) return;
    // Buttons handle Enter themselves; an open colour list picks a colour.
    if (t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement) return;
    // A bulk edit checkbox selects rows; Enter there must not start the game.
    if (t?.classList?.contains('bulk-pick')) return;
    if (this.pickers.some((p) => p.open)) return;
    e.preventDefault();
    this.start();
  }
}
