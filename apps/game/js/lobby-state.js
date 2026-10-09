// Skirmish lobby state without DOM: value sets, stored-settings migration,
// slot editing rules and the options handed to the engine. lobby.js renders
// this state; the functions here are pure (or only mutate the state passed in)
// so they run under Node tests.

// The last setup is kept in the settings registry (js/registry.js, group
// "lobby"), which migrated the older keys webra.lobby.v2 and v1.
import { assignSpawns } from '../protocol/spawns.js';

/** The installed map file lives in its own key (it can be large). */
export const MAP_STORAGE_KEY = 'webra.lobby.map.v1';

// Seeds stay within int32 so they survive any wasm integer parameter.
export const SEED_MAX = 0x7fffffff;
export const NAME_MAX = 20;
export const DEFAULT_NAME = 'Commander';

export const UNITS_MIN = 1;
export const UNITS_MAX = 20000;
export const UNITS_DEFAULT = 1000;

export const MIN_PLAYERS = 2;
export const MAX_SLOTS = 8;
export const TEAM_COUNT = 4;
/** Map files larger than this are rejected (docs/contracts.md section 2). */
export const MAP_FILE_MAX_BYTES = 1024 * 1024;

export const MODDED_WARNING =
  'This map changes game rules (costs, damage, speed...). It can be unfair or act as a cheat.';

export const MAP_SIZES = [
  { value: 64, label: 'Small' },
  { value: 96, label: 'Medium' },
  { value: 128, label: 'Large' },
  { value: 160, label: 'Huge' },
];

/** Generated map layouts (engine/src/mapgen); Random picks one from the seed. */
export const MAP_STYLES = [
  { value: 'random', label: 'Random' },
  { value: 'land', label: 'Land' },
  { value: 'rivers', label: 'Rivers' },
  { value: 'lakes', label: 'Lakes' },
  { value: 'islands', label: 'Islands' },
];

/** Biomes of a generated map (engine/src/weather.rs); Random picks one from the seed. */
export const BIOMES = [
  { value: 'random', label: 'Random' },
  { value: 'temperate', label: 'Temperate' },
  { value: 'snow', label: 'Snow' },
  { value: 'desert', label: 'Desert' },
];

/** What weather does: everything, visuals only, or nothing. */
export const WEATHER_MODES = [
  { value: 'full', label: 'On' },
  { value: 'cosmetic', label: 'Cosmetic only' },
  { value: 'off', label: 'Off' },
];

export const STARTING_CASH = [2500, 5000, 7500, 10000, 20000];

export const STARTING_UNITS = [
  { value: 'mcv', label: 'MCV only' },
  { value: 'light', label: 'Light support' },
  { value: 'heavy', label: 'Heavy support' },
  { value: 'base', label: 'Construction Yard' },
];

export const TECH_LEVELS = [
  { value: 'infonly', label: 'Infantry only' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'No superweapons' },
  { value: 'unrestricted', label: 'Unrestricted' },
];

/** OpenRA TimeLimitManager: minutes, 0 for none (the most experienced side wins when time runs out). */
export const TIME_LIMITS = [0, 10, 20, 30, 40, 60, 90].map((v) => ({ value: v, label: v === 0 ? 'No limit' : `${v} minutes` }));

/** OpenRA handicaps: 0 to 95 percent in steps of 5 (less firepower and armour, slower production). */
export const HANDICAPS = Array.from({ length: 20 }, (_, i) => ({ value: i * 5, label: `${i * 5}%` }));

export const GAME_SPEEDS = [
  { value: 'slowest', label: 'Slowest' },
  { value: 'slower', label: 'Slower' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
  { value: 'faster', label: 'Faster' },
  { value: 'fastest', label: 'Fastest' },
];

export const DIFFICULTIES = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];

/** Slot type choices; AI difficulty is part of the type. */
export const SLOT_TYPES = [
  { value: 'human', label: 'You' },
  { value: 'ai:easy', label: 'AI (Easy)' },
  { value: 'ai:normal', label: 'AI (Normal)' },
  { value: 'ai:hard', label: 'AI (Hard)' },
  { value: 'closed', label: 'Closed' },
];

