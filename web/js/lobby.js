// Pre-game skirmish lobby: map preview, player slots and game options.
// All DOM is built once inside the given root. The chosen setup is reported
// through onStart / onStress; the last used setup is kept in localStorage
// when it is available and the lobby works the same without it.

const STORAGE_KEY = 'webra.lobby.v1';

// Seeds stay within int32 so they survive any wasm integer parameter.
const SEED_MAX = 0x7fffffff;
const NAME_MAX = 20;
const DEFAULT_NAME = 'Commander';

const UNITS_MIN = 1;
const UNITS_MAX = 20000;
const UNITS_DEFAULT = 1000;

const MAP_SIZES = [
  { value: 64, label: 'Small' },
  { value: 96, label: 'Medium' },
  { value: 128, label: 'Large' },
  { value: 160, label: 'Huge' },
];

const STARTING_CASH = [2500, 5000, 7500, 10000, 20000];

const STARTING_UNITS = [
  { value: 'mcv', label: 'MCV only' },
  { value: 'light', label: 'Light support' },
  { value: 'heavy', label: 'Heavy support' },
  { value: 'base', label: 'Construction Yard' },
];

const TECH_LEVELS = [
  { value: 'infonly', label: 'Infantry only' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'No superweapons' },
  { value: 'unrestricted', label: 'Unrestricted' },
];

const GAME_SPEEDS = [
  { value: 'slowest', label: 'Slowest' },
  { value: 'slower', label: 'Slower' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
  { value: 'faster', label: 'Faster' },
  { value: 'fastest', label: 'Fastest' },
];

const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];

const FACTION_GROUPS = [
  {
    label: 'Random',
    items: [
      { value: 'random', label: 'Random', desc: 'Random country' },
      { value: 'randomallies', label: 'Random Allies', desc: 'Random country' },
      { value: 'randomsoviet', label: 'Random Soviet', desc: 'Random country' },
    ],
  },
  {
    label: 'Allies',
    items: [
      { value: 'england', label: 'England', desc: 'Allies: British Spy and Mobile Gap Generator' },
      { value: 'france', label: 'France', desc: 'Allies: Phase Transport and fake structures' },
      { value: 'germany', label: 'Germany', desc: 'Allies: Chrono Tank and Advanced Chronoshift' },
    ],
  },
  {
    label: 'Soviet',
    items: [
      { value: 'russia', label: 'Russia', desc: 'Soviet: Tesla Tank and Shock Trooper' },
      { value: 'ukraine', label: 'Ukraine', desc: 'Soviet: Demolition Truck and Parabombs' },
    ],
  },
];

const FACTIONS = new Map();
for (const g of FACTION_GROUPS) for (const f of g.items) FACTIONS.set(f.value, f);

// Game option rows: the key in options, its label, tooltip and choices.
const SELECT_OPTIONS = [
  {
    key: 'startingCash',
    label: 'Starting cash',
    title: 'The amount of credits that players start the game with.',
    choices: STARTING_CASH.map((v) => ({ value: v, label: `$${v.toLocaleString('en-US')}` })),
  },
  {
    key: 'startingUnits',
    label: 'Starting units',
    title: 'The units that players start the game with.',
    choices: STARTING_UNITS,
  },
  {
    key: 'techLevel',
    label: 'Tech level',
    title: 'The units and structures that can be built.',
    choices: TECH_LEVELS,
  },
  {
    key: 'gameSpeed',
    label: 'Game speed',
    title: 'The rate at which game time passes.',
    choices: GAME_SPEEDS,
  },
];

const TOGGLE_OPTIONS = [
  { key: 'fog', label: 'Fog of war', title: 'Line of sight is required to view enemy forces.' },
  { key: 'explored', label: 'Explored map', title: 'The initial map shroud is revealed: no black shroud at game start.' },
  { key: 'buildRadius', label: 'Build radius', title: 'Limits structure placement to areas around a Construction Yard.' },
  { key: 'redeployableMcv', label: 'Redeployable MCVs', title: 'Allows undeploying a Construction Yard back into an MCV.' },
  { key: 'oreRegrowth', label: 'Ore regrowth', title: 'Ore fields slowly grow back after they have been harvested.' },
];

