// Online multiplayer UI: server browser, host dialog, password prompt, online
// lobby (slots, spectators, options, map, chat, ready, start), the modded-map
// warning (docs/contracts.md, section 2) and the in-game overlay (status and
// chat). Loaded on demand by main.js so local skirmish never depends on it.
//
// Reconnecting: the rejoin key from `welcome.key` is kept per tab in
// sessionStorage (with the session id and client id). When the connection
// drops during a game, this tab reconnects on its own with it and keeps its
// game (the server sends the order log, the driver catches up and resumes);
// after a page reload it rejoins and rebuilds the game from the log.
//
// Lobby maps (docs/security.md "Map sharing"): the host picks a generated
// map, a community map or one of its own maps (js/maplibrary.js: map editor
// maps, .oramap imports, maps from earlier lobbies), which it shares with
// this session only. A player without that map sees "Custom map: <name> by
// <author>. Install?": Install downloads it from the session (with this
// member's rejoin key), checks it with the protocol package and the engine,
// pins its hash and keeps it in the library; Decline leaves the player
// unready, and the host sees who lacks the map.
//
// Online saves: any player proposes saving; once every player accepted and
// reported the same state hash at the save point, every player's browser
// keeps the save file (js/saves.js). "Resume a saved game" creates a session,
// uploads the file (the server checks it against its record) and the lobby
// waits for the game's players, matched by account; the game then continues
// after the save point with every client fast-forwarded to it.
//
// Rematch: after (or during) a game the host proposes playing again with
// the same settings; every player accepts in the game overlay or the end of
// game dialog. The session goes back to its lobby and this page reloads,
// which brings it back into that lobby with the stored rejoin key.

import {
  CHAT_MAX,
  COLOR_COUNT,
  COOP_MISSIONS,
  coopMission,
  DEFAULT_MAX_SPECTATORS,
  formatInviteCode,
  normalizeInviteCode,
  DIFFICULTIES,
  BOTS,
  GAME_SPEEDS,
  incompatibleMapMessage,
  MAP_SIZES,
  mapHash,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  MODDED_WARNING,
  NAME_MAX,
  parseMap,
  PASSWORD_MAX,
  PROTOCOL_VERSION,
  ProtocolError,
  RECONNECT_GRACE_MS,
  SEAT_KEY_RE,
  SEED_MAX,
  SESSION_ID_RE,
  SESSION_NAME_MAX,
  SPEED_MS,
  STARTING_CASH,
  STARTING_UNITS,
  TEAM_MAX,
  TECH_LEVELS,
  TIME_LIMITS,
  MOVEMENT_MODELS,
  FACTORY_LOSS_RULES,
  HANDICAPS,
  MAP_STYLES,
  BIOMES,
  WEATHER_MODES,
  TECH_BUILDINGS,
  validName,
  optionLocked,
  slotLocked,
} from './protocol.js';
import { api, ApiError, Connection } from './net.js';
import { defaultRegistry } from './registry.js';
import { reportMessage } from './telemetry/index.js';
import { onlineRefusal } from './account/ui.js';
import { badge, led, segmented, selectPlate, setLed, stepper, switchInput, toggle } from './ui/controls.js';
import { infoTip, describedBy } from './infotip.js';
import { ModePicker } from './modepicker.js';
import { presetOptions } from './modes.js';
import { hasTeamChat } from './chatkeys.js';
import { touchUi } from './touch.js';
import { chatPrefix, TextLog } from './chatlog.js';
import { mapLibrary } from './maplibrary.js';
import { formatTicks } from './replay.js';
import { SaveStore } from './saves.js';
import { isOramapFile, ORAMAP_MAX_BYTES } from './oramap/index.js';
import { aiName, spawnMarkers } from './lobby-state.js';
import { SpawnMarkers } from './spawnpick.js';
import { planBulk } from './lobby-bulk.js';
import { BulkBar } from './lobby-bulkbar.js';
import { StalePreview, previewKey } from './mappreview.js';
import { battlefieldSpawns, generatedMapPlayers } from '../protocol/spawns.js';
import { NetQuality } from './netquality.js';
import { clearInviteFromLocation, createInvite, inviteFromLocation, inviteLink, inviteMsLeft } from './invites.js';
import { friendsView, sharedFriendsStore, useFriendsStore } from './friends-ui.js';
import { confirmChoice, joinCodeDialog, modal } from './online-dialog.js';
import {
  connectionCell,
  connectionWarning,
  filterSessions,
  friendSessionIds,
  inviteLeftText,
  notReady,
  onlineText,
  QUALITY_LEDS,
  selfConnection,
  SESSION_FILTERS,
  sessionDetail,
  sessionRow,
  startCheck,
  waitingText,
} from './online-view.js';

/** Per tab: { id, client, key, name } of the online game this tab is in (see the header). */
const REJOIN_KEY = 'webra.rejoin.v1';
/** Server error codes after which reconnecting cannot help. */
const FINAL_CODES = new Set([
  'forbidden',
  'kicked',
  'bad_state',
  'invalid',
  'bad_message',
  'not_found',
  'session_lost',
  'protocol_mismatch',
  'version_mismatch',
  'too_large',
  // Accounts (protocol 5, docs/accounts-api.md 7): reconnecting cannot help.
  'account_required',
  'account_inactive',
  'banned',
  'ip_banned',
]);
const REFRESH_MS = 10_000;
const CHAT_LINES = 200;

const FACTION_GROUPS = [
  ['Random', [['random', 'Random'], ['randomallies', 'Random Allies'], ['randomsoviet', 'Random Soviet']]],
  ['Allies', [['england', 'England'], ['france', 'France'], ['germany', 'Germany']]],
  ['Soviet', [['russia', 'Russia'], ['ukraine', 'Ukraine']]],
];
const LABELS = {
  startingUnits: { mcv: 'MCV only', light: 'Light support', heavy: 'Heavy support', base: 'Construction Yard' },
  techLevel: { infonly: 'Infantry only', low: 'Low', medium: 'Medium', high: 'No superweapons', unrestricted: 'Unrestricted' },
  gameSpeed: { slowest: 'Slowest', slower: 'Slower', normal: 'Normal', fast: 'Fast', faster: 'Faster', fastest: 'Fastest' },
  difficulty: { easy: 'Easy', normal: 'Normal', hard: 'Hard' },
  bot: { rush: 'Rush AI', normal: 'Normal AI', turtle: 'Turtle AI', naval: 'Naval AI' },
  mapSize: { 64: 'Small', 96: 'Medium', 128: 'Large', 160: 'Huge' },
  mapStyle: { random: 'Random', land: 'Land', rivers: 'Rivers', lakes: 'Lakes', islands: 'Islands' },
  biome: { random: 'Random', temperate: 'Temperate', snow: 'Snow', desert: 'Desert' },
  weather: { full: 'On', cosmetic: 'Cosmetic only', off: 'Off' },
  techBuildings: { none: 'None', standard: 'Standard', extra: 'Extra', oilonly: 'Oil only', oilrush: 'Oil rush' },
  movement: { openra: 'OpenRA', webra: 'WebRA' },
  factoryLoss: { openra: 'OpenRA', webra: 'WebRA' },
};
// Option rows: key (also the help text key in js/help.js), label, choices.
// The World group holds the climate of the battlefield.
const WORLD_OPTIONS = [
  ['mapStyle', 'Map style', MAP_STYLES.map((v) => [v, LABELS.mapStyle[v]])],
  ['biome', 'Biome', BIOMES.map((v) => [v, LABELS.biome[v]])],
  ['techBuildings', 'Tech buildings', TECH_BUILDINGS.map((v) => [v, LABELS.techBuildings[v]])],
  ['weather', 'Weather', WEATHER_MODES.map((v) => [v, LABELS.weather[v]])],
];
const SELECT_OPTIONS = [
  ['startingCash', 'Starting cash', STARTING_CASH.map((v) => [v, `$${v.toLocaleString('en-US')}`])],
  ['startingUnits', 'Starting units', STARTING_UNITS.map((v) => [v, LABELS.startingUnits[v]])],
  ['techLevel', 'Tech level', TECH_LEVELS.map((v) => [v, LABELS.techLevel[v]])],
  ['gameSpeed', 'Game speed', GAME_SPEEDS.map((v) => [v, LABELS.gameSpeed[v]])],
  ['timeLimit', 'Time limit', TIME_LIMITS.map((v) => [v, v === 0 ? 'No limit' : `${v} minutes`])],
  ['movement', 'Movement', MOVEMENT_MODELS.map((v) => [v, LABELS.movement[v]])],
  ['factoryLoss', 'Factory loss', FACTORY_LOSS_RULES.map((v) => [v, LABELS.factoryLoss[v]])],
];
// The select options a co-op mission takes (protocol mission.js MISSION_OPTION_KEYS).
const MISSION_SELECT_OPTIONS = ['gameSpeed', 'movement', 'factoryLoss'];
const TOGGLES = [
  ['crates', 'Crates'],
  ['shortGame', 'Short game'],
  ['fog', 'Fog of war'],
  ['explored', 'Explored map'],
  ['allyBuildRadius', 'Ally build radius'],
  ['buildRadius', 'Build radius'],
  ['separateTeamSpawns', 'Separate team spawns'],
  ['redeployableMcv', 'Redeployable MCVs'],
  ['bounty', 'Kill bounties'],
  ['oreRegrowth', 'Ore regrowth'],
  ['reusableEngineers', 'Reusable engineers'],
  ['cheats', 'Debug menu (cheats)'],
];
/** Every option of the online lobby with a "?" (tests check each one has help). */
export const ONLINE_HELP_KEYS = [
  'modeOnline',
  'onlineMap',
  'mapSize',
  'seed',
  ...WORLD_OPTIONS.map(([k]) => k),
  ...SELECT_OPTIONS.map(([k]) => k),
  ...TOGGLES.map(([k]) => k),
  'playerOnline',
  'faction',
  'colorOnline',
  'team',
  'handicap',
  'spawn',
  'spectators',
  'bulk',
  'connection',
];
/** What a member's map state says in the lobby (protocol MAP_STATES). */
const MAP_STATE_TEXT = { installed: 'Has map', missing: 'No map', declined: 'Declined map' };
/** Map file size for people: 12 KB, 1.2 MB. */
export function formatBytes(n) {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
/** The install question for a lobby map (text only: names are never markup). */
export function mapQuestion(map) {
  return `${map.shared ? 'Custom map' : 'Community map'}: ${map.name} by ${map.author}. Install?`;
}

// ---- DOM helpers -------------------------------------------------------------

function el(tag, className, textValue) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textValue !== undefined) e.textContent = textValue;
  return e;
}