export const TEAMS = [{ value: 0, label: 'None' }].concat(
  Array.from({ length: TEAM_COUNT }, (_, i) => ({ value: i + 1, label: `Team ${i + 1}` })),
);

export const FACTION_GROUPS = [
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

export const FACTIONS = new Map();
for (const g of FACTION_GROUPS) for (const f of g.items) FACTIONS.set(f.value, f);

/**
 * Side of a lobby faction choice, for the UI theme: 'allies', 'soviet', or
 * null when it is not known yet (plain Random).
 */
export function factionSide(faction) {
  if (faction === 'randomallies') return 'allies';
  if (faction === 'randomsoviet') return 'soviet';
  const group = FACTION_GROUPS.find((g) => g.label !== 'Random' && g.items.some((f) => f.value === faction));
  return group ? group.label.toLowerCase() : null;
}

export const DEFAULTS = {
  mapSize: 96,
  mapStyle: 'random',
  biome: 'random',
  weather: 'full',
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  cheats: false,
  // OpenRA's other lobby options (packages/protocol DEFAULT_OPTIONS).
  crates: true,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
};

const DEFAULT_PLAYERS = [
  { type: 'human', name: DEFAULT_NAME, faction: 'germany', color: 0, team: 0, handicap: 0 },
  { type: 'ai', difficulty: 'normal', faction: 'randomsoviet', color: 1, team: 0, handicap: 0 },
];

// ---- Small parsers ------------------------------------------------------------

export function randomSeed() {
  if (globalThis.crypto && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0] & SEED_MAX;
  }
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

/** Parse a non-negative integer seed; null when the text is not one. */
export function parseSeed(text) {
  const s = String(text).trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= SEED_MAX ? n : null;
}

export function parseUnits(text) {
  const s = String(text).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= UNITS_MIN && n <= UNITS_MAX ? n : null;
}

/**
 * Without a stored setup (a new device of a signed-in player), the player's
 * slot takes the account-wide name, faction and colour (`lobby`: the
 * registry's lobby group). A stored setup is returned as it is.
 */
export function withDefaults(stored, lobby, colorCount) {
  if (stored && Array.isArray(stored.players) && stored.players.length) return stored;
  const players = DEFAULT_PLAYERS.map((p) =>
    p.type === 'human'
      ? {
          ...p,
          name: cleanName(lobby?.name),
          faction: FACTIONS.has(lobby?.faction) ? lobby.faction : p.faction,
          color: Number.isInteger(lobby?.color) && lobby.color >= 0 && lobby.color < colorCount ? lobby.color : p.color,
        }
      : { ...p },
  );
  return { ...(stored ?? {}), players };
}

export function cleanName(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || DEFAULT_NAME;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// ---- Map size per player count --------------------------------------------------

/**
 * Smallest generated map that leaves room for every base: three or four
 * bases sit in two rows, five to eight on a ring around the centre, so more
 * players need a larger map.
 */
export function minMapSize(players) {
  return players <= 4 ? 64 : 96;
}

/** The size the lobby recommends for this many players. */
export function suggestedMapSize(players) {
  if (players <= 4) return 96;
  if (players <= 6) return 128;
  return 160;
}

// ---- Slots ------------------------------------------------------------------------

export function slotTypeValue(p) {
  return p.type === 'ai' ? `ai:${p.difficulty}` : p.type;
}

export function activeSlots(state) {
  return state.players.map((p, slot) => ({ p, slot })).filter(({ p }) => p.type !== 'closed');
}

export function activeCount(state) {
  return activeSlots(state).length;
}

function firstFreeColor(players, colorCount, except = -1) {
  const used = new Set(players.filter((_, s) => s !== except).map((p) => p.color));
  for (let c = 0; c < colorCount; c++) if (!used.has(c)) return c;
  return 0;
}

/** Give every slot a distinct colour, keeping earlier slots' choices. */
function uniqueColors(players, colorCount) {
  const used = new Set();
  for (const p of players) {
    if (!Number.isInteger(p.color) || p.color < 0 || p.color >= colorCount || used.has(p.color)) {
      p.color = 0;
      while (used.has(p.color) && p.color < colorCount - 1) p.color++;
    }
    used.add(p.color);
  }
}

function sanitizePlayer(raw, fallback) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const type = oneOf(p.type, ['human', 'ai', 'closed'], fallback.type);
  return {
    type,
    name: cleanName(typeof p.name === 'string' ? p.name : fallback.name),
    difficulty: oneOf(p.difficulty, DIFFICULTIES.map((d) => d.value), 'normal'),
    faction: FACTIONS.has(p.faction) ? p.faction : fallback.faction,
    color: p.color,
    team: Number.isInteger(p.team) && p.team >= 0 && p.team <= TEAM_COUNT ? p.team : 0,
    handicap: oneOf(p.handicap, HANDICAPS.map((h) => h.value), 0),
  };
}

/**
 * Turn stored (untrusted) data into a complete, valid lobby state. Accepts
 * the current format and the two-slot format of `webra.lobby.v1`.
 */
export function sanitizeState(stored, colorCount, seedFn = randomSeed) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const bool = (key) => (typeof s[key] === 'boolean' ? s[key] : DEFAULTS[key]);
  const seed = Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= SEED_MAX ? s.seed : seedFn();

  const state = {
    seed,
    mapSize: oneOf(s.mapSize, MAP_SIZES.map((m) => m.value), DEFAULTS.mapSize),
    mapStyle: oneOf(s.mapStyle, MAP_STYLES.map((m) => m.value), DEFAULTS.mapStyle),
    biome: oneOf(s.biome, BIOMES.map((m) => m.value), DEFAULTS.biome),
    weather: oneOf(s.weather, WEATHER_MODES.map((m) => m.value), DEFAULTS.weather),
    mapSource: oneOf(s.mapSource, ['random', 'file'], 'random'),
    startingCash: oneOf(s.startingCash, STARTING_CASH, DEFAULTS.startingCash),
    startingUnits: oneOf(s.startingUnits, STARTING_UNITS.map((o) => o.value), DEFAULTS.startingUnits),
    techLevel: oneOf(s.techLevel, TECH_LEVELS.map((o) => o.value), DEFAULTS.techLevel),
    gameSpeed: oneOf(s.gameSpeed, GAME_SPEEDS.map((o) => o.value), DEFAULTS.gameSpeed),
    timeLimit: oneOf(s.timeLimit, TIME_LIMITS.map((o) => o.value), DEFAULTS.timeLimit),
    crates: bool('crates'),
    shortGame: bool('shortGame'),
    bounty: bool('bounty'),
    separateTeamSpawns: bool('separateTeamSpawns'),
    allyBuildRadius: bool('allyBuildRadius'),
    fog: bool('fog'),
    explored: bool('explored'),
    buildRadius: bool('buildRadius'),
    redeployableMcv: bool('redeployableMcv'),
    oreRegrowth: bool('oreRegrowth'),
    cheats: bool('cheats'),
    stressUnits:
      Number.isInteger(s.stressUnits) && s.stressUnits >= UNITS_MIN && s.stressUnits <= UNITS_MAX
        ? s.stressUnits
        : UNITS_DEFAULT,
    players: [],
  };

  const storedPlayers = Array.isArray(s.players) ? s.players.slice(0, MAX_SLOTS) : [];
  const count = Math.max(MIN_PLAYERS, storedPlayers.length);
  for (let i = 0; i < count; i++) {
    const fallback = DEFAULT_PLAYERS[i] ?? { type: 'ai', faction: 'random', name: DEFAULT_NAME };
    state.players.push(sanitizePlayer(storedPlayers[i], fallback));
  }

  // Exactly one local human: keep the first, later ones become AI players.
  let human = state.players.findIndex((p) => p.type === 'human');
  state.players.forEach((p, i) => {
    if (p.type === 'human' && i !== human) p.type = 'ai';
  });
  if (human < 0) {
    human = 0;
    state.players[0].type = 'human';
  }
  // At least two players take part: reopen closed slots as AI.
  for (const p of state.players) {
    if (activeCount(state) >= MIN_PLAYERS) break;
    if (p.type === 'closed') p.type = 'ai';
  }
  uniqueColors(state.players, colorCount);
  return state;
}