const DEFAULTS = {
  mapSize: 96,
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
};

const DEFAULT_PLAYERS = [
  { type: 'human', name: DEFAULT_NAME, faction: 'germany', color: 0 },
  { type: 'ai', difficulty: 'normal', faction: 'randomsoviet', color: 1 },
];

let uid = 0;

/** Create an element with an optional class and text. */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function randomSeed() {
  if (globalThis.crypto && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0] & SEED_MAX;
  }
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

/** Parse a non-negative integer seed; null when the text is not one. */
function parseSeed(text) {
  const s = String(text).trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= SEED_MAX ? n : null;
}

function parseUnits(text) {
  const s = String(text).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= UNITS_MIN && n <= UNITS_MAX ? n : null;
}

function cleanName(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || DEFAULT_NAME;
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

/** Build a <select>; choices are {value,label} or groups {label, items}. */
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

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// ---- Storage ---------------------------------------------------------------

function loadStored() {
  let raw = null;
  try {
    raw = globalThis.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
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

function saveStored(data) {
  try {
    if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full, blocked or unavailable: the lobby simply forgets.
  }
}

/** Turn stored (untrusted) data into a complete, valid lobby state. */
function sanitizeState(stored, colorCount) {
  const s = stored || {};
  const bool = (key) => (typeof s[key] === 'boolean' ? s[key] : DEFAULTS[key]);
  const seed = Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= SEED_MAX ? s.seed : randomSeed();

  const state = {
    seed,
    mapSize: oneOf(s.mapSize, MAP_SIZES.map((m) => m.value), DEFAULTS.mapSize),
    startingCash: oneOf(s.startingCash, STARTING_CASH, DEFAULTS.startingCash),
    startingUnits: oneOf(s.startingUnits, STARTING_UNITS.map((o) => o.value), DEFAULTS.startingUnits),
    techLevel: oneOf(s.techLevel, TECH_LEVELS.map((o) => o.value), DEFAULTS.techLevel),
    gameSpeed: oneOf(s.gameSpeed, GAME_SPEEDS.map((o) => o.value), DEFAULTS.gameSpeed),
    fog: bool('fog'),
    explored: bool('explored'),
    buildRadius: bool('buildRadius'),
    redeployableMcv: bool('redeployableMcv'),
    oreRegrowth: bool('oreRegrowth'),
    stressUnits: Number.isInteger(s.stressUnits) && s.stressUnits >= UNITS_MIN && s.stressUnits <= UNITS_MAX
      ? s.stressUnits
      : UNITS_DEFAULT,
    players: [],
  };

  const storedPlayers = Array.isArray(s.players) ? s.players : [];
  const used = new Set();
  DEFAULT_PLAYERS.forEach((def, i) => {
    const p = storedPlayers[i] && typeof storedPlayers[i] === 'object' ? storedPlayers[i] : {};
    const player = {
      type: def.type,
      faction: FACTIONS.has(p.faction) ? p.faction : def.faction,
      color: Number.isInteger(p.color) && p.color >= 0 && p.color < colorCount ? p.color : def.color,
    };
    if (def.type === 'human') player.name = cleanName(p.name);
    else player.difficulty = oneOf(p.difficulty, DIFFICULTIES.map((d) => d.value), def.difficulty);
    state.players.push(player);
  });

  // Colours must be unique; give any duplicate the first free colour.
  for (const p of state.players) {
    if (used.has(p.color)) {
      for (let c = 0; c < colorCount; c++) {
        if (!used.has(c)) {
          p.color = c;
          break;
        }
      }
    }
    used.add(p.color);
  }
  return state;
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
    this.button.title = 'Player color. Picking a color used by another player swaps the two.';
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
      return { node: o, tag };
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
    this.options.forEach(({ node, tag }, i) => {
      const owner = players.findIndex((p, s) => s !== this.slot && p.color === i);
      node.setAttribute('aria-selected', i === color ? 'true' : 'false');
      node.classList.toggle('taken', owner >= 0);
      tag.textContent = owner >= 0 ? `P${owner + 1}` : '';
      const label = this.lobby.colorName(i);
      node.title = owner >= 0 ? `${label}: used by Player ${owner + 1}, picking it swaps colors` : label;
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
   *   mapPreview: (seed: number, size: number) => Uint8Array,
   *   onStart: (options: object) => void,
   *   onStress: (opts: {seed: number, units: number}) => void,
   * }} config
   */
  constructor(root, config) {
    this.root = root;
    this.colors = config.colors;
    this.colorNames = config.colorNames || [];
    this.mapPreview = config.mapPreview;
    this.onStart = config.onStart;
    this.onStress = config.onStress;
    this.blocked = false;
    this.previewFrame = 0;

    this.state = sanitizeState(loadStored(), this.colors.length);
    this.pickers = [];
    this.slotRows = [];

    this.build();
    this.renderAll();
    this.schedulePreview();

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
    const s = this.state;
    return {
      seed: s.seed,
      mapSize: s.mapSize,
      players: s.players.map((p, slot) =>
        p.type === 'human'
          ? { slot, type: 'human', name: cleanName(p.name), faction: p.faction, color: p.color }
          : { slot, type: 'ai', difficulty: p.difficulty, faction: p.faction, color: p.color },
      ),
      startingCash: s.startingCash,
      startingUnits: s.startingUnits,
      techLevel: s.techLevel,
      gameSpeed: s.gameSpeed,
      fog: s.fog,
      explored: s.explored,
      buildRadius: s.buildRadius,
      redeployableMcv: s.redeployableMcv,
      oreRegrowth: s.oreRegrowth,
    };
  }

  // ---- DOM construction (once) ---------------------------------------------

  build() {
    this.root.textContent = '';
    const lobby = el('div', 'lobby');

    // Title bar.
    const head = el('header', 'lobby-head');
    const h1 = el('h1', 'lobby-logo', 'WEB');
    h1.append(el('span', null, 'RA'));
    const tag = el('p', 'lobby-tagline', 'Skirmish lobby. Pick your side, set the battlefield and deploy.');
    head.append(h1, tag);

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

  /** A label + control row; the whole row carries the tooltip. */
  field(labelText, control, title) {
    const row = el('label', 'lobby-field');
    if (title) row.title = title;
    row.append(el('span', 'lobby-field-label', labelText), control);
    return row;
  }

  buildMapPanel() {
    const { section, content } = this.panel('Battlefield', 'lobby-map');

    const frame = el('div', 'lobby-preview');
    this.canvas = el('canvas', 'lobby-preview-canvas');
    this.canvas.setAttribute('role', 'img');
    this.ctx = this.canvas.getContext('2d');
    this.previewFail = el('div', 'lobby-preview-fail', 'Preview unavailable');
    this.previewFail.hidden = true;
    frame.append(this.canvas, this.previewFail);
    this.caption = el('p', 'lobby-preview-caption');

    this.mapSizeSelect = buildSelect(
      MAP_SIZES.map((m) => ({ value: m.value, label: `${m.label} (${m.value} x ${m.value})` })),
      'lobby-select',
    );
    this.mapSizeSelect.addEventListener('change', () => {
      this.state.mapSize = Number(this.mapSizeSelect.value);
      this.renderCaption();
      this.schedulePreview();
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
    this.diceBtn.title = 'Generate a new random seed';
    this.diceBtn.setAttribute('aria-label', 'New seed');
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

    const fields = el('div', 'lobby-fields');
    fields.append(
      this.field('Map size', this.mapSizeSelect, 'Width and height of the generated map, in cells.'),
      this.field('Seed', seedRow, 'The same seed and map size always generate the same map. Share it to replay a battlefield.'),
    );

    content.append(frame, this.caption, fields);
    return section;
  }

  buildSidePanels() {
    const side = el('div', 'lobby-side');
    side.append(this.buildPlayersPanel(), this.buildOptionsPanel());
    return side;
  }

  buildPlayersPanel() {
    const { section, content } = this.panel('Players', 'lobby-players');
    const table = el('div', 'lobby-slots');
    table.setAttribute('role', 'table');

    const header = el('div', 'lobby-slot lobby-slot-head');
    header.setAttribute('role', 'row');
    for (const h of ['Player', 'Color', 'Faction', 'Difficulty']) {
      const c = el('div', 'lobby-cell', h);
      c.setAttribute('role', 'columnheader');
      header.append(c);
    }
    table.append(header);

    this.state.players.forEach((p, slot) => table.append(this.buildSlot(p, slot)));
    content.append(table);
    return section;
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

    // Player name / type.
    const who = cell('lobby-cell-player', 'Player');
    const badge = el('span', 'lobby-badge', `P${slot + 1}`);
    if (player.type === 'human') {
      const name = el('input', 'lobby-input lobby-name');
      name.type = 'text';
      name.maxLength = NAME_MAX;
      name.autocomplete = 'off';
      name.spellcheck = false;
      name.placeholder = DEFAULT_NAME;
      name.setAttribute('aria-label', 'Player name');
      name.title = 'Your name in this game';
      name.addEventListener('input', () => {
        this.state.players[slot].name = name.value;
      });
      name.addEventListener('change', () => {
        this.state.players[slot].name = cleanName(name.value);
        name.value = this.state.players[slot].name;
      });
      rec.name = name;
      who.append(badge, name);
    } else {
      const label = el('span', 'lobby-ai-name');
      label.append(el('span', null, 'Computer'), el('small', null, 'AI opponent'));
      who.append(badge, label);
    }

    // Colour.
    const colorCell = cell('lobby-cell-color', 'Color');
    const picker = new ColorPicker(this, slot);
    this.pickers[slot] = picker;
    colorCell.append(picker.root);

    // Faction.
    const factionCell = cell('lobby-cell-faction', 'Faction');
    factionCell.title = 'Your country. Random picks are resolved when the game starts.';
    const flag = el('span', 'lobby-flag');
    flag.setAttribute('aria-hidden', 'true');
    const faction = buildSelect(FACTION_GROUPS, 'lobby-select');
    faction.setAttribute('aria-label', `Player ${slot + 1} faction`);
    faction.addEventListener('change', () => {
      this.state.players[slot].faction = faction.value;
      this.renderSlot(slot);
    });
    const factionRow = el('div', 'lobby-faction-row');
    factionRow.append(flag, faction);
    const desc = el('p', 'lobby-faction-desc');
    factionCell.append(factionRow, desc);
    Object.assign(rec, { flag, faction, desc });

    // Difficulty (AI only).
    const diffCell = cell('lobby-cell-diff', 'Difficulty');
    if (player.type === 'ai') {
      const diff = buildSelect(DIFFICULTIES, 'lobby-select');
      diff.setAttribute('aria-label', `Player ${slot + 1} difficulty`);
      diff.title = 'How aggressively and efficiently the AI plays.';
      diff.addEventListener('change', () => {
        this.state.players[slot].difficulty = diff.value;
      });
      rec.difficulty = diff;
      diffCell.append(diff);
    } else {
      diffCell.classList.add('lobby-cell-empty');
      diffCell.append(el('span', 'lobby-muted', 'Human'));
    }

    this.slotRows[slot] = rec;
    return row;
  }

  buildOptionsPanel() {
    const { section, content } = this.panel('Game options', 'lobby-options');

    const selects = el('div', 'lobby-fields lobby-option-grid');
    this.optionSelects = {};
    for (const opt of SELECT_OPTIONS) {
      const select = buildSelect(opt.choices, 'lobby-select');
      select.addEventListener('change', () => {
        const numeric = typeof opt.choices[0].value === 'number';
        this.state[opt.key] = numeric ? Number(select.value) : select.value;
      });
      this.optionSelects[opt.key] = select;
      selects.append(this.field(opt.label, select, opt.title));
    }

    const toggles = el('div', 'lobby-toggles');
    this.optionToggles = {};
    for (const opt of TOGGLE_OPTIONS) {
      const row = el('label', 'lobby-toggle');
      row.title = opt.title;
      const box = el('input', 'lobby-check');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        this.state[opt.key] = box.checked;
      });
      this.optionToggles[opt.key] = box;
      row.append(box, el('span', null, opt.label));
      toggles.append(row);
    }

    content.append(selects, toggles);
    return section;
  }

  buildBar() {
    const bar = el('footer', 'lobby-bar');

    const stress = el('div', 'lobby-stress');
    stress.title = 'Spawns a large number of units on the current seed to measure performance.';
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
    stress.append(label, unitsField, this.stressBtn);

    this.startBtn = el('button', 'lobby-btn lobby-btn-primary', 'Start game');
    this.startBtn.type = 'button';
    this.startBtn.title = 'Start the skirmish (Enter)';
    this.startBtn.addEventListener('click', () => this.start());

    bar.append(stress, this.startBtn);
    return bar;
  }

  // ---- Rendering ---------------------------------------------------------------

  renderAll() {
    const s = this.state;
    this.renderSeed();
    this.renderUnits();
    this.mapSizeSelect.value = String(s.mapSize);
    for (const opt of SELECT_OPTIONS) this.optionSelects[opt.key].value = String(s[opt.key]);
    for (const opt of TOGGLE_OPTIONS) this.optionToggles[opt.key].checked = s[opt.key];
    s.players.forEach((p, slot) => {
      const rec = this.slotRows[slot];
      if (rec.name) rec.name.value = p.name;
      if (rec.difficulty) rec.difficulty.value = p.difficulty;
      rec.faction.value = p.faction;
      this.renderSlot(slot);
    });
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
    const f = FACTIONS.get(p.faction);
    rec.row.style.setProperty('--slot-color', rgbCss(this.colors[p.color]));
    rec.flag.dataset.faction = p.faction;
    rec.desc.textContent = f.desc;
    this.pickers[slot].render();
  }

  renderCaption() {
    const m = MAP_SIZES.find((x) => x.value === this.state.mapSize);
    const text = `${m.label} ${m.value} x ${m.value}, seed ${this.state.seed}`;
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

  drawPreview() {
    const size = this.state.mapSize;
    if (this.canvas.width !== size) this.canvas.width = size;
    if (this.canvas.height !== size) this.canvas.height = size;
    try {
      const data = this.mapPreview(this.state.seed, size);
      const expected = size * size * 4;
      if (!data || typeof data.length !== 'number' || data.length !== expected) {
        throw new Error(`map preview returned ${data ? data.length : data} bytes, expected ${expected}`);
      }
      // Copy: the source may be a view into wasm memory that can move.
      this.ctx.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
      this.previewFail.hidden = true;
    } catch (err) {
      console.error('Lobby map preview failed:', err);
      this.ctx.clearRect(0, 0, size, size);
      this.previewFail.hidden = false;
    }
  }

  // ---- Actions -------------------------------------------------------------------

  setColor(slot, color) {
    const players = this.state.players;
    const prev = players[slot].color;
    if (prev === color) return;
    for (let s = 0; s < players.length; s++) {
      if (s !== slot && players[s].color === color) players[s].color = prev;
    }
    players[slot].color = color;
    players.forEach((_, s) => this.renderSlot(s));
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
    const s = this.state;
    saveStored({ ...this.getOptions(), stressUnits: s.stressUnits });
  }

  start() {
    if (this.blocked || this.startBtn.disabled) return;
    if (!this.commitSeed()) return;
    const human = this.slotRows.find((r) => r.name);
    if (human) {
      const slot = this.slotRows.indexOf(human);
      this.state.players[slot].name = cleanName(human.name.value);
      human.name.value = this.state.players[slot].name;
    }
    this.closePickers(null);
    const options = this.getOptions();
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
    if (this.pickers.some((p) => p.open)) return;
    e.preventDefault();
    this.start();
  }
}