function button(label, className, onClick) {
  const b = el('button', className ? `online-btn ${className}` : 'online-btn', label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** selectPlate options from [value, label] pairs, or from [groupLabel, pairs] groups with `grouped`. */
export function plateOptions(choices, grouped = false) {
  const opt = ([value, label]) => ({ value, label: String(label) });
  return grouped ? choices.map(([label, items]) => ({ label, options: items.map(opt) })) : choices.map(opt);
}

/**
 * A select (js/ui/controls.js selectPlate) from [value, label] pairs or
 * [groupLabel, pairs] groups. `onChange` gets the value as a string, like a
 * native select gave it. `label`: its accessible name (a row's label may name
 * it instead, see field()).
 */
function select(choices, value, onChange, { grouped = false, label = '', small = true, labelledBy } = {}) {
  return selectPlate({
    label,
    labelledBy,
    options: plateOptions(choices, grouped),
    value,
    small,
    block: true,
    className: 'online-plate',
    onChange: onChange ? (v) => onChange(String(v)) : undefined,
  });
}

let uid = 0;

/**
 * A label + control row; with `helpKey`, the option's "?" help (js/help.js).
 * `target` is what the label names (the control, or a compound control's
 * input); a select plate is named through aria-labelledby (its button keeps
 * the value in its name too).
 */
function field(label, control, helpKey = null, target = control) {
  const row = el('div', 'online-field');
  const head = el('span', 'online-field-head');
  const plate = target && target.button && target.root ? target : null;
  const name = el(plate ? 'span' : 'label', 'online-field-label', label);
  name.id = `online-lbl-${++uid}`;
  if (plate) {
    plate.button.setAttribute('aria-labelledby', `${name.id} ${plate.button.id}-value`);
    plate.listbox.setAttribute('aria-labelledby', name.id);
    name.addEventListener('click', () => plate.button.focus());
  } else {
    if (!target.id) target.id = `online-ctl-${uid}`;
    name.htmlFor = target.id;
  }
  head.append(name);
  if (helpKey) head.append(infoTip(helpKey, { label, describes: plate ? plate.button : target }).root);
  row.append(head, control.root && control.button ? control.root : control);
  return row;
}

/** The bars of a connection (four, the lit ones in the quality's colour) and its word; `size` small in the slots. */
function signalBars(cell) {
  const bars = el('span', `online-bars online-q-${cell.quality ?? 'none'}`);
  bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) bars.append(el('span', i < cell.bars ? 'online-bar is-lit' : 'online-bar'));
  return bars;
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

/** The player's lobby name from the settings registry (js/registry.js); signed-in players play under their username. */
function loadName() {
  return defaultRegistry().get('lobby', 'name');
}

/** The stored rejoin record of this tab, or null (malformed records are dropped). */
export function loadRejoin(storage = globalThis.sessionStorage) {
  try {
    const v = JSON.parse(storage.getItem(REJOIN_KEY) || 'null');
    if (
      v &&
      typeof v.id === 'string' &&
      SESSION_ID_RE.test(v.id) &&
      Number.isInteger(v.client) &&
      v.client > 0 &&
      typeof v.key === 'string' &&
      SEAT_KEY_RE.test(v.key) &&
      typeof v.name === 'string'
    ) {
      return { id: v.id, client: v.client, key: v.key, name: v.name };
    }
    if (v !== null) storage.removeItem(REJOIN_KEY);
  } catch {
    // Storage blocked or malformed: no rejoin.
  }
  return null;
}

export function saveRejoin(record, storage = globalThis.sessionStorage) {
  try {
    storage.setItem(REJOIN_KEY, JSON.stringify(record));
  } catch {
    // Storage blocked: a reload cannot rejoin, reconnecting in this page still can.
  }
}

export function clearRejoin(storage = globalThis.sessionStorage) {
  try {
    storage.removeItem(REJOIN_KEY);
  } catch {
    // Nothing stored.
  }
}

/** Chat line for a `left` message (`inGame`: rejoin rules apply). */
export function leftText(m, inGame) {
  const graceMin = Math.round(RECONNECT_GRACE_MS / 60_000);
  if (m.player === null && inGame) return m.reason === 'removed' ? `${m.name} (spectator) was removed.` : `${m.name} stopped watching.`;
  if (!inGame) return `${m.name} ${m.reason === 'kicked' ? 'was removed' : m.reason === 'dropped' ? 'was dropped' : 'left'}.`;
  switch (m.reason) {
    case 'disconnected':
      return `${m.name} lost connection. They can rejoin within ${graceMin} minutes.`;
    case 'dropped':
      return `${m.name} was dropped for holding up the game. They can rejoin within ${graceMin} minutes.`;
    case 'expired':
      return `${m.name} is out of the game.`;
    case 'removed':
    case 'kicked':
      return `${m.name} was removed from the game.`;
    default:
      return `${m.name} left the game.`;
  }
}

function saveName(name) {
  // The registry keeps it (blocked storage: for this page only).
  defaultRegistry().set('lobby', 'name', name);
}

/** Session id from an invite link (?join=<id> or #join=<id>), or null. */
function inviteId() {
  const q = new URLSearchParams(location.search).get('join');
  if (q && SESSION_ID_RE.test(q)) return q;
  const m = /^#join=([0-9a-f]{64})$/.exec(location.hash);
  return m ? m[1] : null;
}

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & SEED_MAX;
}

/** Marker of a lobby member whose name comes from an account (protocol 5 `account: true`). */
function accountMark() {
  const mark = el('span', 'online-badge online-badge-account', 'ACCOUNT');
  mark.title = 'Signed in with a WebRA account';
  return mark;
}

function messageOf(err) {
  if (err instanceof ApiError || err instanceof ProtocolError) return err.message;
  return `Unexpected error: ${err && err.message ? err.message : err}`;
}

// ---- Dialogs (js/online-dialog.js) ---------------------------------------------------

/**
 * The modded-map warning with what the map's rules change (`changes`, lines
 * of js/maprules.js); resolves true only when the player accepts.
 */
export function confirmModdedMap(mapName, changes = []) {
  return modal('Modded map', (body, close) => {
    body.append(
      el('p', 'online-warning', MODDED_WARNING),
      el('p', 'online-muted', `Map: ${mapName}`),
    );
    if (changes.length) {
      const list = el('ul', 'online-modded-rules');
      list.setAttribute('aria-label', 'Rules this map changes');
      for (const line of changes) list.append(el('li', null, line));
      body.append(list);
    }
    const row = el('div', 'online-dialog-actions');
    row.append(button('Decline', null, () => close(false)), button('Accept and install', 'online-btn-danger', () => close(true)));
    body.append(row);
  }).then((v) => v === true);
}

/**
 * The first line of an online game's chat: who plays, and how to chat
 * (Enter, Shift+Enter; on touch screens the HUD's Chat button, js/main.js).
 */
export function chatIntroLine({ spectator = false, list = '', teamChat = false, touch = false }) {
  if (touch) return `${spectator ? 'Watching' : 'Online game'}: ${list}. Tap Chat to chat.`;
  return spectator ? `Watching: ${list}. Press Enter to chat.` : `Online game: ${list}. Press Enter to chat${teamChat ? ' with your team, Shift+Enter with everyone' : ''}.`;
}

/**
 * What onStartGame's `net` is (docs/contracts.md, "Online screens and
 * friends in the game"): the session's NetQuality as `quality` (js/netwarn.js)
 * and as `source` (js/netmenu.js, the same object), the people of the game
 * from the start message as `roster` ([{ client, player, name }], AI left
 * out), this member's client id as `you`, and `players()`: the roster with
 * each player's colour as CSS ([{ client, name, color }]).
 */
export function gameNet(nq, { players, options, colors, you }) {
  const roster = (players ?? []).filter((p) => p.client !== null && p.client !== undefined).map((p) => ({ client: p.client, player: p.player, name: p.name }));
  const colorOf = (player) => {
    const c = colors?.[options?.players?.[player]?.color];
    return c ? rgbCss(c) : null;
  };
  return { quality: nq, source: nq, roster, you, players: () => roster.map((p) => ({ client: p.client, name: p.name, color: colorOf(p.player) })) };
}

// ---- Online UI -------------------------------------------------------------------

export class OnlineUI {
  /**
   * @param {HTMLElement} root the #online-root element
   * @param {{
   *   Game: any, version: string, colors: number[][], colorNames: string[],
   *   createGame: (o: { spec: object, conn: Connection, onCaughtUp: () => void, onCheck: (ok: boolean, tick: number) => void })
   *     => Promise<{ host: any, game: any, driver: any, recorder: any }>,  the simulation with its LockstepDriver (js/main.js, js/sim)
   *   onStartGame: (start: { host: any, game: any, player: number, driver: any, options: object, recorder: any, spectator: boolean, onQuit: () => void, about: object, chat: object }) => void,
   *     `chat`: the game's lines and chat line for js/chatpanel.js (buildGameOverlay's chatHandle)
   *   onBack: () => void,
   *   missionText?: (id: string, hash: string) => Promise<string>,  a co-op mission's file, checked against its hash (js/main.js)
   *   missionInfo?: (id: string) => Promise<object | null>,  its campaign index entry (briefing, option labels)
   *   account?: { session: import('./account/session.js').AccountSession, signIn: (reason: string) => Promise<object | null> },
   *   sounds?: { chatLine(): void, lobby(event: 'joined' | 'left' | 'option'): void },
   *   mapVersions?: object,  the map format version registry (tests; the protocol's by default)
   *   lens?: () => import('./maplens/lens.js').MapLens,  a magnifier over the map preview (js/maplens)
   *   loading?: { begin(o: { map: boolean, mission: boolean }): void, fail(message: string): void, cancel(): void },
   *     the loading screen (js/loadingscreen.js): shown when the lockstep start arrives, until the game's first frame
   * }} ctx  account: signed-in players play under their username (protocol 5);
   *   sounds: OpenRA's chat and lobby sounds (js/audio/index.js)
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.name = loadName();
    this.conn = null;
    this.state = null;
    /** The in-game lines (js/chatlog.js) and what main.js tells them about the players. */
    this.textLog = null;
    this.chatPeople = { colorOf: () => null, defeated: () => false };
    this.installed = new Map();
    this.mapStatus = { hash: null, text: '', ok: true };
    /** The host's notice for a shared map file of an older format version ({ hash, text } or null). */
    this.mapNotice = null;
    this.serverMaps = [];
    /** Co-op mission previews by id (RGBA rows), and the index entries (briefing, option labels). */
    this.missionPreviews = new Map();
    this.missionEntries = new Map();
    /** The magnifier over the map preview (js/maplens), or null. */
    this.lens = ctx.lens?.() ?? null;
    /** The local map library (js/maplibrary.js) and its list for the host's map picker. */
    this.library = ctx.library ?? mapLibrary();
    this.libraryMaps = [];
    /** This member's credential for the session's map endpoints: { client, key } (the rejoin key). */
    this.member = null;
    /** The lobby map this player has not installed yet: { hash, declined, busy } or null. */
    this.mapOffer = null;
    /** The rematch proposal of the running game (`rematch` messages) or null, and who listens. */
    this.rematch = null;
    this.rematchSubs = new Set();
    /** Saving the running game (`save` messages) or null, and who listens. */
    this.saving = null;
    this.saveSubs = new Set();
    /** Saved games in this browser (online saves are stored here too). */
    this.saves = ctx.saves ?? SaveStore.browser();
    this.refreshTimer = 0;
    this.inGame = false;
    this.root.classList.add('online');
    const rejoin = loadRejoin();
    if (rejoin) this.rejoinAfterReload(rejoin);
    else {
      this.showBrowser();
      // An invite link: /join/<code> opens /play/?invite=<code>; the older ?join=<session id> too.
      const opened = inviteFromLocation() ?? inviteId();
      if (opened) this.joinByCode(opened);
      else if (new URLSearchParams(globalThis.location?.search ?? '').has('invite')) {
        // ?invite= with something that is not a code: say so and take it from the address bar.
        clearInviteFromLocation();
        this.setError('That invite link has no valid code. Ask your friend for the code and use Join with a code.');
      }
    }
  }

  /** The online lobby this player is in (the friends screen's Invite), or null. */
  currentLobby() {
    return this.state && this.conn && !this.inGame && this.slotBox ? { session: this.state.session.id } : null;
  }

  /** Join from the friends screen: leave a lobby this player is in first. */
  async joinElsewhere(session, o = {}) {
    if (this.inGame) return;
    if (this.conn && this.state?.session.id === session.id) return;
    if (this.conn) this.showBrowser();
    await this.join(session, o);
  }

  /** A reload during an online game: rejoin it with the stored key. */
  async rejoinAfterReload(record) {
    this.root.textContent = '';
    const page = el('div', 'online-page');
    page.append(el('h1', 'online-title', 'Rejoining your session...'), el('p', 'online-muted', 'Reconnecting to the server.'));
    this.root.append(page);
    try {
      await this.connect(record.id, { name: record.name, rejoin: { client: record.client, key: record.key } }, { rejoin: true });
    } catch (err) {
      clearRejoin();
      this.showBrowser(`Could not rejoin: ${messageOf(err)}`);
    }
  }

  // ---- Server browser ------------------------------------------------------------

  showBrowser(error = '') {
    this.leaveSession();
    this.root.textContent = '';
    this.slotBox = null;
    const page = el('div', 'online-page online-browser');

    const head = el('header', 'online-head');
    const titleBox = el('div', 'online-head-title');
    // The online counter (GET /api/online) and this browser's round trip to the server.
    this.presenceLine = el('p', 'online-presence');
    this.presenceLine.setAttribute('role', 'status');
    titleBox.append(el('h1', 'online-title', 'Play online'), this.presenceLine);
    const actions = el('div', 'online-head-actions');
    if (this.ctx.friends && this.account?.user) actions.append(button('Friends', null, (e) => this.ctx.friends.open(e.currentTarget)));
    actions.append(
      button('Join with a code', null, () => this.joinByCode()),
      button('Resume a saved game', null, () => this.resumeDialog()),
      button('Host game', 'online-btn-primary', () => this.hostDialog()),
    );
    head.append(titleBox, actions, button('Back', null, () => this.back()));

    this.banner = el('div', 'online-error');
    this.banner.setAttribute('role', 'alert');
    this.setError(error);

    const nameInput = el('input', 'online-input');
    nameInput.maxLength = NAME_MAX;
    nameInput.placeholder = 'Commander';
    nameInput.value = this.name;
    nameInput.autocomplete = 'nickname';
    nameInput.addEventListener('change', () => {
      this.name = nameInput.value;
      saveName(this.name);
    });
    this.nameInput = nameInput;

    // Search, the filter and Hide full: client side, over the list the server sent.
    this.browse ??= { filter: 'all', query: '', hideFull: false, selected: null };
    const tools = el('div', 'online-toolbar');
    const user = this.account?.user;
    // Signed in: the lobby name is the username (the server sets it). Otherwise the typed name, when the site allows anonymous play.
    tools.append(user ? field('Playing as', el('span', 'online-account-name', user.username)) : field('Your name', nameInput));
    const search = el('input', 'online-input online-search');
    search.type = 'search';
    search.placeholder = 'Search servers, maps or hosts';
    search.setAttribute('aria-label', 'Search servers');
    search.value = this.browse.query;
    search.addEventListener('input', () => {
      this.browse.query = search.value;
      this.renderSessions();
    });
    const filter = segmented({
      label: 'Show',
      options: SESSION_FILTERS.map((f) => ({ value: f.value, label: f.label })),
      value: this.browse.filter,
      onChange: (v) => {
        this.browse.filter = v;
        this.renderSessions();
      },
    });
    // Friends: signed-in players only (the friends list says where they are).
    if (!user) {
      filter.setDisabled('friends', true);
      filter.setTitle('friends', 'Sign in to see the games of your friends');
    }
    const hideFull = toggle({
      label: 'Hide full',
      checked: this.browse.hideFull,
      rowClass: 'online-hide-full',
      onChange: (on) => {
        this.browse.hideFull = on;
        this.renderSessions();
      },
    });
    tools.append(search, filter.root, hideFull.row, button('Refresh', null, () => this.refresh()));

    const body = el('div', 'online-browser-body');
    const table = el('div', 'online-sessions ui-table');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', 'Sessions');
    table.addEventListener('keydown', (e) => this.sessionKey(e));
    this.sessionList = table;
    this.detailBox = el('aside', 'online-detail');
    this.detailBox.setAttribute('aria-label', 'Selected session');
    body.append(table, this.detailBox);
    this.listStatus = el('p', 'online-muted online-list-status', 'Loading sessions...');
    this.listStatus.setAttribute('role', 'status');

    page.append(head, this.banner);
    if (!user && this.account && !this.account.canPlayOnline) {
      const prompt = el('div', 'online-account-prompt');
      prompt.setAttribute('role', 'note');
      prompt.append(el('span', null, 'Online play needs a WebRA account. '), button('Sign in', 'online-btn-primary', () => this.signIn()));
      const create = el('a', 'online-link', 'Create an account');
      create.href = '/account/#signup';
      prompt.append(' ', create);
      page.append(prompt);
    } else if (user && !user.canPlayOnline) {
      page.append(el('div', 'online-account-prompt', onlineRefusal(user.status === 'banned' ? 'banned' : 'account_inactive')?.text ?? 'Your account cannot play online right now.'));
    }
    page.append(tools, body, this.listStatus);
    this.root.append(page);
    this.sessions ??= [];
    this.renderSessions();
    this.followFriends();
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  setError(message, { signIn = false } = {}) {
    if (!this.banner) return;
    this.banner.textContent = message || '';
    this.banner.hidden = !message;
    if (message && signIn && this.ctx.account) {
      this.banner.append(' ', button('Sign in', 'online-btn-primary', () => this.signIn()));
    }
  }

  /** Show an error; account refusals (account_required, banned, ...) get their own text and a sign-in button where it helps. */
  showProblem(err) {
    const refusal = onlineRefusal(err?.code, err?.message);
    if (refusal) this.setError(refusal.text, { signIn: refusal.signIn && !this.account?.user });
    else this.setError(messageOf(err));
  }

  get account() {
    return this.ctx.account?.session ?? null;
  }

  /** Sign in from the online page, then show the browser again (signed in, the name is the username). */
  async signIn(reason = 'Sign in to play online.') {
    const user = await this.ctx.account?.signIn(reason);
    if (user && !this.conn) this.showBrowser();
    return user;
  }

  playerName() {
    const user = this.account?.user;
    if (user) return user.username;
    try {
      return validName(this.nameInput ? this.nameInput.value || 'Commander' : this.name || 'Commander');
    } catch (err) {
      this.setError(`Name: ${err.message}.`);
      return null;
    }
  }

  /**
   * The friends list (js/account/friends.js) while a signed-in player is on
   * the online screens: the browser's Friends filter and the lobby's Invite
   * players panel. Polled every 30 s; stopped when the player leaves for a game.
   */
  followFriends() {
    if (!this.account?.user || this.ctx.friendsStore === null) return null;
    if (!this.friendsStore) {
      // One store per page, shared with the friends screen (js/friends-ui.js): one poll, not two.
      this.friendsStore = this.ctx.friendsStore ?? sharedFriendsStore(this.account.api);
      this.friendsStore.on('change', (doc) => {
        this.friendsDoc = doc;
        if (this.sessionList?.isConnected) this.renderSessions();
        if (this.inviteBox?.isConnected) this.renderInvite();
      });
      this.friendsDoc = this.friendsStore.doc ?? null;
    }
    this.releaseFriends ??= useFriendsStore(this.friendsStore);
    return this.friendsStore;
  }

  /** This screen no longer needs the friends list (it stops polling unless the friends screen still shows). */
  unfollowFriends() {
    this.releaseFriends?.();
    this.releaseFriends = null;
  }

  async refresh() {
    try {
      const t0 = performance.now();
      const v = await api.version();
      // One round trip to the Worker: the browser's ping to the server (the lobby measures each player).
      this.serverRtt = Math.round(performance.now() - t0);
      if (v.protocol !== PROTOCOL_VERSION) {
        this.setError('The server uses a newer multiplayer protocol. Reload the page to update.');
      }
      const [sessions, online] = await Promise.all([api.sessions(), api.online().catch(() => null)]);
      if (!this.sessionList?.isConnected) return;
      this.sessions = Array.isArray(sessions) ? sessions : [];
      this.onlineCount = online;
      this.listError = '';
      this.renderSessions();
    } catch (err) {
      this.listError = messageOf(err);
      if (this.listStatus) this.listStatus.textContent = this.listError;
    }
  }

  /** The sessions after search and filter, as rows (js/online-view.js). */
  shownSessions() {
    const friendSessions = friendSessionIds(this.friendsDoc);
    return filterSessions(this.sessions ?? [], { ...this.browse, friendSessions }).map((s) => ({ s, row: sessionRow(s, { version: this.ctx.version, friendSessions }) }));
  }

  renderSessions() {
    const table = this.sessionList;
    if (!table) return;
    const counter = onlineText(this.onlineCount);
    if (this.presenceLine) {
      this.presenceLine.textContent = '';
      if (counter) {
        const c = el('span', 'online-count');
        c.title = counter.title;
        c.append(led('ok'), el('span', null, counter.text));
        this.presenceLine.append(c);
      }
      if (Number.isFinite(this.serverRtt)) this.presenceLine.append(el('span', 'online-rtt', `${this.serverRtt} ms to the server`));
    }
    const shown = this.shownSessions();
    const focused = table.contains(document.activeElement);
    if (!shown.some((x) => x.s.id === this.browse.selected)) this.browse.selected = shown[0]?.s.id ?? null;
    table.textContent = '';
    const head = el('div', 'online-row online-row-head ui-table-head');
    head.setAttribute('role', 'row');
    for (const h of ['Server', 'Map', 'Mode', 'Players']) {
      const c = el('div', 'online-cell', h);
      c.setAttribute('role', 'columnheader');
      head.append(c);
    }
    table.append(head);
    this.sessionRows = [];
    for (const { s, row: r } of shown) {
      const row = el('div', `online-row online-session online-session-${r.state}`);
      row.setAttribute('role', 'row');
      const chosen = s.id === this.browse.selected;
      row.setAttribute('aria-selected', String(chosen));
      row.tabIndex = chosen ? 0 : -1;
      row.dataset.id = s.id;
      const name = el('div', 'online-cell online-cell-name');
      name.setAttribute('role', 'gridcell');
      // The lamp says open (green), running (yellow) or full (off); the word says it too.
      name.append(led(r.led));
      const who = el('span', 'online-session-who');
      who.append(el('span', 'online-session-name', r.name), el('span', 'online-session-host', `host ${r.host}`));
      name.append(who);
      const tags = el('span', 'online-tags');
      tags.append(el('span', 'ui-sr-only', `${r.stateWord}.`));
      for (const [kind, text] of r.tags) tags.append(badge(kind, text));
      name.append(tags);
      const cells = [name, el('div', 'online-cell', r.map), el('div', 'online-cell online-cell-mode', r.mode), el('div', 'online-cell online-cell-num', r.players)];
      for (const c of cells.slice(1)) c.setAttribute('role', 'gridcell');
      row.append(...cells);
      row.addEventListener('click', () => this.selectSession(s.id));
      row.addEventListener('dblclick', () => this.joinSelected());
      table.append(row);
      this.sessionRows.push(row);
    }
    const total = this.sessions?.length ?? 0;
    this.listStatus.textContent = this.listError || (!total ? 'No public sessions right now. Host one!' : !shown.length ? 'No session matches the search or filter.' : `${shown.length} of ${total} sessions`);
    this.renderDetail();
    if (focused) this.sessionRows.find((r) => r.tabIndex === 0)?.focus();
  }

  selectSession(id, focus = false) {
    this.browse.selected = id;
    for (const r of this.sessionRows ?? []) {
      const on = r.dataset.id === id;
      r.setAttribute('aria-selected', String(on));
      r.tabIndex = on ? 0 : -1;
      if (on && focus) r.focus();
    }
    this.renderDetail();
  }

  /** The session list as a grid: Up and Down (Home, End) choose a row, Enter joins it (or watches a running game). */
  sessionKey(e) {
    const rows = this.sessionRows ?? [];
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.dataset.id === this.browse.selected);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      this.joinSelected();
      return;
    } else return;
    e.preventDefault();
    this.selectSession(rows[next].dataset.id, true);
  }

  selectedSession() {
    return (this.sessions ?? []).find((s) => s.id === this.browse?.selected) ?? null;
  }

  /** Join the chosen session, or watch it when it runs or is full. */
  joinSelected() {
    const s = this.selectedSession();
    if (!s) return;
    const d = sessionDetail(s, { version: this.ctx.version });
    if (d.canJoin) this.join(s);
    else if (d.canWatch) this.join(s, { spectate: true });
  }

  /** The detail panel of the chosen session: who plays (team colour), the options and Join or Spectate. */
  renderDetail() {
    const box = this.detailBox;
    if (!box) return;
    box.textContent = '';
    box.append(el('div', 'online-detail-stripe'));
    const s = this.selectedSession();
    if (!s) {
      box.append(el('p', 'online-muted', 'Pick a session to see who plays and how.'));
      return;
    }
    const d = sessionDetail(s, { version: this.ctx.version });
    const head = el('div', 'online-detail-head');
    head.append(el('h2', 'online-detail-title', d.title), el('p', 'online-detail-sub', d.sub));
    box.append(head);
    const players = el('ul', 'online-detail-players');
    players.setAttribute('aria-label', 'Players');
    for (const p of d.players) {
      const li = el('li', 'ui-slot-row online-detail-player');
      if (p.color !== null && this.ctx.colors?.[p.color]) li.style.setProperty('--slot-color', rgbCss(this.ctx.colors[p.color]));
      li.append(el('span', 'ui-slot-strip'), el('span', 'online-detail-name', p.ai ? `${p.name} (AI)` : p.name), el('span', 'online-detail-team ui-num', p.team ? `Team ${p.team}` : 'No team'));
      players.append(li);
    }
    for (let i = 0; i < d.open; i++) {
      const li = el('li', 'ui-slot-row online-detail-player is-open');
      li.append(el('span', 'ui-slot-strip'), el('span', 'online-detail-name', 'Open slot'));
      players.append(li);
    }
    if (!d.players.length && !d.open) players.append(el('li', 'online-muted', 'No players listed.'));
    box.append(players);
    if (d.chips.length) {
      const chips = el('ul', 'online-chips');
      chips.setAttribute('aria-label', 'Options');
      for (const c of d.chips) chips.append(el('li', 'online-chip', c));
      box.append(chips);
    }
    const actions = el('div', 'online-detail-actions');
    const watch = button('Spectate', null, () => this.join(s, { spectate: true }));
    watch.disabled = !d.canWatch;
    if (d.watchTitle) watch.title = d.watchTitle;
    const join = button(d.locked ? 'Join (password)' : 'Join game', 'online-btn-primary', () => this.join(s));
    join.disabled = !d.canJoin;
    if (d.joinTitle) join.title = d.joinTitle;
    actions.append(watch, join);
    box.append(actions);
    if (d.joinTitle && !d.canJoin) box.append(el('p', 'online-muted online-detail-note', d.joinTitle));
  }

  /** "Join with a code": a six-character invite code, a pasted link, or an older long session link. */
  async joinByCode(initial = '') {
    const r = await joinCodeDialog({ initial, version: this.ctx.version, rtt: Number.isFinite(this.serverRtt) ? this.serverRtt : null });
    // Used or not, the link's code goes from the address bar (a reload does not ask again).
    clearInviteFromLocation();
    if (inviteId()) history.replaceState(null, '', location.pathname);
    if (!r) return;
    await this.join({ id: r.session, name: r.name, locked: r.locked }, { spectate: r.spectate });
  }

  /** The host's map picker choices: generated, the host's own maps, community maps, co-op missions. */
  mapChoices(current = null) {
    const groups = [
      ['My maps', this.libraryMaps.map((m) => [`mine:${m.hash}`, `${m.name} (${m.players}p${m.modded ? ', modded' : ''})`])],
      ['Community maps', this.serverMaps.map((m) => [`community:${m.id}`, `${m.name} (${m.players}p${m.modded ? ', modded' : ''})`])],
    ];
    const st = this.state;
    if (current && st?.map && ![...groups[0][1], ...groups[1][1]].some(([v]) => v === current)) groups[st.map.shared ? 0 : 1][1].push([current, st.map.name]);
    // OpenRA's co-op missions (map.yaml Visibility: Lobby), played by people only.
    groups.push(['Co-op missions', COOP_MISSIONS.map((m) => [`mission:${m.id}`, `${m.title} (co-op, ${m.players.length} players)`])]);
    return [['Generated', [['generated', 'Generated map']]], ...groups.filter(([, items]) => items.length)];
  }

  /**
   * The host dialog (the HostGame board); creates the session and joins it,
   * then sets its spectator places and map as the first lobby messages.
   * `resume`: the text and parsed replay of an online save to continue in it.
   */
  async hostDialog(resume = null) {
    const name = this.playerName();
    if (!name) return;
    const saved = resume?.replay ?? null;
    if (!saved) await this.loadMapLists();
    const input = await modal(
      saved ? 'Resume a saved game' : 'Host game',
      (body, close) => {
        if (saved) body.append(el('p', 'online-muted', `${saved.title}: ${formatTicks(saved.ticks)} played. Its players come back by their accounts.`));
        const title = el('input', 'online-input');
        title.maxLength = SESSION_NAME_MAX;
        title.value = saved ? saved.title.slice(0, SESSION_NAME_MAX) : `${name}'s game`;
        const visHint = el('p', 'online-hint');
        visHint.id = `online-vis-${++uid}`;
        const hints = { public: 'Listed in the server browser.', private: 'Hidden from the list: only an invite code or link gets in.' };
        const vis = segmented({
          label: 'Who can join',
          options: [
            { value: 'public', label: 'Public' },
            { value: 'private', label: 'Private' },
          ],
          value: saved ? 'private' : 'public',
          block: true,
          describedBy: visHint.id,
          onChange: (v) => (visHint.textContent = hints[v]),
        });
        visHint.textContent = hints[vis.get()];
        const visRow = el('div', 'online-field');
        visRow.append(el('span', 'online-field-label', 'Who can join'), vis.root, visHint);
        const pass = el('input', 'online-input');
        pass.type = 'password';
        pass.maxLength = PASSWORD_MAX;
        pass.autocomplete = 'new-password';
        pass.setAttribute('aria-label', 'Lobby password');
        pass.hidden = true;
        const passSwitch = toggle({
          label: 'Password',
          hint: 'Players and spectators need it to join.',
          onChange: (on) => {
            pass.hidden = !on;
            if (on) pass.focus();
          },
        });
        const need = saved ? Math.max(MIN_PLAYERS, saved.options.players.length) : MIN_PLAYERS;
        const playersRow = el('div', 'online-field');
        const playersLabel = el('span', 'online-field-label', 'Players');
        playersLabel.id = `online-lbl-${++uid}`;
        const players = stepper({ labelledBy: playersLabel.id, values: Array.from({ length: MAX_PLAYERS - need + 1 }, (_, i) => i + need), value: saved ? need : 4, decLabel: 'Fewer players', incLabel: 'More players' });
        playersRow.append(playersLabel, players.root);
        const specRow = el('div', 'online-field');
        const specLabel = el('span', 'online-field-label', 'Spectator places');
        specLabel.id = `online-lbl-${++uid}`;
        const spectators = stepper({ labelledBy: specLabel.id, values: Array.from({ length: MAX_SPECTATORS + 1 }, (_, i) => i), value: DEFAULT_MAX_SPECTATORS, decLabel: 'Fewer places', incLabel: 'More places' });
        specRow.append(specLabel, spectators.root);
        const steppers = el('div', 'online-host-steppers');
        steppers.append(playersRow, specRow);
        const map = saved ? null : select(this.mapChoices(), 'generated', null, { grouped: true, label: 'Map', small: false });
        const actions = el('div', 'online-dialog-actions');
        const submit = () =>
          close({
            name: title.value,
            public: vis.get() === 'public',
            password: passSwitch.get() ? pass.value : '',
            maxPlayers: Number(players.get()),
            spectators: Number(spectators.get()),
            map: map ? String(map.get()) : 'generated',
          });
        actions.append(button('Cancel', null, () => close(null)), button('Create lobby', 'online-btn-primary', submit));
        body.append(field('Game name', title), visRow, passSwitch.row, pass, steppers);
        if (map) body.append(field('Map', map), el('p', 'online-hint', 'Your own maps are shared with this lobby only; they are not published.'));
        body.append(actions);
        title.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      },
      { className: 'online-host-dialog' },
    );
    if (!input) return;
    try {
      const body = { name: input.name, public: input.public, maxPlayers: input.maxPlayers, version: this.ctx.version };
      if (input.password) body.password = input.password;
      const { id, hostKey } = await api.createSession(body);
      await this.connect(id, { name, hostKey });
      // The first lobby messages: what the dialog set beyond the session itself.
      if (input.spectators !== DEFAULT_MAX_SPECTATORS) this.send({ t: 'spectators', max: input.spectators });
      if (input.map !== 'generated') await this.pickMap(input.map);
      // A private lobby is found by its code: make one at once.
      if (!input.public && !resume) this.newInvite();
      if (resume) await this.loadResume(resume.text);
    } catch (err) {
      this.showProblem(err);
    }
  }

  /** Online saves in this browser; pick one to continue it in a new session. */
  async resumeDialog() {
    let saves = [];
    try {
      saves = (await this.saves.list()).filter((x) => x.mode === 'online');
    } catch (err) {
      return this.setError(`Saved games are unavailable: ${messageOf(err)}`);
    }
    const chosen = await modal('Resume a saved game', (body, close) => {
      if (!saves.length) body.append(el('p', 'online-muted', 'No saved online games in this browser. Save one from the game menu during an online game.'));
      const list = el('div', 'online-sessions');
      for (const x of saves) {
        const row = el('div', 'online-row');
        const info = el('div', 'online-cell online-cell-name');
        info.append(el('span', null, x.title), el('span', 'online-muted', ` ${formatTicks(x.ticks)} played, saved ${new Date(x.createdAt).toLocaleString()}`));
        const go = button('Resume', 'online-btn-primary', () => close(x));
        go.disabled = x.engine !== this.ctx.version;
        if (go.disabled) go.title = `Made with WebRA ${x.engine}`;
        row.append(info, go);
        list.append(row);
      }
      const actions = el('div', 'online-dialog-actions');
      actions.append(button('Cancel', null, () => close(null)));
      body.append(list, actions);
    });
    if (!chosen) return undefined;
    try {
      const textValue = await this.saves.text(chosen.id);
      const r = await this.saves.load(chosen.id, this.ctx.version);
      if (!r.ok || !textValue) throw new Error(r.error ?? 'This save no longer exists.');
      return this.hostDialog({ text: textValue, replay: r.replay });
    } catch (err) {
      return this.setError(messageOf(err));
    }
  }

  /** Host: load the saved game into this lobby (the server checks it against its record). */
  async loadResume(textValue) {
    try {
      await api.resumeSession(this.state.session.id, this.member, textValue);
    } catch (err) {
      this.setError(`Could not resume the saved game: ${messageOf(err)}`);
    }
  }

  async join(session, { spectate = false } = {}) {
    const name = this.playerName();
    if (!name) return;
    let password;
    if (session.locked !== false) {
      const prompt = session.locked === null ? 'Password (leave empty if none)' : 'Password';
      password = await modal(`Join ${session.name}`, (body, close) => {
        const pass = el('input', 'online-input');
        pass.type = 'password';
        pass.maxLength = PASSWORD_MAX;
        pass.autocomplete = 'current-password';
        const actions = el('div', 'online-dialog-actions');
        actions.append(button('Cancel', null, () => close(null)), button('Join', 'online-btn-primary', () => close(pass.value)));
        pass.addEventListener('keydown', (e) => e.key === 'Enter' && close(pass.value));
        body.append(field(prompt, pass), actions);
      });
      if (password === null) return;
    }
    try {
      const hello = { name };
      if (password) hello.password = password;
      if (spectate) hello.spectate = true;
      await this.connect(session.id, hello);
    } catch (err) {
      this.showProblem(err);
    }
  }

  /**
   * Open a session connection. `rejoin`: coming back into a running game
   * (after a reload, or `reconnect` when this page still has its game).
   */
  async connect(id, hello, { rejoin = false, reconnect = false } = {}) {
    if (!rejoin && !this.account?.user) saveName(hello.name);
    const conn = new Connection(id);
    conn
      .on('lobby', (m) => this.onLobby(m))
      .on('chat', (m) => (this.inGame ? this.gameChat(m) : this.chatLine(m.name, m.text, m.from === null, !!m.team)))
      .on('left', (m) => this.chatLine(null, leftText(m, this.inGame), true, false, 'left'))
      .on('back', (m) => this.onBack(m))
      .on('error', (m) => this.onServerError(m))
      .on('start', (m) => this.onStart(m))
      // Until the game exists, its network messages wait (onStart replays them).
      .on('frame', (m) => this.net('frame', m))
      .on('log', (m) => this.net('log', m))
      .on('sync', (m) => this.net('sync', m))
      .on('desync', (d) => this.onDesync(d))
      .on('rematch', (m) => this.onRematch(m))
      .on('save', (m) => this.onSave(m))
      .on('close', (reason) => this.onClose(reason, conn));
    const welcome = await conn.open({ version: this.ctx.version, ...hello });
    clearInterval(this.refreshTimer);
    this.conn = conn;
    // Protocol 5: the server says which name this member got (the username when signed in).
    const memberName = typeof welcome.name === 'string' ? welcome.name : hello.name;
    if (welcome.key) saveRejoin({ id, client: welcome.you, key: welcome.key, name: memberName });
    // The map endpoints take the same key (a rejoin keeps the one from the first join).
    if (welcome.key) this.member = { client: welcome.you, key: welcome.key };
    else if (hello.rejoin) this.member = { client: hello.rejoin.client, key: hello.rejoin.key };
    // Connection quality (js/netquality.js): pings every 2 s in the lobby and the game; one per page,
    // so a reconnect keeps the statistics series.
    this.attachNet(conn, welcome.you);
    if (reconnect && this.driver) {
      // Same game, new connection: the driver catches up from the server's log.
      this.driver.reattach(conn);
      this.reconnecting = false;
      this.gameLine('Reconnected. Catching up...', true);
      return;
    }
    this.state = {
      you: welcome.you,
      hostId: welcome.hostId,
      session: welcome.session,
      role: welcome.role,
      slots: [],
      spectators: [],
      maxSpectators: 0,
      options: null,
      map: null,
      // A start without a lobby before it means joining a running game (catch up).
      lobbySeen: false,
      rejoin,
      invite: null,
    };
    this.lobbyClients = null;
    if (inviteId()) history.replaceState(null, '', location.pathname);
    clearInviteFromLocation();
    if (rejoin || welcome.role === 'spectator') this.pendingNet = [];
    if (!rejoin) {
      this.buildLobby();
      this.loadServerMaps();
    }
  }

  /** Route a game network message to the driver, or keep it until the game exists. */
  net(type, m) {
    const d = this.driver;
    if (!d) {
      if (this.pendingNet) this.pendingNet.push([type, m]);
      return;
    }
    if (type === 'frame') d.onFrame(m);
    else if (type === 'log') d.onLog(m);
    else if (type === 'sync') d.onSync(m);
  }

  leaveSession() {
    clearInterval(this.refreshTimer);
    clearInterval(this.inviteTimer);
    clearRejoin();
    this.reconnecting = false;
    this.netq?.detach();
    this.netq = null;
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      c.leave();
    }
    this.state = null;
  }

  back() {
    this.leaveSession();
    this.unfollowFriends();
    this.ctx.onBack();
  }

  /**
   * Measure this connection (ping and pong) and hear everyone's (`netstat`):
   * the lobby's Connection column, its warning bar and own status; in the
   * game the HUD and the statistics read the same object (onStartGame `net`).
   */
  attachNet(conn, you) {
    if (!this.netq) {
      this.netq = this.ctx.netQuality?.() ?? new NetQuality();
      this.netq.on('players', () => this.renderConnections());
      this.netq.on('self', () => this.renderSelfNet());
    }
    this.netq.attach(conn, { you });
  }

  /**
   * The server saw the players' games differ (`desync`): said in the game,
   * and reported with this game's newest state hashes (js/telemetry).
   */
  onDesync(d) {
    if (!this.inGame) return;
    this.gameLine(`Desync detected at tick ${d.tick}: the game states differ. Results may not match.`, true);
    const send = (context) => reportMessage('Lockstep desync', { context: { ...context, desyncTick: d.tick } });
    this.simHost?.command('report').then(send, () => send({ mode: 'online' }));
  }

  onServerError(m) {
    this.seedPending = null;
    // A refused bulk edit is reported in the bulk bar, where it was applied.
    if (this.bulkWait && !this.inGame) return this.settleBulk({ error: m.message });
    const refusal = onlineRefusal(m.code, m.message);
    if (this.inGame) this.gameLine(`Server: ${refusal?.text ?? m.message}`, !!refusal);
    else if (refusal) this.setError(refusal.text, { signIn: refusal.signIn && !this.account?.user });
    else this.setError(m.message);
    // A refused ready (not_ready, bad_state): the switch shows what the lobby says again.
    if (!this.inGame && this.readyCtl && this.state) this.readyCtl.set(!!this.state.slots[this.mySlot()]?.ready);
  }

  onClose(reason, conn) {
    if (!this.conn || conn !== this.conn) return; // we left on purpose, or an old connection
    this.conn = null;
    if (this.inGame) {
      if (!FINAL_CODES.has(conn.closeCode) && loadRejoin()) {
        this.reconnect(reason);
        return;
      }
      clearRejoin();
      this.driver?.stop();
      this.gameLine(`Disconnected${reason ? `: ${reason}` : ''}. The game cannot continue.`, true);
      return;
    }
    clearRejoin();
    this.showBrowser(`Disconnected${reason ? `: ${reason}` : '.'}`);
  }

  /** The connection dropped during a game: rejoin with the stored key, with backoff, within the grace period. */
  async reconnect(reason) {
    const record = loadRejoin();
    this.reconnecting = true;
    this.gameLine(`Connection lost${reason ? ` (${reason})` : ''}. Reconnecting...`, true);
    const deadline = Date.now() + RECONNECT_GRACE_MS;
    let wait = 1000;
    let last = null;
    while (this.reconnecting && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      if (!this.reconnecting) return;
      wait = Math.min(wait * 2, 8000);
      try {
        await this.connect(record.id, { name: record.name, rejoin: { client: record.client, key: record.key } }, { rejoin: true, reconnect: true });
        return;
      } catch (err) {
        last = err;
        if (err instanceof ApiError && FINAL_CODES.has(err.code)) break;
      }
    }
    if (!this.reconnecting) return;
    this.reconnecting = false;
    clearRejoin();
    this.driver?.stop();
    this.gameLine(`Could not reconnect${last ? `: ${messageOf(last)}` : ''}. The game cannot continue for you.`, true);
  }

  /** A player is back in the game (maybe this client after a rejoin). */
  onBack(m) {
    if (!this.state) return;
    if (m.client === this.state.you) {
      this.driver?.onBack(m.tick);
      this.gameLine('You are back in the game.', true);
    } else {
      this.chatLine(null, `${m.name} is back in the game.`, true);
    }
  }

  // ---- Lobby ------------------------------------------------------------------------

  get isHost() {
    return this.state && this.state.hostId === this.state.you;
  }

  send(msg) {
    try {
      this.conn?.send(msg);
    } catch (err) {
      this.setError(messageOf(err));
    }
  }

  buildLobby() {
    this.root.textContent = '';
    const s = this.state.session;
    const page = el('div', 'online-page online-lobby');

    const head = el('header', 'online-head online-lobby-head');
    const title = el('div', 'online-head-title');
    const tags = el('p', 'online-lobby-tags');
    tags.append(badge(s.public ? 'neutral' : 'info', s.public ? 'Public' : 'Private'));
    // Protocol 8: the session says whether it has a password (welcome.session.locked).
    if (s.locked) tags.append(badge('locked', 'Password'));
    title.append(el('h1', 'online-title', s.name), tags);
    // This player's own connection, top right (the NetLobby board).
    this.selfNet = el('div', 'online-self-net');
    this.selfNet.setAttribute('role', 'status');
    this.selfNet.setAttribute('aria-label', 'Your connection');
    const headActions = el('div', 'online-head-actions');
    if (this.ctx.friends && this.account?.user) headActions.append(button('Friends', null, (e) => this.ctx.friends.open(e.currentTarget)));
    headActions.append(button('Leave', null, () => this.showBrowser()));
    head.append(title, this.selfNet, headActions);

    this.banner = el('div', 'online-error');
    this.banner.setAttribute('role', 'alert');
    this.banner.hidden = true;

    this.slotBox = el('div', 'online-slots');
    this.slotBox.setAttribute('role', 'table');
    this.mapBox = el('section', 'online-panel online-map');
    this.optionBox = el('section', 'online-panel online-options');
    this.buildOptions();
    // Built once so an open help tip survives lobby updates.
    this.slotHead = el('div', 'online-slot online-row-head');
    this.slotHead.setAttribute('role', 'row');
    this.columnTips = {};
    for (const [label, key] of [['Player', 'playerOnline'], ['Faction', 'faction'], ['Color', 'colorOnline'], ['Team', 'team'], ['Connection', 'connection'], ['', null]]) {
      const c = el('div', 'online-cell', label);
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
    this.spectatorTip = infoTip('spectators', { label: 'Spectators' });
    // The host's bulk edit (js/lobby-bulkbar.js): one `slots` message the server checks change by change.
    this.bulk = new BulkBar({
      context: 'online',
      selectClass: 'online-select',
      buttonClass: 'online-btn',
      onApply: (id, selected) => this.applyBulk(id, selected),
      note: 'Factions and colors change only for your own slot and the AI slots: every player picks their own, like in OpenRA.',
    });
    const bulkBox = el('div', 'online-bulk');
    bulkBox.append(this.bulk.toggleBox, this.bulk.root);

    const chat = el('section', 'online-panel online-chat');
    this.chatLog = el('div', 'online-chat-log');
    this.chatLog.setAttribute('aria-live', 'polite');
    const chatInput = el('input', 'online-input');
    chatInput.maxLength = CHAT_MAX;
    chatInput.placeholder = 'Message the lobby';
    chatInput.setAttribute('aria-label', 'Message the lobby');
    chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !chatInput.value.trim()) return;
      this.send({ t: 'chat', text: chatInput.value });
      chatInput.value = '';
    });
    chat.append(el('h2', 'online-panel-title', 'Chat'), this.chatLog, chatInput);

    const body = el('div', 'online-lobby-body');
    this.spectatorBox = el('section', 'online-panel online-spectator-box');
    // Someone's connection is poor: who, Test again, and for the host Kick (renderConnections).
    this.netWarning = el('div', 'online-net-warning');
    this.netWarning.setAttribute('role', 'alert');
    this.netWarning.hidden = true;
    const players = el('div', 'online-players');
    players.append(this.slotBox, this.netWarning);
    const left = el('div', 'online-col');
    left.append(bulkBox, players, this.spectatorBox, this.optionBox);
    // Invite players: the lobby's invite code, its link, and friends to invite (renderInvite).
    this.inviteBox = el('section', 'online-panel online-invite');
    this.inviteBox.setAttribute('aria-labelledby', 'online-invite-title');
    const right = el('div', 'online-col');
    right.append(this.mapBox, this.inviteBox, chat);
    body.append(left, right);

    const bar = el('footer', 'online-bar');
    // "I'm ready" is a switch (the Lobby board); the host starts instead.
    this.readyCtl = toggle({ label: "I'm ready", rowClass: 'online-ready-row', onChange: () => this.toggleReady() });
    this.startBtn = button('Start game', 'online-btn-primary', () => this.startGame());
    this.barStatus = el('span', 'online-bar-status');
    this.barLed = led('off');
    const status = el('span', 'online-bar-line');
    status.setAttribute('role', 'status');
    status.append(this.barLed, this.barStatus);
    bar.append(this.readyCtl.row, status, this.startBtn);

    this.resumeBox = el('section', 'online-panel online-resume');
    this.resumeBox.setAttribute('role', 'status');
    this.resumeBox.hidden = true;
    page.append(head, this.banner, this.resumeBox, body, bar);
    this.root.append(page);
    this.followFriends();
    this.renderSelfNet();
    this.renderInvite();
    // The time left on the invite code.
    clearInterval(this.inviteTimer);
    this.inviteTimer = setInterval(() => this.renderInviteTime(), 30_000);
    this.inviteTimer?.unref?.();
  }

  onLobby(m) {
    if (!this.state) return;
    // A lobby during a game: the session went back to its lobby (a rematch
    // this client missed while its connection was away). Reload into it.
    if (this.inGame) {
      this.returnToLobby();
      return;
    }
    // Back in the lobby after a reload (a rematch): build it now.
    if (!this.slotBox) {
      this.state.rejoin = false;
      this.pendingNet = this.state.role === 'spectator' ? [] : null;
      this.buildLobby();
      this.loadServerMaps();
    }
    const mapChanged = (this.state.map ? this.state.map.hash : null) !== (m.map ? m.map.hash : null);
    this.lobbySounds(m, mapChanged);
    Object.assign(this.state, {
      slots: m.slots,
      options: m.options,
      map: m.map,
      hostId: m.hostId,
      spectators: m.spectators,
      maxSpectators: m.maxSpectators,
      resume: m.resume ?? null,
      mission: m.mission ?? null,
      lobbySeen: true,
      // Protocol 8: the lobby's invite code while one is valid (every member sees it).
      invite: m.invite ?? null,
    });
    this.state.role = m.spectators.some((x) => x.client === this.state.you) ? 'spectator' : 'player';
    if (mapChanged) this.ensureMap(m.map);
    // The host's New seed arrived (its loader then waits for the map only).
    if (m.options?.seed === this.seedPending) this.seedPending = null;
    this.renderLobby();
    this.renderInvite();
    this.settleBulk({ slots: m.slots });
  }

  /**
   * OpenRA LobbyLogic's sounds for a lobby update: PlayerJoined when this
   * player enters the lobby or another one joins, LobbyOptionChanged when
   * the options or the map change. (Leaving players: the `left` message.)
   */
  lobbySounds(m, mapChanged) {
    const clients = new Set([...m.slots.filter((x) => x.type === 'human').map((x) => x.client), ...m.spectators.map((x) => x.client)]);
    const before = this.lobbyClients;
    this.lobbyClients = clients;
    if (this.inGame) return;
    if (!before) {
      this.ctx.sounds?.lobby('joined');
    } else if ([...clients].some((c) => !before.has(c) && c !== this.state.you)) {
      this.ctx.sounds?.lobby('joined');
    } else if (this.state.lobbySeen && (mapChanged || JSON.stringify(m.options) !== JSON.stringify(this.state.options))) {
      this.ctx.sounds?.lobby('option');
    }
  }

  mySlot() {
    return this.state.slots.findIndex((s) => s.type === 'human' && s.client === this.state.you);
  }

  renderLobby() {
    if (!this.slotBox) return;
    this.markerList = this.lobbyMarkers();
    this.renderSlots();
    this.renderOptions();
    this.renderMap();
    const me = this.state.slots[this.mySlot()];
    const mapReady = this.mapReady();
    this.renderSpectators();
    this.readyCtl.row.hidden = this.isHost || !me;
    this.startBtn.hidden = !this.isHost;
    this.readyCtl.label.textContent = this.state.resume ? 'Ready to continue' : "I'm ready";
    this.readyCtl.set(!!me?.ready);
    this.renderResume();
    this.readyCtl.input.disabled = !mapReady && !(me && me.ready);
    // The players (by name) who are not ready yet (js/online-view.js).
    const waiting = notReady(this.state.slots, this.state.hostId);
    // Who still lacks the lobby's map (players and spectators; the server checks this too).
    const lacking = this.lackingMap();
    // A generated map still being made (renderMap): Start game waits for it.
    this.startBtn.disabled = waiting.length > 0 || !mapReady || lacking.length > 0 || !!this.previewBusy;
    const text = !mapReady
      ? this.mapStatus.text || 'Waiting for the map.'
      : lacking.length > 0
        ? `Waiting for ${lacking.join(', ')} to install the map.`
        : waiting.length > 0
          ? `${waitingText(waiting)} to be ready.`
          : this.isHost
            ? 'Everyone is ready.'
            : 'Waiting for the host to start.';
    this.barStatus.textContent = text;
    // The lamp beside the words: yellow while waiting, green when the game can start.
    setLed(this.barLed, mapReady && !lacking.length && !waiting.length ? 'ok' : 'warn');
    this.renderConnections();
  }

  /**
   * Host: Start game. A poor connection is said first (the start check of
   * the NetLobby board) but never blocks: the host may start anyway.
   */
  async startGame() {
    const check = startCheck({ slots: this.state.slots, players: this.netq?.players, you: this.state.you });
    if (check && !(await confirmChoice('Start the game?', check.text, { yes: 'Start anyway', no: 'Wait' }))) return;
    this.send({ t: 'start' });
  }

  /** This player's own connection, top right. */
  renderSelfNet() {
    const box = this.selfNet;
    if (!box) return;
    const v = selfConnection(this.netq?.self ?? null);
    // Every 2 s new numbers come in: the part is drawn again only when what it says changed.
    const sig = `${v.quality}|${v.bars}|${v.title}|${v.detail}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    box.className = `online-self-net online-q-${v.quality ?? 'none'}`;
    const text = el('span', 'online-self-text');
    text.append(el('span', 'online-self-title', v.title), el('span', 'online-self-detail', v.detail));
    box.append(signalBars(v), text);
  }

  /**
   * The Connection column (bars, ms and the detail line per player) and the
   * warning bar, from the last netstat (js/netquality.js). Called on every
   * lobby render and whenever new numbers come in, without rebuilding the slots.
   */
  renderConnections() {
    if (!this.slotBox || !this.state) return;
    const players = this.netq?.players ?? new Map();
    for (const cell of this.slotBox.querySelectorAll('.online-cell-net')) {
      // AI and empty slots have no connection.
      if (cell.dataset.client === undefined) continue;
      const client = Number(cell.dataset.client);
      const v = connectionCell(players.get(client) ?? null);
      // New numbers every 2 s: a cell is drawn again only when what it says changed.
      if (cell.dataset.sig === v.label) continue;
      cell.dataset.sig = v.label;
      cell.textContent = '';
      cell.className = `online-cell online-cell-net online-q-${v.quality ?? 'none'}`;
      cell.title = v.label;
      const text = el('span', 'online-net-text');
      text.append(el('span', 'online-net-ms', v.ms || v.word), el('span', 'online-net-detail', v.ms ? `${v.word} · ${v.detail}` : v.detail));
      cell.append(signalBars(v), text, el('span', 'ui-sr-only', v.label));
    }
    const box = this.netWarning;
    if (!box) return;
    const w = connectionWarning({ slots: this.state.slots, players, you: this.state.you, hostId: this.state.hostId, isHost: this.isHost && !this.state.resume });
    // The alert is said again only when its words or its buttons change; the focus stays on its button.
    const sig = w ? `${w.text}|${w.client}|${w.slot}|${w.canKick}` : '';
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const focusKey = box.contains(globalThis.document?.activeElement) ? (document.activeElement.dataset?.key ?? null) : null;
    box.hidden = !w;
    box.textContent = '';
    if (!w) return;
    box.append(badge('bad', 'Unstable'), el('span', 'online-net-warning-text', w.text));
    const actions = el('span', 'online-net-warning-actions');
    const again = button('Test again', null, () => this.netq?.testAgain());
    again.dataset.key = 'test-again';
    actions.append(again);
    if (w.canKick) {
      const kick = button('Kick', 'online-btn-danger', () => this.kickPoor(w));
      kick.dataset.key = 'kick';
      kick.setAttribute('aria-label', `Kick ${w.name}`);
      actions.append(kick);
    }
    box.append(actions);
    if (focusKey) [...box.querySelectorAll('[data-key]')].find((b) => b.dataset.key === focusKey)?.focus();
  }

  /**
   * Host: kick the player the warning names, after asking. The lobby may have
   * changed while the question was open: only that player, still in that slot, goes.
   */
  async kickPoor(w) {
    if (!(await confirmChoice('Kick player', `Remove ${w.name} from the lobby? Their slot opens for someone else.`, { yes: 'Kick', danger: true }))) return false;
    const slot = this.state?.slots[w.slot];
    if (this.inGame || !this.isHost || slot?.type !== 'human' || slot.client !== w.client) {
      this.setError(`${w.name} is no longer in that slot: nobody was kicked.`);
      return false;
    }
    this.send({ t: 'slot', slot: w.slot, type: 'open' });
    return true;
  }

  // ---- Invite players ------------------------------------------------------------------

  /**
   * The Invite players panel (the InviteCode board): the lobby's code (every
   * member sees it; the host makes a new one), Copy code and Copy link, the
   * time it has left, the long session link, and friends to invite.
   */
  renderInvite() {
    const box = this.inviteBox;
    if (!box || !this.state) return;
    const st = this.state;
    const focusKey = box.contains(globalThis.document?.activeElement) ? (document.activeElement.dataset?.key ?? null) : null;
    box.textContent = '';
    const title = el('h2', 'online-panel-title', 'Invite players');
    title.id = 'online-invite-title';
    box.append(title);
    const inv = st.invite;
    const host = this.isHost && !st.resume;
    const code = el('div', 'online-invite-code');
    code.append(el('span', 'online-field-label', 'Invite code'));
    if (inv) {
      const shown = formatInviteCode(inv.code);
      const line = el('div', 'online-invite-line');
      const value = el('span', 'online-invite-value', shown);
      value.setAttribute('aria-label', `Invite code ${[...inv.code].join(' ')}`);
      const copyCode = button('Copy code', 'online-btn-small', () => this.copyText(shown, `Copied the code ${shown}.`));
      copyCode.dataset.key = 'copy-code';
      const copyLink = button('Copy link', 'online-btn-small', () => this.copyText(inviteLink(inv.code), 'Copied the invite link.'));
      copyLink.dataset.key = 'copy-link';
      line.append(value, copyCode, copyLink);
      this.inviteTime = el('p', 'online-hint online-invite-time');
      code.append(line, this.inviteTime);
      this.renderInviteTime();
      if (host) {
        const again = button('New code', 'online-btn-small', () => this.newInvite());
        again.dataset.key = 'new-code';
        again.title = 'The old code stops working at once';
        code.append(again);
      }
    } else {
      this.inviteTime = null;
      code.append(el('p', 'online-hint', host ? 'No invite code yet. A code lets friends join without the long link, also when the lobby is private.' : 'No invite code yet: the host can make one.'));
      if (host) {
        const make = button('Make a code', 'online-btn-primary online-btn-small', () => this.newInvite());
        make.dataset.key = 'new-code';
        code.append(make);
      }
    }
    box.append(code);
    // The long link (the session id) keeps working, code or not.
    const long = button('Copy session link', 'online-btn-small online-invite-long', () => this.copyText(`${location.origin}${location.pathname}?join=${st.session.id}`, 'Copied the session link.'));
    long.dataset.key = 'copy-long';
    box.append(long);
    this.inviteStatus = el('p', 'online-hint online-invite-status');
    this.inviteStatus.setAttribute('role', 'status');
    box.append(this.inviteStatus);
    // Friends who are around (signed-in players).
    if (this.account?.user && this.friendsDoc) {
      const v = friendsView(this.friendsDoc, { lobby: { session: st.session.id }, version: this.ctx.version });
      const people = v.groups.flatMap((g) => g.people).filter((p) => p.actions.some((a) => a.id === 'invite'));
      const list = el('ul', 'online-invite-friends');
      list.setAttribute('aria-label', 'Invite a friend');
      for (const p of people) {
        const action = p.actions.find((a) => a.id === 'invite');
        const li = el('li', 'online-invite-friend');
        const who = el('span', 'online-invite-who');
        who.append(el('span', 'online-invite-name', p.name), el('span', 'online-hint', `${p.word}: ${p.status}`));
        const b = button(action.label, action.disabled ? 'online-btn-small' : 'online-btn-small online-btn-primary', () => this.inviteFriend(p));
        b.disabled = action.disabled || !inv;
        b.title = !inv ? (host ? 'Make an invite code first' : 'The host makes an invite code first') : action.title;
        b.setAttribute('aria-label', `${action.label}: ${p.name}`);
        b.dataset.key = `invite:${p.username}`;
        li.append(led(p.led), who, b);
        list.append(li);
      }
      const sub = el('h3', 'online-invite-sub', 'Invite a friend');
      box.append(sub, people.length ? list : el('p', 'online-hint', 'None of your friends is online right now.'));
    }
    if (focusKey) [...box.querySelectorAll('[data-key]')].find((e) => e.dataset.key === focusKey && !e.disabled)?.focus();
  }

  /** "Valid while this lobby is open, at most 2 hours. 1 h 42 min left." */
  renderInviteTime() {
    const inv = this.state?.invite;
    if (!this.inviteTime || !inv) return;
    this.inviteTime.textContent = `Valid while this lobby is open, at most 2 hours: ${inviteLeftText(inviteMsLeft(inv.expiresAt))}. The link opens ${inviteLink(inv.code).replace(/^https?:\/\//, '')}.`;
  }

  /** Host: a new invite code (the old one stops working). */
  async newInvite() {
    if (!this.isHost || !this.member || !this.state?.session) return;
    try {
      const r = await createInvite(this.state.session.id, this.member);
      if (!this.state) return;
      this.state.invite = { code: normalizeInviteCode(r.code) ?? r.code, expiresAt: r.expiresAt };
      this.renderInvite();
      this.inviteStatus.textContent = `New code: ${formatInviteCode(this.state.invite.code)}.`;
    } catch (err) {
      if (this.inviteStatus) this.inviteStatus.textContent = `No code: ${messageOf(err)}`;
    }
  }

  /** Invite a friend into this lobby (they see it in their friends list, with the code). */
  async inviteFriend(p) {
    if (!this.friendsStore || !this.state?.session) return;
    try {
      await this.friendsStore.invite(p.username, this.state.session.id);
      if (this.inviteStatus) this.inviteStatus.textContent = `Invited ${p.name}.`;
    } catch (err) {
      if (this.inviteStatus) this.inviteStatus.textContent = `Could not invite ${p.name}: ${err?.message ?? err}`;
    }
  }

  async copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      if (this.inviteStatus) this.inviteStatus.textContent = done;
    } catch {
      if (this.inviteStatus) this.inviteStatus.textContent = `Copy it by hand: ${text}`;
    }
  }

  /** The saved game this lobby resumes, and whose players it still waits for. */
  renderResume() {
    const box = this.resumeBox;
    if (!box) return;
    const r = this.state.resume;
    box.hidden = !r;
    box.textContent = '';
    if (!r) return;
    box.append(el('strong', null, `Resuming "${r.title}"`), el('span', null, ` saved ${new Date(r.createdAt).toLocaleString()}, after ${formatTicks(r.ticks)}. The saved settings stay; getting ready means continuing this game.`));
    if (r.waiting.length) box.append(el('p', 'online-warning', `Waiting for its players: ${r.waiting.join(', ')}.`));
  }

  /** Names of the members (players and spectators) without the lobby's map installed. */
  lackingMap() {
    const st = this.state;
    if (!st.map) return [];
    return [...st.slots.filter((s) => s.type === 'human'), ...st.spectators].filter((m) => m.mapState && m.mapState !== 'installed').map((m) => m.name);
  }

  /** A member's map state as a small badge (only while the lobby has a map). */
  mapBadge(member) {
    if (!this.state.map || !member.mapState) return null;
    const badge = el('span', `online-badge online-map-${member.mapState}`, MAP_STATE_TEXT[member.mapState] ?? member.mapState);
    badge.dataset.mapState = member.mapState;
    return badge;
  }

  /** Spectator places: who watches, the host's limit, and switching sides. */
  renderSpectators() {
    const box = this.spectatorBox;
    if (!box) return;
    const st = this.state;
    box.textContent = '';
    const title = el('h2', 'online-panel-title', `Spectators (${st.spectators.length} / ${st.maxSpectators})`);
    title.append(this.spectatorTip.root);
    box.append(title);
    const list = el('div', 'online-spectators');
    for (const sp of st.spectators) {
      const row = el('span', 'online-spectator', sp.name);
      if (sp.account) row.append(accountMark());
      if (sp.client === st.hostId) row.append(el('span', 'online-badge', 'HOST'));
      if (sp.client === st.you) row.append(el('span', 'online-badge online-badge-you', 'YOU'));
      const badge = this.mapBadge(sp);
      if (badge) row.append(badge);
      // The host can remove a spectator (for example one who declined the map).
      if (this.isHost && sp.client !== st.you) {
        const remove = button('Remove', 'online-btn-small', () => this.send({ t: 'kick', client: sp.client }));
        remove.setAttribute('aria-label', `Remove ${sp.name}`);
        row.append(remove);
      }
      list.append(row);
    }
    if (!st.spectators.length) list.append(el('span', 'online-muted', 'Nobody is watching.'));
    box.append(list);
    const controls = el('div', 'online-tools');
    if (this.isHost) {
      // Never fewer places than spectators watching.
      const label = el('span', 'online-field-label', 'Spectator places');
      label.id = `online-lbl-${++uid}`;
      const places = stepper({
        labelledBy: label.id,
        values: Array.from({ length: MAX_SPECTATORS + 1 }, (_, i) => i).filter((i) => i >= st.spectators.length),
        value: st.maxSpectators,
        decLabel: 'Fewer places',
        incLabel: 'More places',
        onChange: (v) => this.send({ t: 'spectators', max: Number(v) }),
      });
      describedBy(places.field, this.spectatorTip);
      const row = el('div', 'online-field');
      row.append(label, places.root);
      controls.append(row);
    }
    const watching = st.role === 'spectator';
    const toggle = button(watching ? 'Play' : 'Spectate', null, () => this.send({ t: 'spectate', on: !watching }));
    toggle.disabled = watching ? !st.slots.some((x) => x.type === 'open') : st.spectators.length >= st.maxSpectators;
    controls.append(toggle);
    box.append(controls);
  }

  /** The slots as js/lobby-bulk.js sees them: the lobby map's locks and which one is you. */
  bulkSlots() {
    const setup = this.state.map?.setup ?? null;
    return this.state.slots.map((s, i) => ({
      ...s,
      you: s.type === 'human' && s.client === this.state.you,
      locked: setup && !this.state.resume ? ['team', 'faction', 'color', 'type'].filter((part) => slotLocked(setup, i, part)) : [],
    }));
  }

  /** Host: apply bulk action `id` to the selected slots (all when none is) with one `slots` message. */
  applyBulk(id, selected) {
    const mission = this.state.mission ? coopMission(this.state.mission.id) : null;
    const plan = planBulk(this.bulkSlots(), id, {
      context: 'online',
      selected,
      colorCount: COLOR_COUNT,
      teamMax: TEAM_MAX,
      mission: !!mission,
      missionPlaces: mission ? mission.players.length : Infinity,
    });
    if (plan.error || !plan.changes.length) return plan;
    // The bar reports once the lobby shows the changes, or the refusal (settleBulk).
    this.bulkWait = { changes: plan.changes, summary: plan.summary };
    this.send({ t: 'slots', changes: plan.changes });
    return { pending: true };
  }

  /**
   * A lobby update or a server error after a bulk edit: report it in the bar.
   * A lobby that does not show the changes yet (another member's change the
   * server handled first) keeps waiting.
   */
  settleBulk({ slots = null, error = null }) {
    const wait = this.bulkWait;
    if (!wait || !this.bulk) return;
    if (error) {
      this.bulkWait = null;
      this.bulk.report(`Refused: ${error}`, true);
      return;
    }
    const shows = (c) =>
      Object.entries(c).every(([k, v]) => {
        const s = slots[c.slot];
        if (k === 'slot') return true;
        if (k === 'spawn') return v === null ? s?.spawn === undefined : s?.spawn === v;
        return s?.[k] === v;
      });
    if (!wait.changes.every(shows)) return;
    this.bulkWait = null;
    this.bulk.report(wait.summary);
  }

  /**
   * A select of the slot table, remembered by `key` (slot and part) so a
   * lobby update can give the focus back to the same control; `tip`: its
   * column's help.
   */
  slotPlate(key, choices, value, onChange, { label, disabled = false, title = '', tip = null, grouped = false }) {
    const p = select(choices, value, onChange, { label, grouped });
    p.setDisabled(disabled);
    if (title) p.button.title = title;
    p.button.dataset.ctl = key;
    if (tip) describedBy(p.button, tip);
    this.slotPlates.push(p);
    return p;
  }

  renderSlots() {
    const box = this.slotBox;
    // The selects of the last render go (an open list closes); the focused one is found again by its key.
    const focusKey = box.contains(globalThis.document?.activeElement) ? (document.activeElement.dataset?.ctl ?? null) : null;
    for (const p of this.slotPlates ?? []) p.destroy();
    this.slotPlates = [];
    box.textContent = '';
    box.append(this.slotHead);
    const host = this.isHost;
    const mine = this.mySlot();
    const playingCount = this.state.slots.filter((x) => x.type === 'human' || x.type === 'ai').length;
    this.bulk?.begin(this.state.slots.length, { available: host && !this.state.resume, mission: !!this.state.mission, teamMax: TEAM_MAX, players: playingCount });
    this.state.slots.forEach((slot, i) => {
      const row = el('div', `online-slot online-slot-${slot.type}`);
      row.setAttribute('role', 'row');
      const who = el('div', 'online-cell online-cell-player');
      // A co-op mission's places are its playable players (Allies1, Allies2): faction, colour and team are the mission's.
      const mission = this.state.mission ? coopMission(this.state.mission.id) : null;
      who.append(el('span', 'online-badge', mission && i < mission.players.length ? mission.players[i] : `P${i + 1}`));
      this.bulk?.decorate(row, who, i, `slot ${i + 1}`);
      // A resumed save keeps its saved slots. Your own slot and (host) the AI
      // slots are yours to edit; like OpenRA's lobby, the host also sets
      // another player's team, handicap and start, not its faction or colour.
      const editable = !this.state.resume && ((slot.type === 'human' && i === mine) || (slot.type === 'ai' && host));
      const hostSets = editable || (!this.state.resume && host && slot.type === 'human');
      // The connection of a person in the slot (renderConnections fills it).
      const net = el('div', 'online-cell online-cell-net');
      if (slot.type === 'human') net.dataset.client = String(slot.client);
      else net.classList.add('is-empty');
      const nameBadges = () => {
        who.append(el('span', 'online-player-name', slot.name));
        if (slot.account) who.append(accountMark());
        if (slot.client === this.state.hostId) who.append(el('span', 'online-badge', 'HOST'));
        if (i === mine) who.append(el('span', 'online-badge online-badge-you', 'YOU'));
      };
      if (mission && slot.type === 'human') {
        nameBadges();
        row.append(who, el('div', 'online-cell online-muted', 'Set by the mission'), el('div', 'online-cell'), el('div', 'online-cell'), net);
      } else if (slot.type === 'human' || slot.type === 'ai') {
        row.style.setProperty('--slot-color', rgbCss(this.ctx.colors[slot.color] || [1, 1, 1]));
        if (slot.type === 'human') {
          nameBadges();
        } else {
          // The OpenRA bot this AI plays (absent in lobbies from before bot types: Normal AI).
          const bot = this.slotPlate(`${i}:bot`, BOTS.map((b) => [b, LABELS.bot[b]]), slot.bot ?? 'normal', (v) => this.send({ t: 'slot', slot: i, bot: v }), {
            label: `Player ${i + 1} bot`,
            disabled: !host || Boolean(this.state.resume),
            tip: this.columnTips.playerOnline,
          });
          const diff = this.slotPlate(`${i}:difficulty`, DIFFICULTIES.map((d) => [d, LABELS.difficulty[d]]), slot.difficulty, (v) => this.send({ t: 'slot', slot: i, difficulty: v }), {
            label: `Player ${i + 1} difficulty`,
            disabled: !host,
            tip: this.columnTips.playerOnline,
          });
          who.append(bot.root, diff.root);
        }
        // The lobby map's locks (map format version 2): the server refuses changes to them.
        const setup = this.state.map?.setup ?? null;
        const locked = (part) => !!setup && !this.state.resume && slotLocked(setup, i, part);
        const lockTitle = (part) => (locked(part) ? 'Locked by the map' : '');
        const faction = this.slotPlate(`${i}:faction`, FACTION_GROUPS, slot.faction, (v) => this.send({ t: 'slot', slot: i, faction: v }), {
          label: `Player ${i + 1} faction`,
          grouped: true,
          disabled: !editable || locked('faction'),
          title: lockTitle('faction'),
          tip: this.columnTips.faction,
        });
        const color = this.slotPlate(
          `${i}:color`,
          Array.from({ length: COLOR_COUNT }, (_, c) => [c, this.ctx.colorNames[c] || `Color ${c + 1}`]),
          slot.color,
          (v) => this.send({ t: 'slot', slot: i, color: Number(v) }),
          { label: `Player ${i + 1} color`, disabled: !editable || locked('color'), title: lockTitle('color'), tip: this.columnTips.colorOnline },
        );
        const team = this.slotPlate(
          `${i}:team`,
          Array.from({ length: TEAM_MAX + 1 }, (_, t) => [t, t === 0 ? 'None' : `Team ${t}`]),
          slot.team,
          (v) => this.send({ t: 'slot', slot: i, team: Number(v) }),
          { label: `Player ${i + 1} team`, disabled: !hostSets || locked('team'), title: lockTitle('team'), tip: this.columnTips.team },
        );
        // OpenRA handicap: each player sets its own, the host an AI's.
        const handicap = this.slotPlate(
          `${i}:handicap`,
          HANDICAPS.map((h) => [h, `${h}%`]),
          slot.handicap ?? 0,
          (v) => this.send({ t: 'slot', slot: i, handicap: Number(v) }),
          { label: `Player ${i + 1} handicap`, disabled: !hostSets, tip: this.columnTips.handicap },
        );
        // Start position (OpenRA's spawn dropdown): automatic, or a spawn no other slot picked.
        const markers = this.markerList ?? [];
        const auto = markers.find((m) => m.slot === i && !m.picked);
        const spawn = this.slotPlate(
          `${i}:spawn`,
          [['auto', auto ? `Automatic (${auto.letter})` : 'Automatic'], ...markers.filter((m) => !this.state.slots.some((x, k) => k !== i && x.spawn === m.index)).map((m) => [m.index, `Position ${m.letter}`])],
          Number.isInteger(slot.spawn) && markers.some((m) => m.index === slot.spawn) ? slot.spawn : 'auto',
          (v) => this.send({ t: 'slot', slot: i, spawn: v === 'auto' ? null : Number(v) }),
          { label: `Player ${i + 1} start position`, disabled: !hostSets || !this.spawnsEnabled(), tip: this.columnTips.spawn },
        );
        const cells = [[faction.root], [color.root], [team.root, handicap.root, spawn.root]].map((c) => {
          const cell = el('div', 'online-cell');
          cell.append(...c);
          return cell;
        });
        row.append(who, ...cells, net);
      } else {
        who.append(el('span', 'online-muted', slot.type === 'open' ? 'Open' : 'Closed'));
        row.append(who, el('div', 'online-cell'), el('div', 'online-cell'), el('div', 'online-cell'), net);
      }
      const action = el('div', 'online-cell online-cell-action');
      if (slot.type === 'human' && slot.client !== this.state.hostId) {
        // The word with a lamp: green Ready, yellow Not ready.
        action.append(badge(slot.ready ? 'ready' : 'waiting', slot.ready ? 'Ready' : 'Not ready'));
      }
      if (slot.type === 'human') {
        const mapState = this.mapBadge(slot);
        if (mapState) action.append(mapState);
      }
      const missionPlaces = this.state.mission ? coopMission(this.state.mission.id).players.length : Infinity;
      if (host && i !== mine && !this.state.resume && i < missionPlaces) {
        const current = slot.type === 'human' ? 'human' : slot.type;
        // People play a co-op mission: no computer players (OpenRA AllowBots: False).
        const choices = this.state.mission ? [['open', 'Open'], ['closed', 'Closed']] : [['open', 'Open'], ['closed', 'Closed'], ['ai', 'Computer']];
        if (slot.type === 'human') choices.unshift(['human', 'Player (kick)']);
        const typeLocked = !!this.state.map?.setup && slotLocked(this.state.map.setup, i, 'type');
        const type = this.slotPlate(
          `${i}:type`,
          choices,
          current,
          (v) => {
            if (v !== 'human') this.send({ t: 'slot', slot: i, type: v });
          },
          { label: `Player ${i + 1} slot type`, disabled: typeLocked, title: typeLocked ? 'Locked by the map' : '', tip: this.columnTips.playerOnline },
        );
        action.append(type.root);
      }
      if (slot.type === 'open' && !this.state.resume && i < missionPlaces) action.append(button('Take', null, () => this.send({ t: 'slot', slot: i })));
      row.append(action);
      box.append(row);
    });
    this.bulk?.sync();
    if (focusKey) this.slotPlates.find((p) => p.button.dataset.ctl === focusKey && !p.button.disabled)?.button.focus();
  }

  /** Send the options with `patch` applied (host only; the server checks). */
  sendOptions(patch) {
    const options = { ...this.state.options, ...patch };
    // A game mode never changes what the lobby map locks (the server would refuse it).
    const setup = this.state.map?.setup;
    for (const k of setup?.lockedOptions ?? []) options[k] = setup.options[k];
    this.send({ t: 'options', options });
  }

  /** The Game options panel: built once per lobby, renderOptions shows the current values. */
  buildOptions() {
    const box = this.optionBox;
    box.textContent = '';
    box.append(el('h2', 'online-panel-title', 'Game options'));
    // Game mode: only the host picks; everyone sees which mode the options are.
    this.modePicker = new ModePicker({
      context: 'online',
      registry: defaultRegistry(),
      selectClass: 'online-select',
      buttonClass: 'online-btn',
      inputClass: 'online-input',
      onApply: (mode) => this.sendOptions(presetOptions(mode.options)),
    });
    this.optionControls = {};
    const edit = (key, value) => {
      this.modePicker.optionChanged();
      this.sendOptions({ [key]: value });
    };
    const selectRow = ([key, label, choices]) => {
      const numeric = typeof choices[0][0] === 'number';
      const s = select(choices, choices[0][0], (v) => edit(key, numeric ? Number(v) : v), { label, small: false });
      this.optionControls[key] = s;
      const row = field(label, s, key);
      this.optionRows[key] = row;
      return row;
    };
    this.optionRows = {};
    const world = el('fieldset', 'online-world');
    this.optionWorld = world;
    world.append(el('legend', 'online-world-title', 'World'), ...WORLD_OPTIONS.map(selectRow));
    const grid = el('div', 'online-option-grid');
    grid.append(...SELECT_OPTIONS.map(selectRow));
    this.optionGrid = grid;
    const toggles = el('div', 'online-toggles');
    this.optionToggles = toggles;
    for (const [key, label] of TOGGLES) {
      const row = el('div', 'online-toggle-row');
      const name = el('label', 'online-toggle');
      const box2 = switchInput();
      box2.addEventListener('change', () => edit(key, box2.checked));
      this.optionControls[key] = box2;
      name.append(box2, el('span', null, label));
      row.append(name, infoTip(key, { label, describes: box2 }).root);
      toggles.append(row);
    }
    // Cheats change the game for everyone: every player sees it before getting ready.
    this.cheatsWarning = el('p', 'online-cheats', 'CHEATS ENABLED: every player can use the debug menu (instant build, free cash, reveal map).');
    this.cheatsWarning.setAttribute('role', 'status');
    this.cheatsWarning.hidden = true;
    box.append(this.modePicker.root, world, grid, toggles, this.cheatsWarning);
  }

  renderOptions() {
    const o = this.state.options;
    if (!o || !this.optionControls) return;
    // A resumed save keeps its options.
    const host = this.isHost && !this.state.resume;
    // Options the lobby map locks (map format version 2): the server refuses changes to them.
    const setup = this.state.map?.setup ?? null;
    const lockedOption = (key) => !!setup && optionLocked(setup, key);
    for (const [key] of [...WORLD_OPTIONS, ...SELECT_OPTIONS]) {
      const p = this.optionControls[key];
      p.set(o[key]);
      p.setDisabled(!host || lockedOption(key));
      p.button.title = lockedOption(key) ? 'Locked by the map' : '';
    }
    for (const [key] of TOGGLES) {
      this.optionControls[key].checked = o[key];
      this.optionControls[key].disabled = !host || lockedOption(key);
      this.optionControls[key].title = lockedOption(key) ? 'Locked by the map' : '';
    }
    // A map file brings its own layout, biome and buildings; the weather still applies.
    this.optionRows.mapStyle.hidden = !!this.state.map;
    this.optionRows.biome.hidden = !!this.state.map;
    this.optionRows.techBuildings.hidden = !!this.state.map;
    this.cheatsWarning.hidden = !o.cheats;
    this.modePicker.render(o, { editable: host });
    // A co-op mission brings its own world and rules: only the game speed, the movement model and the factory loss rule apply.
    const mission = !!this.state.mission;
    this.modePicker.root.hidden = mission;
    this.optionWorld.hidden = mission;
    this.optionToggles.hidden = mission;
    if (mission) this.cheatsWarning.hidden = true;
    // The game speed, how units move and what a lost factory does apply to a co-op mission too.
    for (const [key] of SELECT_OPTIONS) this.optionRows[key].hidden = mission && !MISSION_SELECT_OPTIONS.includes(key);
  }

  renderMap() {
    const box = this.mapBox;
    const st = this.state;
    this.previewBusy = false;
    box.textContent = '';
    box.append(el('h2', 'online-panel-title', 'Battlefield'));
    // A marker with focus keeps it across the lobby update.
    const refocus = this.spawnLayer?.buttons.indexOf(globalThis.document?.activeElement) ?? -1;
    const frame = el('div', 'online-preview-frame');
    const canvas = el('canvas', 'online-preview');
    canvas.setAttribute('role', 'img');
    const layer = el('div', 'spawn-layer');
    frame.append(canvas, layer);
    // The map may have come in since the slots were drawn (an install).
    this.markerList = this.lobbyMarkers();
    const caption = el('p', 'online-caption');
    // The generated map is made for this many players (protocol generatedMapPlayers, as its spawns).
    const players = generatedMapPlayers(st.slots.filter((s) => s.type === 'human' || s.type === 'ai').length);
    if (st.mission) {
      const m = coopMission(st.mission.id);
      caption.append(el('span', null, `${m.title} (${m.players.length} players)`), el('span', 'online-badge', 'CO-OP MISSION'));
      this.drawMissionPreview(canvas, st.mission);
    } else if (st.map) {
      // Names and authors are text, never markup (they come from map files).
      caption.append(el('span', null, `${st.map.name} (${st.map.players} players)`));
      caption.append(el('span', 'online-badge', st.map.shared ? 'CUSTOM' : 'COMMUNITY'));
      if (st.map.modded) caption.append(el('span', 'online-badge online-badge-modded', 'MODDED'));
      const json = this.installed.get(st.map.hash);
      if (json) {
        this.drawPreview(canvas, () => this.ctx.Game.map_file_preview(json), JSON.parse(json).width);
        this.lens?.setSource(`map:${st.map.hash}`, (art) => art.mapSteps(json), { width: st.map.width, height: st.map.height });
      } else {
        // Not installed: no preview, nothing to magnify.
        this.lens?.clearSource();
      }
    } else {
      const o = st.options;
      // What a random style or biome comes out as for this seed (every peer computes the same).
      const G = this.ctx.Game;
      const look = G.resolved_style ? `, ${LABELS.mapStyle[G.resolved_style(o.seed, o.mapStyle)]}, ${LABELS.biome[G.resolved_biome(o.seed, o.biome)]}` : '';
      caption.textContent = `Generated, ${LABELS.mapSize[o.mapSize]} ${o.mapSize} x ${o.mapSize}${look}, seed ${o.seed}`;
      const req = this.generatedRequest();
      const got = this.ctx.previews?.get(req) ?? null;
      if (this.ctx.previews && !got && this.previewFailed !== previewKey(req)) {
        // Made off the main thread: the preview says so and Start game waits (renderLobby).
        this.previewBusy = true;
        frame.classList.add('is-busy');
        frame.setAttribute('aria-busy', 'true');
        frame.append(el('div', 'online-preview-loading', 'Generating the map...'));
        this.awaitPreview(req);
      } else {
        this.drawPreview(canvas, () => got?.rgba ?? G.map_preview_styled(o.seed, o.mapSize, players, o.mapStyle, o.biome), o.mapSize);
      }
      const gen = { seed: o.seed, size: o.mapSize, players, style: o.mapStyle, biome: o.biome, tech: o.techBuildings ?? 'standard' };
      this.lens?.setSource(`gen:${gen.seed}/${gen.size}/${gen.players}/${gen.style}/${gen.biome}/${gen.tech}`, (art) => art.generatedSteps(gen), { width: gen.size, height: gen.size });
    }
    canvas.setAttribute('aria-label', `Map preview: ${caption.textContent}`);
    box.append(frame, caption);
    // On the page first: a lens showing under the mouse stays over the new
    // preview. The frame gets the pointer (the start markers lie over the canvas).
    this.lens?.attach(frame, canvas);
    this.renderSpawnLayer(layer, refocus);
    if (st.map) box.append(el('p', 'online-muted online-map-details', `By ${st.map.author}, ${st.map.width} x ${st.map.height} cells, ${formatBytes(st.map.bytes)}`));
    if (st.mission) box.append(this.renderMission());
    const offer = this.renderMapOffer();
    if (offer) box.append(offer);
    box.append(el('p', this.mapStatus.ok ? 'online-muted' : 'online-warning', this.mapStatus.text));
    if (st.map && this.mapNotice?.hash === st.map.hash) {
      const notice = el('p', 'online-muted online-map-notice', this.mapNotice.text);
      notice.setAttribute('role', 'status');
      box.append(notice);
    }
    if (!this.isHost || st.resume) return;

    // Host controls: a generated map, a community map or one of the host's own maps.
    const current = st.mission ? `mission:${st.mission.id}` : st.map ? (st.map.shared ? `mine:${st.map.hash}` : `community:${st.map.id}`) : 'generated';
    this.mapPicker?.destroy();
    const source = select(this.mapChoices(current), current, (v) => this.pickMap(v), { grouped: true, label: 'Map', small: false });
    this.mapPicker = source;
    const controls = el('div', 'online-option-grid');
    controls.append(field('Map', source, 'onlineMap'));
    // Back to the generated map, with the seed and size the options kept (like Generated map in the list).
    if (st.map || st.mission) {
      const unload = button(st.mission ? 'Leave mission' : 'Unload map', null, () => this.pickMap('generated'));
      unload.title = 'Go back to the generated map and its seed';
      controls.append(unload);
    }
    if (!st.map && !st.mission) {
      const size = select(MAP_SIZES.map((v) => [v, `${LABELS.mapSize[v]} (${v} x ${v})`]), st.options.mapSize, (v) => this.send({ t: 'options', options: { ...st.options, mapSize: Number(v) } }), {
        label: 'Map size',
        small: false,
      });
      const seedRow = el('div', 'online-seed');
      const seed = el('input', 'online-input');
      seed.inputMode = 'numeric';
      seed.maxLength = 10;
      seed.value = String(st.options.seed);
      seed.addEventListener('change', () => {
        const n = Number(seed.value.trim());
        if (/^\d{1,10}$/.test(seed.value.trim()) && n <= SEED_MAX) this.send({ t: 'options', options: { ...st.options, seed: n } });
        else seed.value = String(st.options.seed);
      });
      const dice = button('New seed', 'online-dice', () => {
        // The loader shows until the lobby has the new seed and its map is made.
        this.seedPending = randomSeed();
        busy(dice);
        this.send({ t: 'options', options: { ...st.options, seed: this.seedPending } });
      });
      const busy = (b) => {
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        b.classList.add('is-busy');
        b.classList.toggle('is-still', !!this.ctx.reducedMotion?.());
        b.textContent = 'Generating...';
      };
      if (this.previewBusy || Number.isInteger(this.seedPending)) busy(dice);
      else dice.setAttribute('aria-busy', 'false');
      seedRow.append(seed, dice);
      controls.append(field('Map size', size, 'mapSize'), field('Seed', seedRow, 'seed', seed));
    }
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json,.oramap';
    file.hidden = true;
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) this.shareFile(file.files[0]);
      file.value = '';
    });
    const load = button('Load map file', null, () => file.click());
    load.title = 'Share a .webra-map.json file or an OpenRA .oramap map with this lobby';
    if (st.mission) {
      box.append(controls);
      return;
    }
    box.append(controls, load, file, el('p', 'online-muted online-map-note', 'Maps you share here go to the players of this session only; they are not published.'));
  }

  /** The lobby's co-op mission: briefing and its options (the host picks them). */
  renderMission() {
    const st = this.state;
    const m = coopMission(st.mission.id);
    const entry = this.missionEntries.get(m.id) ?? null;
    if (!this.missionEntries.has(m.id) && this.ctx.missionInfo) {
      this.missionEntries.set(m.id, null);
      this.ctx
        .missionInfo(m.id)
        .then((e) => {
          this.missionEntries.set(m.id, e);
          if (this.state?.mission?.id === m.id) this.renderMap();
        })
        .catch(() => {});
    }
    const box = el('div', 'online-mission');
    this.missionPlates = [];
    if (entry?.briefing) box.append(el('p', 'online-mission-briefing', entry.briefing));
    const host = this.isHost && !st.resume;
    for (const [key, o] of Object.entries(m.options)) {
      const label = entry?.options?.[key]?.label ?? key;
      const names = Object.fromEntries(entry?.options?.[key]?.values ?? []);
      const control = select(o.values.map((v) => [v, names[v] ?? v]), st.mission.options[key], (v) => this.send({ t: 'mission', mission: { ...st.mission, options: { ...st.mission.options, [key]: v } } }), {
        label,
        small: false,
      });
      control.setDisabled(!host);
      this.missionPlates.push(control);
      box.append(field(label, control));
    }
    box.append(el('p', 'online-muted', 'Every place needs a player. Your game keeps the mission file of this version of WebRA; the server checks it is the same for everyone.'));
    return box;
  }

  /** Draw a co-op mission's map (its file comes from this game's own server, pinned by hash). */
  drawMissionPreview(canvas, mission) {
    const cached = this.missionPreviews.get(mission.hash);
    if (cached) {
      this.drawPreview(canvas, () => cached.rgba, cached.width);
      this.lens?.setSource(`mission:${mission.hash}`, (art) => art.missionSteps(cached.text), { width: cached.width, height: cached.rgba.length / 4 / cached.width });
      return;
    }
    this.lens?.clearSource();
    if (!this.ctx.missionText || this.missionPreviews.has(`loading:${mission.hash}`)) return;
    this.missionPreviews.set(`loading:${mission.hash}`, true);
    this.ctx
      .missionText(mission.id, mission.hash)
      .then((textValue) => {
        const width = JSON.parse(textValue).map.width;
        this.missionPreviews.set(mission.hash, { rgba: this.ctx.Game.mission_preview(textValue), width, text: textValue });
        if (this.state?.mission?.hash === mission.hash) this.renderMap();
      })
      .catch((err) => console.warn('Mission preview failed:', err));
  }

  /**
   * The install question for a lobby map this player does not have yet
   * ("Custom map: <name> by <author>. Install?"), with Install and Decline;
   * after a decline, Install stays offered. Null when there is nothing to ask.
   */
  renderMapOffer() {
    const map = this.state.map;
    const offer = this.mapOffer;
    if (!map || !offer || offer.hash !== map.hash || this.installed.has(map.hash)) return null;
    const box = el('div', 'online-map-offer');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Install the lobby map');
    box.append(el('p', 'online-map-question', mapQuestion(map)));
    const details = [`${map.players} players`, `${map.width} x ${map.height}`, formatBytes(map.bytes)];
    if (map.modded) details.push('modded rules');
    box.append(el('p', 'online-muted', details.join(', ')));
    const actions = el('div', 'online-dialog-actions');
    const install = button(offer.busy ? 'Installing...' : 'Install', 'online-btn-primary', () => this.installLobbyMap());
    install.disabled = !!offer.busy;
    actions.append(install);
    if (!offer.declined) {
      const decline = button('Decline', null, () => this.declineLobbyMap());
      decline.disabled = !!offer.busy;
      actions.append(decline);
    }
    box.append(actions);
    return box;
  }

  /**
   * The spawn markers of the lobby's battlefield (lobby-state spawnMarkers):
   * a map file's spawns once it is installed, a generated map's (one per
   * player), none in a co-op mission (the mission places everyone).
   */
  lobbyMarkers() {
    const st = this.state;
    if (st.mission) return [];
    const players = st.slots.filter((s) => s.type === 'human' || s.type === 'ai').length;
    let field = null;
    if (st.map) {
      const json = this.installed?.get(st.map.hash);
      if (!json) return [];
      field = { key: `map:${st.map.hash}`, width: st.map.width, height: st.map.height, cells: () => JSON.parse(json).spawns };
    } else {
      const o = st.options;
      const G = this.ctx.Game;
      // One spawn per player of the generated map, counted as the server counts them.
      const n = battlefieldSpawns({ players });
      if (this.ctx.previews) {
        // Made off the main thread (renderMap asks for it): no markers until it is ready.
        const got = this.ctx.previews.get(this.generatedRequest());
        if (!got) return [];
        field = { key: `gen:${previewKey(this.generatedRequest())}`, width: o.mapSize, height: o.mapSize, cells: () => got.spawns };
      } else {
        if (!G?.generated_map_styled) return [];
        // The style shapes the map (the biome only paints it).
        field = { key: `gen:${o.seed}/${o.mapSize}/${n}/${o.mapStyle}`, width: o.mapSize, height: o.mapSize, cells: () => JSON.parse(G.generated_map_styled(o.seed, o.mapSize, n, o.mapStyle, 'temperate')).spawns };
      }
    }
    if (this.spawnCells?.key !== field.key) {
      let cells = [];
      try {
        const got = field.cells();
        cells = Array.isArray(got) ? got : [];
      } catch (err) {
        console.error('Spawn positions unavailable:', err);
      }
      this.spawnCells = { key: field.key, cells };
    }
    const lobbyState = {
      players: st.slots.map((s) => (s.type === 'human' || s.type === 'ai' ? s : { type: 'closed' })),
      separateTeamSpawns: st.options.separateTeamSpawns,
      mapSource: st.map ? 'file' : 'random',
    };
    return spawnMarkers(this.spawnCells.cells, field.width, field.height, lobbyState);
  }

  /** The lobby's generated map as a js/mappreview.js request. */
  generatedRequest() {
    const o = this.state.options;
    const players = generatedMapPlayers(this.state.slots.filter((s) => s.type === 'human' || s.type === 'ai').length);
    return { seed: o.seed, size: o.mapSize, players, style: o.mapStyle, biome: o.biome };
  }

  /**
   * Make the lobby's generated map off the main thread and render the lobby
   * again once it is ready, unless the lobby moved on (latest wins).
   */
  awaitPreview(req) {
    const key = previewKey(req);
    this.ctx.previews.request(req).then(
      () => {
        if (this.slotBox && !this.state.map && !this.state.mission && previewKey(this.generatedRequest()) === key) this.renderLobby();
      },
      (err) => {
        if (err instanceof StalePreview) return;
        console.error('Map preview failed:', err);
        this.previewFailed = key;
        if (this.slotBox) this.renderLobby();
      },
    );
  }

  /** Whether this member can pick spawns now: a player or the host, in a skirmish lobby that is not a resumed save, with the map at hand. */
  spawnsEnabled() {
    const st = this.state;
    return !st.resume && !st.mission && this.mapReady() && (this.mySlot() >= 0 || this.isHost) && (this.markerList?.length ?? 0) > 0;
  }

  /** The start markers over the preview (js/spawnpick.js); a click sends the pick to the server, which checks it. */
  renderSpawnLayer(layer, refocus = -1) {
    this.spawnLayer?.destroy();
    this.spawnLayer = new SpawnMarkers(layer, { lens: this.lens, onPick: ({ slot, spawn }) => this.send({ t: 'slot', slot, spawn }) });
    const st = this.state;
    const markers = this.markerList ?? [];
    this.spawnLayer.render(markers, {
      slots: st.slots,
      you: this.mySlot(),
      host: this.isHost && !st.resume,
      colors: this.ctx.colors,
      nameOf: (k) => (st.slots[k].type === 'human' ? st.slots[k].name : aiName(st.slots[k])),
      enabled: this.spawnsEnabled(),
    });
    if (refocus >= 0) this.spawnLayer.buttons[Math.min(refocus, this.spawnLayer.buttons.length - 1)]?.focus();
    // The lens draws the map's actors of player k (the k-th slot that plays) in that player's colour.
    this.lens?.setColors?.(st.slots.filter((s) => s.type === 'human' || s.type === 'ai').map((s) => this.ctx.colors?.[s.color] ?? null));
  }

  /** Draw an RGBA-per-cell preview of `width` cells per row. */
  drawPreview(canvas, getPixels, width) {
    try {
      const px = getPixels();
      const height = px.length / 4 / width;
      if (!Number.isInteger(height) || height <= 0) throw new Error(`unexpected preview size ${px.length}`);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), width, height), 0, 0);
    } catch (err) {
      console.error('Map preview failed:', err);
    }
  }

  mapReady() {
    const map = this.state.map;
    return !map || this.installed.has(map.hash);
  }

  toggleReady() {
    const me = this.state.slots[this.mySlot()];
    if (!me) return;
    this.send({ t: 'ready', ready: !me.ready, mapHash: this.state.map ? this.state.map.hash : null });
  }

  /**
   * A chat or system line. In the lobby its sound follows OpenRA's LobbyLogic
   * (`sound`: 'chat' ChatLine, 'option' LobbyOptionChanged for system lines,
   * 'left' PlayerLeft); in a game every line plays ChatLine (gameLine).
   */
  chatLine(name, textValue, system = false, team = false, sound = name ? 'chat' : 'option') {
    if (this.inGame) {
      this.gameLine(name ? `${team ? '[Team] ' : ''}${name}: ${textValue}` : textValue);
      return;
    }
    if (sound === 'chat') this.ctx.sounds?.chatLine();
    else this.ctx.sounds?.lobby(sound);
    if (!this.chatLog) return;
    const line = el('div', system ? 'online-chat-line online-chat-system' : 'online-chat-line');
    if (name) line.append(el('strong', null, `${name}: `));
    line.append(document.createTextNode(textValue));
    this.chatLog.append(line);
    while (this.chatLog.childElementCount > CHAT_LINES) this.chatLog.firstElementChild.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /** The community map list and the host's own maps, for the map picker. */
  async loadServerMaps() {
    await this.loadMapLists();
    if (this.state && this.slotBox) this.renderLobby();
  }

  /** The host's own maps and the community maps (the host dialog's map picker and the lobby's). */
  async loadMapLists() {
    try {
      this.libraryMaps = await this.library.list();
    } catch (err) {
      console.warn('Map library unavailable:', err?.message ?? err);
    }
    try {
      const maps = await api.maps();
      this.serverMaps = Array.isArray(maps) ? maps : [];
    } catch (err) {
      console.warn('Map list unavailable:', err.message);
    }
  }

  // ---- Maps ------------------------------------------------------------------------

  /**
   * Validate map text with the protocol package and the engine. Returns
   * { canonical, hash, modded, name } or throws with a readable message.
   */
  async checkMap(textValue) {
    // An older format version is upgraded first (protocol mapversions.js); the
    // hash is the upgraded map's, like the server's, so every member gets the same map.
    // `ctx.mapVersions`: the format version registry (tests; the protocol's by default).
    const r = parseMap(textValue, { versions: this.ctx.mapVersions });
    // What is wrong with a map is told as it is (a ProtocolError), not as an unexpected error.
    if (!r.ok) throw new ProtocolError(r.compat ? r.compat.message : `Invalid map: ${r.errors.slice(0, 3).join('; ')}`, 'invalid');
    const engine = JSON.parse(this.ctx.Game.validate_map(r.canonical));
    if (!engine.ok) {
      const why = engine.errors.slice(0, 3).join('; ');
      throw new ProtocolError(r.upgrade ? `${incompatibleMapMessage(r.upgrade.from, r.writtenBy, this.ctx.mapVersions)} (${why})` : `Invalid map: ${why}`, 'invalid');
    }
    const hash = await mapHash(r.map);
    if (engine.hash !== hash) throw new Error('Map hash mismatch between the game and the protocol.');
    // Modded is decided from the content, never from what the server claims.
    return { canonical: r.canonical, hash, modded: r.modded || engine.modded, name: r.map.name, upgrade: r.upgrade };
  }

  setMapStatus(hash, textValue, ok = true) {
    this.mapStatus = { hash, text: textValue, ok };
    if (this.state && this.slotBox) this.renderLobby();
  }

  /** Tell the server whether this member has the lobby map with `hash`. */
  reportMap(hash, state) {
    if (this.state?.map?.hash === hash) this.send({ t: 'mapstate', hash, state });
  }

  /**
   * The lobby's map changed. A map in this browser's library (checked again
   * by the engine) is ready at once; otherwise the player is asked first.
   */
  async ensureMap(ref) {
    this.mapOffer = null;
    if (!ref) return this.setMapStatus(null, '');
    const current = () => this.state && this.state.map && this.state.map.hash === ref.hash;
    if (!this.installed.has(ref.hash)) {
      try {
        const entry = await this.library.get(ref.hash);
        if (entry) {
          const map = await this.checkMap(entry.json);
          if (map.hash === ref.hash) {
            this.installed.set(map.hash, map.canonical);
            this.library.touch(map.hash).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Map library entry unusable:', err?.message ?? err);
      }
    }
    if (!current()) return undefined;
    if (this.installed.has(ref.hash)) {
      this.setMapStatus(ref.hash, 'Map installed.');
      if (!this.isHost) this.reportMap(ref.hash, 'installed');
      return undefined;
    }
    this.mapOffer = { hash: ref.hash, declined: false, busy: false };
    // The host picked this community map: it installs without asking.
    if (this.isHost) return this.installLobbyMap();
    this.setMapStatus(ref.hash, 'You do not have this map yet.', false);
    return undefined;
  }

  /** Install: download the lobby map from the session, check it, keep it, report it. */
  async installLobbyMap() {
    const ref = this.state?.map;
    const offer = this.mapOffer;
    if (!ref || !offer || offer.hash !== ref.hash || offer.busy) return;
    const current = () => this.state && this.state.map && this.state.map.hash === ref.hash;
    offer.busy = true;
    this.setMapStatus(ref.hash, 'Downloading the map...');
    try {
      const map = await this.downloadSessionMap(ref);
      if (!current()) return;
      if (!map) {
        offer.busy = false;
        this.declineLobbyMap();
        return;
      }
      this.installed.set(map.hash, map.canonical);
      this.mapOffer = null;
      this.setMapStatus(ref.hash, 'Map installed.');
      this.reportMap(ref.hash, 'installed');
    } catch (err) {
      offer.busy = false;
      if (current()) this.setMapStatus(ref.hash, messageOf(err), false);
    }
  }

  /** Decline: this player stays unready, and the host sees it. */
  declineLobbyMap() {
    const ref = this.state?.map;
    if (!ref || !this.mapOffer || this.mapOffer.hash !== ref.hash) return;
    this.mapOffer.declined = true;
    this.reportMap(ref.hash, 'declined');
    this.setMapStatus(ref.hash, 'You declined the map, so you cannot be ready. Install it to play.', false);
  }

  /**
   * The session's map with `ref.hash`, downloaded with this member's key,
   * checked like any map (protocol and engine), pinned to the hash, accepted
   * by the player when modded, and kept in the library. Returns checkMap's
   * result, or null when the player declined the modded map.
   */
  async downloadSessionMap(ref) {
    if (!this.member || !this.state?.session) throw new Error('Not connected to a session.');
    const textValue = await api.sessionMap(this.state.session.id, this.member, ref.hash);
    const map = await this.checkMap(textValue);
    if (map.hash !== ref.hash) throw new Error('The downloaded map does not match the lobby (hash mismatch).');
    if (map.modded && !(await confirmModdedMap(map.name, this.ctx.describeRules?.(map.canonical) ?? []))) return null;
    await this.library.add(map.canonical, { source: 'lobby', expectHash: ref.hash }).catch((err) => console.warn('Map library:', err?.message ?? err));
    return map;
  }

  /** Host: pick a map from the picker (`generated`, `community:<id>` or `mine:<hash>`). */
  async pickMap(value) {
    if (value === 'generated') return this.send({ t: 'map', map: null });
    const [kind, key] = value.split(':');
    if (kind === 'mission') {
      const m = coopMission(key);
      if (m) this.send({ t: 'mission', mission: { id: m.id, hash: m.hash, options: Object.fromEntries(Object.entries(m.options).map(([k, o]) => [k, o.default])) } });
      return undefined;
    }
    if (kind === 'community') {
      const m = this.serverMaps.find((x) => x.id === key);
      if (m) this.send({ t: 'map', map: { id: m.id, hash: m.hash, name: m.name, modded: m.modded } });
      return undefined;
    }
    if (kind !== 'mine') return undefined;
    try {
      const entry = await this.library.get(key);
      if (!entry) throw new Error('That map is no longer in your library.');
      await this.shareMap(entry.json);
    } catch (err) {
      this.setError(messageOf(err));
      this.renderLobby();
    }
    return undefined;
  }

  /**
   * Host: share map text with this session only (stored unlisted on the
   * server; docs/security.md). Checked like any map first.
   */
  async shareMap(textValue) {
    const map = await this.checkMap(textValue);
    if (!this.member || !this.state?.session) throw new Error('Not connected to a session.');
    this.setMapStatus(map.hash, 'Sharing the map with the lobby...');
    const res = await api.shareSessionMap(this.state.session.id, this.member, map.canonical);
    if (res.hash !== map.hash) throw new Error('The server computed a different map hash.');
    this.installed.set(map.hash, map.canonical);
    this.library.touch(map.hash).catch(() => {});
    return map;
  }

  /** Host: a .webra-map.json or .oramap file: checked, kept in the library, then shared. */
  async shareFile(file) {
    try {
      let textValue;
      let source = 'file';
      if (isOramapFile(file.name)) {
        if (!this.ctx.importOramap) throw new Error('OpenRA maps cannot be imported here.');
        if (file.size > ORAMAP_MAX_BYTES) throw new Error(`The .oramap file is larger than ${ORAMAP_MAX_BYTES / 1024 / 1024} MiB.`);
        textValue = (await this.ctx.importOramap(new Uint8Array(await file.arrayBuffer()), file.name)).json;
        source = 'oramap';
      } else {
        if (file.size > 1024 * 1024) throw new Error('Map files are limited to 1 MiB.');
        textValue = await file.text();
      }
      const map = await this.checkMap(textValue);
      if (map.modded && !(await confirmModdedMap(map.name, this.ctx.describeRules?.(map.canonical) ?? []))) return;
      await this.library.add(map.canonical, { source });
      this.libraryMaps = await this.library.list();
      // An older file: the lobby gets the upgraded map, the host a notice about the file.
      this.mapNotice = map.upgrade ? { hash: map.hash, text: map.upgrade.message } : null;
      await this.shareMap(map.canonical);
    } catch (err) {
      this.setError(messageOf(err));
    }
  }

  // ---- Game --------------------------------------------------------------------------

  async onStart(m) {
    const st = this.state;
    if (!st || !this.conn) return;
    // A reconnect within this page keeps its game: the start message is the same.
    if (this.driver || this.startingGame) return;
    const me = m.players.find((p) => p.client === st.you);
    const spectator = !me;
    if (spectator && st.role !== 'spectator') {
      this.showBrowser('The game started without you.');
      return;
    }
    // Joining a running game (rejoin, late spectator): the order log follows.
    // A resumed save starts like a rejoin: every client fast-forwards through the saved orders.
    const catchUp = st.rejoin || !st.lobbySeen || !!m.resume;
    // The loading screen shows from here to the game's first frame (js/main.js).
    this.ctx.loading?.begin({ map: !!m.map, mission: !!m.mission });
    let resumeFailed = false;
    this.pendingNet ??= [];
    const conn = this.conn;
    let mapText = null;
    let session;
    this.startingGame = true;
    let missionText = null;
    try {
      if (m.map) {
        mapText = this.installed.get(m.map.hash) ?? (await this.installMapForGame(m.map));
        if (!mapText) throw new Error('The map is not installed.');
      }
      // A co-op mission: this game's own mission file, pinned by the hash everyone agreed on.
      if (m.mission) {
        if (!this.ctx.missionText) throw new Error('This game cannot load missions.');
        missionText = await this.ctx.missionText(m.mission.id, m.mission.hash);
      }
      if (this.conn !== conn) {
        this.ctx.loading?.cancel();
        return;
      }
      // The game, its LockstepDriver and its recorder run where the
      // simulation runs (a worker when possible); `driver` relays to it.
      session = await this.ctx.createGame({
        spec: {
          kind: 'online',
          options: m.options,
          map: mapText,
          mission: m.mission ? { text: missionText, ...m.mission } : null,
          player: me ? me.player : null,
          spectator,
          delay: m.delay,
          tickMs: SPEED_MS[m.options.gameSpeed] ?? SPEED_MS.normal,
          rejoining: catchUp,
          recorder: {
            mode: 'online',
            options: m.options,
            map: mapText,
            mapHash: m.map ? m.map.hash : null,
            mission: m.mission ?? null,
            player: me ? me.player : null,
            engine: this.ctx.version,
            title: st.session.name,
          },
        },
        conn,
        onCaughtUp: () => {
          // Players take their seat back; spectators confirm (the server counts them as catching up until then).
          if (!spectator && resumeFailed) {
            this.gameLine('Your game differs from the saved one, so it cannot continue here. Leave and rejoin to try again.', true);
          } else if (!spectator) this.send({ t: 'resume' });
          else {
            this.send({ t: 'synced' });
            this.gameLine('Caught up: watching live.');
          }
        },
        onCheck: (ok, tick) => {
          if (!ok && m.resume) resumeFailed = true;
          if (!ok) this.gameLine(`After catching up, your game differs from the other players' (tick ${tick}). Leave and rejoin to try again.`, true);
        },
      });
    } catch (err) {
      this.leaveSession();
      this.showBrowser(`Could not start the game: ${err.message ?? err}`);
      this.ctx.loading?.fail(`Could not start the game: ${err.message ?? err}`);
      return;
    } finally {
      this.startingGame = false;
    }
    if (this.conn !== conn || this.driver) {
      // The connection went away (or the game started) while the simulation loaded.
      session.host.dispose();
      // A game that did start has the loading screen; else it goes.
      if (!this.driver) this.ctx.loading?.cancel();
      return;
    }
    const { host, game, driver, recorder } = session;
    this.driver = driver;
    this.simHost = host;
    this.recorder = recorder;
    this.mySeat = me ? me.player : null;
    this.startOptions = m.options;
    // Messages that arrived while the game was being set up.
    const pending = this.pendingNet;
    this.pendingNet = null;
    for (const [type, msg] of pending) this.net(type, msg);
    this.inGame = true;
    this.root.hidden = true;
    // The friends list is not polled during the game; the connection quality goes on (statistics).
    this.unfollowFriends();
    clearInterval(this.inviteTimer);
    this.netq?.beginGame();
    this.buildGameOverlay(m.players, m.options.cheats === true, spectator, hasTeamChat(m.options.players, me ? me.player : null));
    this.ctx.onStartGame({
      host,
      game,
      mission: m.mission ?? null,
      player: me ? me.player : 0,
      driver,
      options: m.options,
      recorder,
      spectator,
      onQuit: () => {
        this.leaveSession();
        driver.stop();
      },
      rematch: this.rematchHandle(),
      save: this.saveHandle(),
      about: this.gameAbout(m, mapText),
      chat: this.chatHandle,
      // Connection quality of this game (js/netquality.js): the HUD's signal bars and warnings, the
      // game menu's and the statistics' Network tabs.
      net: this.netq ? gameNet(this.netq, { players: m.players, options: m.options, colors: this.ctx.colors, you: st.you }) : null,
    });
    if (m.resume) this.gameLine(`Resuming the saved game after ${formatTicks(m.resume.ticks)}: catching up...`, true);
  }

  // ---- Online saves --------------------------------------------------------------------

  /**
   * What this client can do about saving now: 'propose', 'accept' (a
   * proposal waits for this player), 'waiting' (it accepted; others not
   * yet), 'saving' (agreed, at the save point soon) or null (spectators).
   */
  saveAction() {
    if (!this.inGame || this.mySeat === null || this.mySeat === undefined || this.returning) return null;
    const sv = this.saving;
    if (!sv) return 'propose';
    if (sv.state === 'agreed') return 'saving';
    if (sv.waiting.includes(this.state.you)) return 'accept';
    return 'waiting';
  }

  /** The handle main.js uses for the game menu's Save game. */
  saveHandle() {
    const ui = this;
    return {
      action: () => ui.saveAction(),
      run: () => ui.answerSave(true),
      decline: () => ui.answerSave(false),
      subscribe: (fn) => {
        ui.saveSubs.add(fn);
        return () => ui.saveSubs.delete(fn);
      },
    };
  }

  /** Propose or accept saving (`true`), decline or withdraw it (`false`). */
  answerSave(accept) {
    const action = this.saveAction();
    if (accept && action !== 'propose' && action !== 'accept') return false;
    if (!accept && (!this.saving || this.saving.state !== 'open')) return false;
    this.send({ t: 'save', accept });
    return true;
  }

  /** A `save` message: a proposal, the agreed save point, the record, or why it ended. */
  async onSave(m) {
    if (!this.inGame) return;
    if (m.state === 'open') {
      if (!this.saving) this.gameLine(`${m.by === this.state.you ? 'You want' : `${this.clientName(m.by)} wants`} to save the game.`, true);
      this.saving = m;
    } else if (m.state === 'agreed') {
      this.saving = m;
      this.gameLine(`Everyone agreed: saving the game at ${formatTicks(m.tick + 1)}.`, true);
    } else if (m.state === 'cancelled') {
      this.saving = null;
      const why = {
        declined: 'a player declined',
        withdrawn: 'it was withdrawn',
        left: 'a player left',
        expired: 'not everyone answered in time',
        desync: 'the players\' games differ',
        accounts: 'every player must be signed in',
        too_long: 'the game is too long',
        failed: 'the server could not store it',
      }[m.reason] ?? m.reason;
      this.gameLine(`Not saved: ${why}.`, true);
    } else if (m.state === 'saved') {
      this.saving = null;
      await this.storeOnlineSave(m);
    }
    this.renderSaveBar();
    for (const fn of this.saveSubs) fn();
  }

  /** Keep the save file in this browser (players only: spectators cannot resume). */
  async storeOnlineSave(m) {
    if (this.mySeat === null || this.mySeat === undefined || !this.recorder) {
      this.gameLine('The players saved the game.', true);
      return;
    }
    try {
      const textValue = await this.recorder.encodeOnlineSave(m.ticks, m.hash, m.id);
      await this.saves.add(textValue);
      this.gameLine('Game saved. Continue it later with its players: Play online, Resume a saved game.', true);
    } catch (err) {
      this.gameLine(`The game was saved on the server, but this browser could not keep the file: ${messageOf(err)}`, true);
    }
  }

  /** The save line of the in-game overlay: the proposal with Accept and Decline, or whom it waits for. */
  renderSaveBar() {
    const bar = this.saveBar;
    if (!bar) return;
    bar.textContent = '';
    const sv = this.saving;
    bar.hidden = !sv;
    if (!sv) return;
    if (sv.state === 'agreed') {
      bar.append(el('span', null, 'Saving the game...'));
      return;
    }
    bar.append(el('span', null, `${sv.by === this.state.you ? 'You want' : `${this.clientName(sv.by)} wants`} to save the game.`));
    const action = this.saveAction();
    if (action === 'accept') {
      bar.append(button('Accept', 'online-btn-primary', () => this.answerSave(true)), button('Decline', null, () => this.answerSave(false)));
    } else if (sv.waiting.length) {
      bar.append(el('span', 'online-muted', ` Waiting for ${sv.waiting.map((c) => this.clientName(c)).join(', ')}.`));
    }
    if (sv.by === this.state.you) bar.append(button('Withdraw', null, () => this.answerSave(false)));
  }

  /**
   * What the game menu's Game info shows of this game (js/gameinfo.js): the
   * map (its lobby details and file), the countries as the lobby showed them
   * (a random pick stays "Random" for opponents; null after joining a running
   * game, which saw no lobby) and the spectators now.
   */
  gameAbout(m, mapText) {
    const st = this.state;
    const ui = this;
    return {
      map: m.map ?? null,
      mapText: mapText ?? null,
      lobbyFactions: st.lobbySeen ? st.slots.filter((s) => s.type === 'human' || s.type === 'ai').map((s) => s.faction) : null,
      spectators: () => (ui.state?.spectators ?? []).map((x) => x.name),
    };
  }

  // ---- Rematch ------------------------------------------------------------------------

  /**
   * What this client can do about a rematch now: 'propose' (the host, none
   * open), 'accept' (an open proposal waits for this player), 'waiting' (it
   * accepted or proposed; others have not yet) or null (spectators, no game).
   */
  rematchAction() {
    const st = this.state;
    if (!this.inGame || !st || this.returning) return null;
    const r = this.rematch;
    if (!r) return this.isHost ? 'propose' : null;
    if (r.waiting.includes(st.you)) return 'accept';
    if (r.accepted.includes(st.you) || r.by === st.you) return 'waiting';
    return null;
  }

  /** The handle main.js uses in the end of game dialog, the statistics screen and the game menu. */
  rematchHandle() {
    const ui = this;
    return {
      action: () => ui.rematchAction(),
      /** Button text for the current action. */
      label: () => ({ propose: 'Rematch', accept: 'Accept rematch', waiting: 'Rematch proposed' })[ui.rematchAction()] ?? 'Rematch',
      /** What the confirmation says. */
      text: () =>
        ui.rematchAction() === 'accept'
          ? 'Play again with the same settings? Once every player accepts, everyone goes back to this lobby and the host starts the next game.'
          : 'Propose playing again with the same settings? Once every player accepts, everyone goes back to this lobby and you start the next game. This game goes on until then.',
      run: () => ui.answerRematch(true),
      decline: () => ui.answerRematch(false),
      subscribe: (fn) => {
        ui.rematchSubs.add(fn);
        return () => ui.rematchSubs.delete(fn);
      },
      /** Set by main.js: leave the finished game for the lobby (reloads the page without asking). */
      set onLobby(fn) {
        ui.onLobbyReturn = fn;
      },
    };
  }

  /** Propose or accept (`true`), decline or withdraw (`false`). */
  answerRematch(accept) {
    const action = this.rematchAction();
    if (accept && action !== 'propose' && action !== 'accept') return;
    if (!accept && !this.rematch) return;
    this.send({ t: 'rematch', accept });
  }

  /** Who a client is, for rematch lines (players from the start message, the lobby's spectators). */
  clientName(client) {
    const p = this.startPlayers?.find((x) => x.client === client);
    if (p) return p.name;
    const sp = this.state?.spectators.find((x) => x.client === client);
    return sp ? sp.name : 'The host';
  }

  /** A `rematch` message: an open proposal, its end, or the session back in its lobby. */
  onRematch(m) {
    if (!this.inGame) return;
    if (m.state === 'open') {
      if (!this.rematch) this.gameLine(`${m.by === this.state.you ? 'You propose' : `${this.clientName(m.by)} proposes`} a rematch with the same settings.`, true);
      this.rematch = m;
    } else if (m.state === 'cancelled') {
      this.rematch = null;
      const why = { declined: 'a player declined', expired: 'not everyone answered in time', left: 'the host left', withdrawn: 'the host withdrew it' }[m.reason] ?? m.reason;
      this.gameLine(`No rematch: ${why}.`, true);
    } else if (m.state === 'lobby') {
      this.rematch = null;
      this.gameLine('Everyone accepted: back to the lobby.', true);
      this.returnToLobby();
    }
    this.renderRematchBar();
    for (const fn of this.rematchSubs) fn();
  }

  /**
   * Leave the finished game for the session's lobby: the page reloads and
   * rejoins with the stored key (the server keeps this member's place).
   * The connection is let go without `leave`, which would give the place up.
   */
  returnToLobby() {
    if (this.returning) return;
    this.returning = true;
    this.reconnecting = false;
    this.conn = null;
    this.driver?.stop();
    const go = this.onLobbyReturn ?? (() => location.reload());
    go();
  }

  /** The rematch line of the in-game overlay: the proposal, Accept and Decline, or whom it waits for. */
  renderRematchBar() {
    const bar = this.rematchBar;
    if (!bar) return;
    bar.textContent = '';
    const r = this.rematch;
    bar.hidden = !r;
    if (!r) return;
    const action = this.rematchAction();
    const by = r.by === this.state.you ? 'You proposed' : `${this.clientName(r.by)} proposes`;
    bar.append(el('span', null, `${by} a rematch with the same settings.`));
    if (action === 'accept') {
      bar.append(button('Accept', 'online-btn-primary', () => this.answerRematch(true)), button('Decline', null, () => this.answerRematch(false)));
    } else if (r.waiting.length) {
      bar.append(el('span', 'online-muted', ` Waiting for ${r.waiting.map((c) => this.clientName(c)).join(', ')}.`));
    }
    if (r.by === this.state.you) bar.append(button('Withdraw', null, () => this.answerRematch(false)));
  }

  /**
   * The game's map when this client does not have it in memory (rejoin after
   * a reload, late spectator): from the library, else from the session.
   */
  async installMapForGame(ref) {
    const entry = await this.library.get(ref.hash).catch(() => null);
    if (entry) {
      const map = await this.checkMap(entry.json);
      if (map.hash === ref.hash) {
        this.installed.set(map.hash, map.canonical);
        return map.canonical;
      }
    }
    const map = await this.downloadSessionMap(ref);
    if (!map) throw new Error('You declined the modded map.');
    this.installed.set(map.hash, map.canonical);
    return map.canonical;
  }

  /**
   * The in-game lines (js/chatlog.js TextLog) and the online game's own bars
   * (waiting for players, save and rematch proposals). js/main.js draws the
   * lines and the chat line with js/chatpanel.js (the chat handle of
   * onStartGame) and puts these bars above them.
   */
  buildGameOverlay(players, cheats = false, spectator = false, teamChat = false) {
    const field2 = document.getElementById('field') || document.body;
    const box = el('div', 'online-game');
    box.id = 'online-game';
    this.textLog = new TextLog();
    this.waitLine = el('div', 'online-game-wait', 'Waiting for players...');
    this.waitLine.hidden = true;
    this.startPlayers = players;
    this.rematchBar = el('div', 'online-game-rematch');
    this.rematchBar.setAttribute('role', 'status');
    this.rematchBar.hidden = true;
    this.saveBar = el('div', 'online-game-rematch online-game-save');
    this.saveBar.setAttribute('role', 'status');
    this.saveBar.hidden = true;
    box.append(this.waitLine, this.rematchBar, this.saveBar);
    field2.append(box);
    const names = players.map((p) => p.name).filter(Boolean);
    this.chatHandle = {
      log: this.textLog,
      send: (textValue, team) => this.send({ t: 'chat', text: textValue, ...(team ? { team: true } : {}) }),
      teamChat,
      spectator,
      names,
      maxLength: CHAT_MAX,
      bars: box,
      mutable: () => this.mutablePeople(),
      // js/main.js tells the chat lines the players' colours and who lost.
      bind: ({ colorOf, defeated }) => Object.assign(this.chatPeople, { colorOf, defeated }),
    };
    const list = names.join(', ');
    this.gameLine(chatIntroLine({ spectator, list, teamChat, touch: touchUi() }));
    if (cheats) this.gameLine('Cheats are enabled in this game: every player can use the debug menu.', true);
    setInterval(() => {
      if (this.driver) this.waitLine.hidden = !(this.driver.stalledMs > 600 && !this.driver.stopped);
    }, 250);
  }

  /** A system line of the game (OpenRA AddSystemLine); `important` lines stay on the overlay. */
  gameLine(textValue, important = false) {
    this.textLog?.system(textValue, { important });
  }

  /** A chat message in a game, with OpenRA UnitOrders' prefix and the sender's colour. */
  gameChat(m) {
    if (!this.textLog) return;
    if (m.from === null) {
      this.textLog.system(m.text, { prefix: m.name });
      return;
    }
    const seat = this.startPlayers?.find((p) => p.client === m.from) ?? null;
    // The replay keeps what was said (OpenRA replays hold the Chat orders), muted or not.
    this.recorder?.noteChat?.(seat ? seat.player : -1, m.name, m.text, m.spectators ? 2 : m.team ? 1 : 0);
    const teams = this.startOptions?.players ?? [];
    const myTeam = this.mySeat === null || this.mySeat === undefined ? 0 : (teams[this.mySeat]?.team ?? 0);
    const prefix = chatPrefix({
      name: m.name,
      team: !!m.team,
      // The server marks the spectators' side (spectators and defeated players).
      spectators: !!m.spectators,
      spectator: !seat,
      dead: !!seat && this.chatPeople.defeated(seat.player),
      ally: !!seat && m.from !== this.state?.you && myTeam > 0 && teams[seat.player]?.team === myTeam,
    });
    this.textLog.chat(m.from, prefix, m.text, seat ? this.chatPeople.colorOf(seat.player) : null);
  }

  /** The other people in the game whose chat can be muted: players and spectators, not bots or this client. */
  mutablePeople() {
    const you = this.state?.you;
    const players = (this.startPlayers ?? []).filter((p) => p.client !== null && p.client !== you).map((p) => ({ client: p.client, name: p.name }));
    const watching = (this.state?.spectators ?? []).filter((s) => s.client !== you).map((s) => ({ client: s.client, name: s.name }));
    return [...players, ...watching];
  }
}

/** Entry point used by main.js. */
export function mountOnline(root, ctx) {
  return new OnlineUI(root, ctx);
}