/** Whether another slot can be added (at most 8, and no more than the map's spawns). */
export function canAddSlot(state, spawnLimit = MAX_SLOTS) {
  return state.players.length < MAX_SLOTS && activeCount(state) < spawnLimit;
}

/** Add an AI slot with the first free colour. Returns the new slot or -1. */
export function addSlot(state, colorCount, spawnLimit = MAX_SLOTS) {
  if (!canAddSlot(state, spawnLimit)) return -1;
  state.players.push({
    type: 'ai',
    name: DEFAULT_NAME,
    difficulty: 'normal',
    faction: 'random',
    color: firstFreeColor(state.players, colorCount),
    team: 0,
    handicap: 0,
  });
  return state.players.length - 1;
}

/** Whether a slot can be removed: never the human, never below two players. */
export function canRemoveSlot(state, slot) {
  const p = state.players[slot];
  if (!p || p.type === 'human' || state.players.length <= MIN_PLAYERS) return false;
  return p.type === 'closed' || activeCount(state) > MIN_PLAYERS;
}

export function removeSlot(state, slot) {
  if (!canRemoveSlot(state, slot)) return false;
  state.players.splice(slot, 1);
  return true;
}

/**
 * Change a slot's type ('human', 'ai:<difficulty>' or 'closed'). There is one
 * local human: choosing 'You' on another slot moves the human there and the
 * old human slot becomes a Normal AI. The human slot itself cannot be turned
 * into something else. Returns whether anything changed.
 */
export function setSlotType(state, slot, value, spawnLimit = MAX_SLOTS) {
  const p = state.players[slot];
  if (!p) return false;
  const [type, difficulty] = String(value).split(':');
  if (p.type === 'human') return false;
  if (type === 'human') {
    if (p.type === 'closed' && activeCount(state) >= spawnLimit) return false;
    const old = state.players.find((q) => q.type === 'human');
    if (old) {
      old.type = 'ai';
      old.difficulty = 'normal';
      p.name = old.name;
    }
    p.type = 'human';
    return true;
  }
  if (type === 'ai') {
    if (!DIFFICULTIES.some((d) => d.value === difficulty)) return false;
    if (p.type === 'closed' && activeCount(state) >= spawnLimit) return false;
    p.type = 'ai';
    p.difficulty = difficulty;
    return true;
  }
  if (type === 'closed') {
    if (p.type !== 'closed' && activeCount(state) <= MIN_PLAYERS) return false;
    p.type = 'closed';
    return true;
  }
  return false;
}

/** Pick a colour; a colour used by another slot is swapped with it. */
export function setColor(state, slot, color) {
  const players = state.players;
  const prev = players[slot].color;
  if (prev === color) return false;
  for (let s = 0; s < players.length; s++) {
    if (s !== slot && players[s].color === color) players[s].color = prev;
  }
  players[slot].color = color;
  return true;
}

// ---- Starting ----------------------------------------------------------------------

/**
 * Why the game cannot start with this setup, or null when it can.
 * @param {object} state
 * @param {{spawns: number} | null} mapFile the installed map file, if one is used
 */
export function startProblem(state, mapFile) {
  const active = activeSlots(state);
  if (active.length < MIN_PLAYERS) return 'A game needs at least two players.';
  if (!active.some(({ p }) => p.type === 'human')) return 'One slot must be you.';
  if (state.mapSource === 'file') {
    if (!mapFile) return 'Load a map file or switch to a random map.';
    if (!mapFile.accepted) return 'Accept the modded map rules or pick another map.';
    if (active.length > mapFile.spawns) {
      return `This map has ${mapFile.spawns} start positions; close or remove ${active.length - mapFile.spawns} slot(s).`;
    }
  }
  const teams = new Set(active.map(({ p }) => p.team));
  if (teams.size === 1 && !teams.has(0)) return 'Everyone is on the same team: nobody to fight.';
  return null;
}

/**
 * The setup in the shape onStart receives (docs/contracts.md section 3), plus
 * `map`: the map file JSON, or null for a generated map.
 */
export function buildOptions(state, mapJson = null) {
  const s = state;
  return {
    seed: s.seed,
    mapSize: s.mapSize,
    mapStyle: s.mapStyle,
    biome: s.biome,
    weather: s.weather,
    players: s.players.map((p, slot) => {
      if (p.type === 'closed') return { slot, type: 'closed' };
      const base = { slot, type: p.type, faction: p.faction, color: p.color, team: p.team, handicap: p.handicap ?? 0 };
      return p.type === 'human' ? { ...base, name: cleanName(p.name) } : { ...base, difficulty: p.difficulty };
    }),
    startingCash: s.startingCash,
    startingUnits: s.startingUnits,
    techLevel: s.techLevel,
    gameSpeed: s.gameSpeed,
    timeLimit: s.timeLimit,
    crates: s.crates,
    shortGame: s.shortGame,
    bounty: s.bounty,
    separateTeamSpawns: s.separateTeamSpawns,
    allyBuildRadius: s.allyBuildRadius,
    fog: s.fog,
    explored: s.explored,
    buildRadius: s.buildRadius,
    redeployableMcv: s.redeployableMcv,
    oreRegrowth: s.oreRegrowth,
    cheats: s.cheats,
    map: s.mapSource === 'file' ? mapJson : null,
  };
}

/** What is kept in localStorage: the options without the map, plus lobby-only fields. */
export function storedSettings(state) {
  const { map: _map, ...options } = buildOptions(state);
  return { ...options, mapSource: state.mapSource, stressUnits: state.stressUnits };
}

// ---- Map files and spawn markers ----------------------------------------------------

/**
 * Check a map file's text. `validate` is the engine's Game.validate_map
 * (parsed). Returns { ok, errors, modded, hash, name, author, width, height, spawns }.
 */
export function inspectMapFile(text, validate) {
  const fail = (msg) => ({ ok: false, errors: [msg] });
  if (typeof text !== 'string' || text.length === 0) return fail('The file is empty.');
  if (new TextEncoder().encode(text).length > MAP_FILE_MAX_BYTES) return fail('The map file is larger than 1 MiB.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('The file is not valid JSON.');
  }
  let v;
  try {
    v = validate(text);
  } catch (err) {
    return fail(`Could not check the map: ${err?.message ?? err}`);
  }
  if (!v || !v.ok) return { ok: false, errors: v?.errors?.length ? v.errors : ['The map is not valid.'] };
  return {
    ok: true,
    errors: [],
    modded: Boolean(v.modded),
    hash: v.hash,
    name: String(data.name),
    author: String(data.author),
    width: data.width,
    height: data.height,
    spawns: data.spawns.length,
    spawnCells: data.spawns.map(([x, y]) => [x, y]),
    // Optional in the format: absent means temperate (engine/src/mapdata.rs).
    biome: typeof data.biome === 'string' ? data.biome : 'temperate',
  };
}

/**
 * Start markers for the preview. Spawn k goes to the k-th taking-part slot
 * (closed slots are skipped, like the engine does), or with "Separate team
 * spawns" in a team game where protocol `assignSpawns` puts each player (as
 * the engine does, engine/src/gamerules.rs). Positions are percentages of
 * the map, at the centre of the 3 x 4 construction yard footprint.
 */
export function spawnMarkers(spawnCells, width, height, state) {
  const active = activeSlots(state);
  const at = new Map();
  if (active.length <= spawnCells.length) {
    assignSpawns(spawnCells, active.map(({ p }) => ({ team: p.team })), !!state.separateTeamSpawns, state.mapSource !== 'file').forEach((s, k) => at.set(s, active[k]));
  }
  return spawnCells.map(([x, y], k) => {
    const a = at.get(k);
    return {
      left: ((x + 1.5) / width) * 100,
      top: ((y + 2) / height) * 100,
      // Taken spawns show the player number; empty ones stay blank.
      number: a ? a.slot + 1 : null,
      slot: a ? a.slot : null,
      color: a ? a.p.color : null,
    };
  });
}
