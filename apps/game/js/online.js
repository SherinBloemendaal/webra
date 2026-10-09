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

import {
  CHAT_MAX,
  COLOR_COUNT,
  DIFFICULTIES,
  GAME_SPEEDS,
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
  MAP_STYLES,
  BIOMES,
  WEATHER_MODES,
  validName,
} from './protocol.js';
import { api, ApiError, Connection } from './net.js';
import { defaultRegistry } from './registry.js';
import { onlineRefusal } from './account/ui.js';
import { switchInput } from './ui/controls.js';
import { infoTip, describedBy } from './infotip.js';
import { ModePicker } from './modepicker.js';
import { presetOptions } from './modes.js';
import { hotkeys } from './hotkeys.js';
import { CHAT_HOTKEYS, chatMode, completeName, hasTeamChat } from './chatkeys.js';

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
  mapSize: { 64: 'Small', 96: 'Medium', 128: 'Large', 160: 'Huge' },
  mapStyle: { random: 'Random', land: 'Land', rivers: 'Rivers', lakes: 'Lakes', islands: 'Islands' },
  biome: { random: 'Random', temperate: 'Temperate', snow: 'Snow', desert: 'Desert' },
  weather: { full: 'On', cosmetic: 'Cosmetic only', off: 'Off' },
};
// Option rows: key (also the help text key in js/help.js), label, choices.
// The World group holds the climate of the battlefield.
const WORLD_OPTIONS = [
  ['mapStyle', 'Map style', MAP_STYLES.map((v) => [v, LABELS.mapStyle[v]])],
  ['biome', 'Biome', BIOMES.map((v) => [v, LABELS.biome[v]])],
  ['weather', 'Weather', WEATHER_MODES.map((v) => [v, LABELS.weather[v]])],
];
const SELECT_OPTIONS = [
  ['startingCash', 'Starting cash', STARTING_CASH.map((v) => [v, `$${v.toLocaleString('en-US')}`])],
  ['startingUnits', 'Starting units', STARTING_UNITS.map((v) => [v, LABELS.startingUnits[v]])],
  ['techLevel', 'Tech level', TECH_LEVELS.map((v) => [v, LABELS.techLevel[v]])],
  ['gameSpeed', 'Game speed', GAME_SPEEDS.map((v) => [v, LABELS.gameSpeed[v]])],
];
const TOGGLES = [
  ['fog', 'Fog of war'],
  ['explored', 'Explored map'],
  ['buildRadius', 'Build radius'],
  ['redeployableMcv', 'Redeployable MCVs'],
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
  'spectators',
];

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

/** <select> from [value, label] pairs or [groupLabel, pairs] groups. */
function select(choices, value, onChange, grouped = false) {
  const s = el('select', 'online-select');
  const add = (parent, [v, label]) => {
    const o = el('option', null, label);
    o.value = String(v);
    parent.append(o);
  };
  if (grouped) {
    for (const [label, items] of choices) {
      const g = el('optgroup');
      g.label = label;
      items.forEach((c) => add(g, c));
      s.append(g);
    }
  } else {
    choices.forEach((c) => add(s, c));
  }
  s.value = String(value);
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

let uid = 0;

/**
 * A label + control row; with `helpKey`, the option's "?" help (js/help.js).
 * `target` is what the label names (the control, or a compound control's input).
 */
function field(label, control, helpKey = null, target = control) {
  const row = el('div', 'online-field');
  const head = el('span', 'online-field-head');
  const name = el('label', 'online-field-label', label);
  if (!target.id) target.id = `online-ctl-${++uid}`;
  name.htmlFor = target.id;
  head.append(name);
  if (helpKey) head.append(infoTip(helpKey, { label, describes: target }).root);
  row.append(head, control);
  return row;
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

// ---- Modal dialogs -------------------------------------------------------------

/**
 * Show a modal built by `build(body, close)`; resolves with what close() got.
 * Escape and the backdrop cancel (resolve null).
 */
function modal(title, build) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'online-dialog');
    dialog.append(el('h2', 'online-dialog-title', title));
    const body = el('div', 'online-dialog-body');
    dialog.append(body);
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    build(body, close);
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** The modded-map warning; resolves true only when the player accepts. */
export function confirmModdedMap(mapName) {
  return modal('Modded map', (body, close) => {
    body.append(
      el('p', 'online-warning', MODDED_WARNING),
      el('p', 'online-muted', `Map: ${mapName}`),
    );
    const row = el('div', 'online-dialog-actions');
    row.append(button('Decline', null, () => close(false)), button('Accept and install', 'online-btn-danger', () => close(true)));
    body.append(row);
  }).then((v) => v === true);
}

// ---- Online UI -------------------------------------------------------------------

export class OnlineUI {
  /**
   * @param {HTMLElement} root the #online-root element
   * @param {{
   *   Game: any, version: string, colors: number[][], colorNames: string[],
   *   createGame: (o: { spec: object, conn: Connection, onCaughtUp: () => void, onCheck: (ok: boolean, tick: number) => void })
   *     => Promise<{ host: any, game: any, driver: any, recorder: any }>,  the simulation with its LockstepDriver (js/main.js, js/sim)
   *   onStartGame: (start: { host: any, game: any, player: number, driver: any, options: object, recorder: any, spectator: boolean, onQuit: () => void }) => void,
   *   onBack: () => void,
   *   account?: { session: import('./account/session.js').AccountSession, signIn: (reason: string) => Promise<object | null> },
   * }} ctx  account: signed-in players play under their username (protocol 5)
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.name = loadName();
    this.conn = null;
    this.state = null;
    this.installed = new Map();
    this.mapStatus = { hash: null, text: '', ok: true };
    this.serverMaps = [];
    this.refreshTimer = 0;
    this.inGame = false;
    this.root.classList.add('online');
    const rejoin = loadRejoin();
    if (rejoin) this.rejoinAfterReload(rejoin);
    else this.showBrowser();
  }

  /** A reload during an online game: rejoin it with the stored key. */
  async rejoinAfterReload(record) {
    this.root.textContent = '';
    const page = el('div', 'online-page');
    page.append(el('h1', 'online-title', 'Rejoining your game...'), el('p', 'online-muted', 'Reconnecting to the server.'));
    this.root.append(page);
    try {
      await this.connect(record.id, { name: record.name, rejoin: { client: record.client, key: record.key } }, { rejoin: true });
    } catch (err) {
      clearRejoin();
      this.showBrowser(`Could not rejoin the game: ${messageOf(err)}`);
    }
  }

  // ---- Server browser ------------------------------------------------------------

  showBrowser(error = '') {
    this.leaveSession();
    this.root.textContent = '';
    const page = el('div', 'online-page');

    const head = el('header', 'online-head');
    head.append(el('h1', 'online-title', 'Play online'), button('Back to skirmish', null, () => this.back()));

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

    const joinId = el('input', 'online-input online-join-id');
    joinId.placeholder = 'Session ID or invite link';
    joinId.spellcheck = false;
    const invite = inviteId();
    if (invite) joinId.value = invite;
    const joinById = (spectate = false) => {
      const id = (/([0-9a-f]{64})/.exec(joinId.value.trim()) || [])[1];
      if (!id || !SESSION_ID_RE.test(id)) return this.setError('That is not a valid session ID.');
      this.join({ id, name: 'Private session', locked: null }, { spectate });
    };
    joinId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinById();
    });

    const tools = el('div', 'online-tools');
    const user = this.account?.user;
    // Signed in: the lobby name is the username (the server sets it). Otherwise the typed name, when the site allows anonymous play.
    const nameField = user ? field('Playing as', el('span', 'online-account-name', user.username)) : field('Your name', nameInput);
    tools.append(
      nameField,
      button('Host game', 'online-btn-primary', () => this.hostDialog()),
      button('Refresh', null, () => this.refresh()),
    );
    const joinRow = el('div', 'online-tools');
    joinRow.append(
      field('Join by ID', joinId),
      button('Join', null, () => joinById()),
      button('Watch', null, () => joinById(true)),
    );

    const table = el('div', 'online-sessions');
    table.setAttribute('role', 'table');
    this.sessionList = table;
    this.listStatus = el('p', 'online-muted', 'Loading sessions...');

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
    page.append(tools, joinRow, table, this.listStatus);
    this.root.append(page);
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

  async refresh() {
    try {
      const v = await api.version();
      if (v.protocol !== PROTOCOL_VERSION) {
        this.setError('The server uses a newer multiplayer protocol. Reload the page to update.');
      }
      const sessions = await api.sessions();
      if (!this.sessionList?.isConnected) return;
      this.renderSessions(Array.isArray(sessions) ? sessions : []);
    } catch (err) {
      if (this.listStatus) this.listStatus.textContent = messageOf(err);
    }
  }

  renderSessions(sessions) {
    const table = this.sessionList;
    table.textContent = '';
    const head = el('div', 'online-row online-row-head');
    for (const h of ['Session', 'Host', 'Players', 'Map', '']) head.append(el('div', 'online-cell', h));
    head.setAttribute('role', 'row');
    table.append(head);
    for (const s of sessions) {
      const row = el('div', 'online-row');
      row.setAttribute('role', 'row');
      const name = el('div', 'online-cell online-cell-name');
      name.append(el('span', null, String(s.name)));
      if (s.locked) name.append(el('span', 'online-badge', 'PASSWORD'));
      const map = el('div', 'online-cell');
      map.append(el('span', null, s.map ? String(s.map.name) : 'Generated'));
      if (s.map && s.map.modded) map.append(el('span', 'online-badge online-badge-modded', 'MODDED'));
      const same = s.version === this.ctx.version;
      const join = button('Join', 'online-btn-primary', () => this.join(s));
      const watch = button('Watch', null, () => this.join(s, { spectate: true }));
      for (const b of [join, watch]) {
        b.disabled = !same;
        if (!same) b.title = `Needs game version ${s.version}`;
      }
      row.append(el('div', 'online-cell', String(s.host)), el('div', 'online-cell', `${s.players} / ${s.maxPlayers}`), map);
      row.prepend(name);
      const action = el('div', 'online-cell');
      action.append(join, watch);
      row.append(action);
      table.append(row);
    }
    this.listStatus.textContent = sessions.length ? '' : 'No open public sessions. Host one!';
  }

  async hostDialog() {
    const name = this.playerName();
    if (!name) return;
    const input = await modal('Host a game', (body, close) => {
      const title = el('input', 'online-input');
      title.maxLength = SESSION_NAME_MAX;
      title.value = `${name}'s game`;
      const pub = switchInput({ checked: true });
      const pass = el('input', 'online-input');
      pass.type = 'password';
      pass.maxLength = PASSWORD_MAX;
      pass.autocomplete = 'new-password';
      pass.placeholder = 'Optional';
      const max = select(
        Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => [i + MIN_PLAYERS, String(i + MIN_PLAYERS)]),
        4,
      );
      const pubRow = el('label', 'online-toggle');
      pubRow.append(pub, el('span', null, 'List in the server browser'));
      const actions = el('div', 'online-dialog-actions');
      const submit = () =>
        close({ name: title.value, public: pub.checked, password: pass.value, maxPlayers: Number(max.value) });
      actions.append(button('Cancel', null, () => close(null)), button('Create', 'online-btn-primary', submit));
      body.append(field('Session name', title), pubRow, field('Password', pass), field('Max players', max), actions);
      title.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    });
    if (!input) return;
    try {
      const body = { name: input.name, public: input.public, maxPlayers: input.maxPlayers, version: this.ctx.version };
      if (input.password) body.password = input.password;
      const { id, hostKey } = await api.createSession(body);
      await this.connect(id, { name, hostKey });
    } catch (err) {
      this.showProblem(err);
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
      .on('chat', (m) => this.chatLine(m.name, m.text, m.from === null, !!m.team))
      .on('left', (m) => this.chatLine(null, leftText(m, this.inGame), true))
      .on('back', (m) => this.onBack(m))
      .on('error', (m) => this.onServerError(m))
      .on('start', (m) => this.onStart(m))
      // Until the game exists, its network messages wait (onStart replays them).
      .on('frame', (m) => this.net('frame', m))
      .on('log', (m) => this.net('log', m))
      .on('sync', (m) => this.net('sync', m))
      .on('desync', (d) => this.inGame && this.gameLine(`Desync detected at tick ${d.tick}: the game states differ. Results may not match.`, true))
      .on('close', (reason) => this.onClose(reason, conn));
    const welcome = await conn.open({ version: this.ctx.version, ...hello });
    clearInterval(this.refreshTimer);
    this.conn = conn;
    // Protocol 5: the server says which name this member got (the username when signed in).
    const memberName = typeof welcome.name === 'string' ? welcome.name : hello.name;
    if (welcome.key) saveRejoin({ id, client: welcome.you, key: welcome.key, name: memberName });
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
    };
    if (inviteId()) history.replaceState(null, '', location.pathname);
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
    clearRejoin();
    this.reconnecting = false;
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      c.leave();
    }
    this.state = null;
  }

  back() {
    this.leaveSession();
    this.ctx.onBack();
  }

  onServerError(m) {
    const refusal = onlineRefusal(m.code, m.message);
    if (this.inGame) this.gameLine(`Server: ${refusal?.text ?? m.message}`, !!refusal);
    else if (refusal) this.setError(refusal.text, { signIn: refusal.signIn && !this.account?.user });
    else this.setError(m.message);
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

    const head = el('header', 'online-head');
    const title = el('div');
    title.append(el('h1', 'online-title', s.name), el('p', 'online-muted', s.public ? 'Public session' : 'Private session'));
    const invite = button('Copy invite link', null, async () => {
      const link = `${location.origin}${location.pathname}?join=${s.id}`;
      try {
        await navigator.clipboard.writeText(link);
        invite.textContent = 'Copied';
      } catch {
        this.setError(`Invite link: ${link}`);
      }
    });
    head.append(title, invite, button('Leave', null, () => this.showBrowser()));

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
    for (const [label, key] of [['Player', 'playerOnline'], ['Faction', 'faction'], ['Color', 'colorOnline'], ['Team', 'team'], ['', null]]) {
      const c = el('div', 'online-cell', label);
      c.setAttribute('role', 'columnheader');
      if (key) {
        this.columnTips[key] = infoTip(key, { label });
        c.append(this.columnTips[key].root);
      }
      this.slotHead.append(c);
    }
    this.spectatorTip = infoTip('spectators', { label: 'Spectators' });

    const chat = el('section', 'online-panel online-chat');
    this.chatLog = el('div', 'online-chat-log');
    this.chatLog.setAttribute('aria-live', 'polite');
    const chatInput = el('input', 'online-input');
    chatInput.maxLength = CHAT_MAX;
    chatInput.placeholder = 'Say something';
    chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !chatInput.value.trim()) return;
      this.send({ t: 'chat', text: chatInput.value });
      chatInput.value = '';
    });
    chat.append(el('h2', 'online-panel-title', 'Chat'), this.chatLog, chatInput);

    const body = el('div', 'online-lobby-body');
    this.spectatorBox = el('section', 'online-panel online-spectator-box');
    const left = el('div', 'online-col');
    left.append(this.slotBox, this.spectatorBox, this.optionBox);
    const right = el('div', 'online-col');
    right.append(this.mapBox, chat);
    body.append(left, right);

    const bar = el('footer', 'online-bar');
    this.readyBtn = button('Ready', 'online-btn-primary', () => this.toggleReady());
    this.startBtn = button('Start game', 'online-btn-primary', () => this.send({ t: 'start' }));
    this.barStatus = el('span', 'online-muted');
    bar.append(this.barStatus, this.readyBtn, this.startBtn);

    page.append(head, this.banner, body, bar);
    this.root.append(page);
  }

  onLobby(m) {
    if (!this.state) return;
    const mapChanged = (this.state.map ? this.state.map.hash : null) !== (m.map ? m.map.hash : null);
    Object.assign(this.state, {
      slots: m.slots,
      options: m.options,
      map: m.map,
      hostId: m.hostId,
      spectators: m.spectators,
      maxSpectators: m.maxSpectators,
      lobbySeen: true,
    });
    this.state.role = m.spectators.some((x) => x.client === this.state.you) ? 'spectator' : 'player';
    if (mapChanged) this.ensureMap(m.map);
    this.renderLobby();
  }

  mySlot() {
    return this.state.slots.findIndex((s) => s.type === 'human' && s.client === this.state.you);
  }

  renderLobby() {
    if (!this.slotBox) return;
    this.renderSlots();
    this.renderOptions();
    this.renderMap();
    const me = this.state.slots[this.mySlot()];
    const mapReady = this.mapReady();
    this.renderSpectators();
    this.readyBtn.hidden = this.isHost || !me;
    this.startBtn.hidden = !this.isHost;
    this.readyBtn.textContent = me && me.ready ? 'Not ready' : 'Ready';
    this.readyBtn.disabled = !mapReady && !(me && me.ready);
    const waiting = this.state.slots.filter((s) => s.type === 'human' && s.client !== this.state.hostId && !s.ready).length;
    this.startBtn.disabled = waiting > 0 || !mapReady;
    this.barStatus.textContent = !mapReady
      ? this.mapStatus.text || 'Waiting for the map.'
      : waiting > 0
        ? `Waiting for ${waiting} player${waiting === 1 ? '' : 's'} to be ready.`
        : this.isHost
          ? 'Everyone is ready.'
          : 'Waiting for the host to start.';
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
      list.append(row);
    }
    if (!st.spectators.length) list.append(el('span', 'online-muted', 'Nobody is watching.'));
    box.append(list);
    const controls = el('div', 'online-tools');
    if (this.isHost) {
      const places = select(
        Array.from({ length: MAX_SPECTATORS + 1 }, (_, i) => [i, String(i)]).filter(([i]) => i >= st.spectators.length),
        st.maxSpectators,
        (v) => this.send({ t: 'spectators', max: Number(v) }),
      );
      describedBy(places, this.spectatorTip);
      controls.append(field('Spectator places', places));
    }
    const watching = st.role === 'spectator';
    const toggle = button(watching ? 'Play' : 'Spectate', null, () => this.send({ t: 'spectate', on: !watching }));
    toggle.disabled = watching ? !st.slots.some((x) => x.type === 'open') : st.spectators.length >= st.maxSpectators;
    controls.append(toggle);
    box.append(controls);
  }

  renderSlots() {
    const box = this.slotBox;
    box.textContent = '';
    box.append(this.slotHead);
    const host = this.isHost;
    const mine = this.mySlot();
    this.state.slots.forEach((slot, i) => {
      const row = el('div', `online-slot online-slot-${slot.type}`);
      row.setAttribute('role', 'row');
      const who = el('div', 'online-cell online-cell-player');
      who.append(el('span', 'online-badge', `P${i + 1}`));
      const editable = (slot.type === 'human' && i === mine) || (slot.type === 'ai' && host);
      if (slot.type === 'human' || slot.type === 'ai') {
        row.style.setProperty('--slot-color', rgbCss(this.ctx.colors[slot.color] || [1, 1, 1]));
        if (slot.type === 'human') {
          who.append(el('span', 'online-player-name', slot.name));
          if (slot.account) who.append(accountMark());
          if (slot.client === this.state.hostId) who.append(el('span', 'online-badge', 'HOST'));
          if (i === mine) who.append(el('span', 'online-badge online-badge-you', 'YOU'));
        } else {
          who.append(el('span', 'online-player-name', 'Computer'));
          const diff = select(DIFFICULTIES.map((d) => [d, LABELS.difficulty[d]]), slot.difficulty, (v) =>
            this.send({ t: 'slot', slot: i, difficulty: v }),
          );
          diff.disabled = !host;
          diff.setAttribute('aria-label', `Player ${i + 1} difficulty`);
          describedBy(diff, this.columnTips.playerOnline);
          who.append(diff);
        }
        const faction = select(FACTION_GROUPS, slot.faction, (v) => this.send({ t: 'slot', slot: i, faction: v }), true);
        faction.disabled = !editable;
        faction.setAttribute('aria-label', `Player ${i + 1} faction`);
        describedBy(faction, this.columnTips.faction);
        const color = select(
          Array.from({ length: COLOR_COUNT }, (_, c) => [c, this.ctx.colorNames[c] || `Color ${c + 1}`]),
          slot.color,
          (v) => this.send({ t: 'slot', slot: i, color: Number(v) }),
        );
        color.disabled = !editable;
        color.setAttribute('aria-label', `Player ${i + 1} color`);
        describedBy(color, this.columnTips.colorOnline);
        const team = select(
          Array.from({ length: TEAM_MAX + 1 }, (_, t) => [t, t === 0 ? 'None' : `Team ${t}`]),
          slot.team,
          (v) => this.send({ t: 'slot', slot: i, team: Number(v) }),
        );
        team.disabled = !editable;
        team.setAttribute('aria-label', `Player ${i + 1} team`);
        describedBy(team, this.columnTips.team);
        const cells = [faction, color, team].map((c) => {
          const cell = el('div', 'online-cell');
          cell.append(c);
          return cell;
        });
        row.append(who, ...cells);
      } else {
        who.append(el('span', 'online-muted', slot.type === 'open' ? 'Open' : 'Closed'));
        row.append(who, el('div', 'online-cell'), el('div', 'online-cell'), el('div', 'online-cell'));
      }
      const action = el('div', 'online-cell online-cell-action');
      if (slot.type === 'human' && slot.client !== this.state.hostId) {
        action.append(el('span', slot.ready ? 'online-ready' : 'online-muted', slot.ready ? 'Ready' : 'Not ready'));
      }
      if (host && i !== mine) {
        const current = slot.type === 'human' ? 'human' : slot.type;
        const choices = [['open', 'Open'], ['closed', 'Closed'], ['ai', 'Computer']];
        if (slot.type === 'human') choices.unshift(['human', 'Player (kick)']);
        const type = select(choices, current, (v) => {
          if (v !== 'human') this.send({ t: 'slot', slot: i, type: v });
        });
        type.setAttribute('aria-label', `Player ${i + 1} slot type`);
        describedBy(type, this.columnTips.playerOnline);
        action.append(type);
      }
      if (slot.type === 'open') action.append(button('Take', null, () => this.send({ t: 'slot', slot: i })));
      row.append(action);
      box.append(row);
    });
  }

  /** Send the options with `patch` applied (host only; the server checks). */
  sendOptions(patch) {
    this.send({ t: 'options', options: { ...this.state.options, ...patch } });
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
      const s = select(choices, choices[0][0], (v) => edit(key, numeric ? Number(v) : v));
      this.optionControls[key] = s;
      const row = field(label, s, key);
      this.optionRows[key] = row;
      return row;
    };
    this.optionRows = {};
    const world = el('fieldset', 'online-world');
    world.append(el('legend', 'online-world-title', 'World'), ...WORLD_OPTIONS.map(selectRow));
    const grid = el('div', 'online-option-grid');
    grid.append(...SELECT_OPTIONS.map(selectRow));
    const toggles = el('div', 'online-toggles');
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
    const host = this.isHost;
    for (const [key] of [...WORLD_OPTIONS, ...SELECT_OPTIONS]) {
      this.optionControls[key].value = String(o[key]);
      this.optionControls[key].disabled = !host;
    }
    for (const [key] of TOGGLES) {
      this.optionControls[key].checked = o[key];
      this.optionControls[key].disabled = !host;
    }
    // A map file brings its own layout and biome; the weather still applies.
    this.optionRows.mapStyle.hidden = !!this.state.map;
    this.optionRows.biome.hidden = !!this.state.map;
    this.cheatsWarning.hidden = !o.cheats;
    this.modePicker.render(o, { editable: host });
  }

  renderMap() {
    const box = this.mapBox;
    const st = this.state;
    box.textContent = '';
    box.append(el('h2', 'online-panel-title', 'Battlefield'));
    const canvas = el('canvas', 'online-preview');
    canvas.setAttribute('role', 'img');
    const caption = el('p', 'online-caption');
    const players = Math.max(MIN_PLAYERS, st.slots.filter((s) => s.type === 'human' || s.type === 'ai').length);
    if (st.map) {
      caption.append(el('span', null, `${st.map.name} (${st.map.players} players)`));
      if (st.map.modded) caption.append(el('span', 'online-badge online-badge-modded', 'MODDED'));
      const json = this.installed.get(st.map.hash);
      if (json) this.drawPreview(canvas, () => this.ctx.Game.map_file_preview(json), JSON.parse(json).width);
    } else {
      const o = st.options;
      // What a random style or biome comes out as for this seed (every peer computes the same).
      const G = this.ctx.Game;
      const look = G.resolved_style ? `, ${LABELS.mapStyle[G.resolved_style(o.seed, o.mapStyle)]}, ${LABELS.biome[G.resolved_biome(o.seed, o.biome)]}` : '';
      caption.textContent = `Generated, ${LABELS.mapSize[o.mapSize]} ${o.mapSize} x ${o.mapSize}${look}, seed ${o.seed}`;
      this.drawPreview(canvas, () => G.map_preview_styled(o.seed, o.mapSize, players, o.mapStyle, o.biome), o.mapSize);
    }
    canvas.setAttribute('aria-label', `Map preview: ${caption.textContent}`);
    const status = el('p', this.mapStatus.ok ? 'online-muted' : 'online-warning', this.mapStatus.text);
    box.append(canvas, caption, status);
    if (!this.isHost) return;

    // Host controls: source, generated map settings, upload.
    const choices = [['generated', 'Generated map'], ...this.serverMaps.map((m) => [m.id, `${m.name} (${m.players}p${m.modded ? ', modded' : ''})`])];
    if (st.map && !this.serverMaps.some((m) => m.id === st.map.id)) choices.push([st.map.id, st.map.name]);
    const source = select(choices, st.map ? st.map.id : 'generated', (v) => {
      if (v === 'generated') return this.send({ t: 'map', map: null });
      const m = this.serverMaps.find((x) => x.id === v);
      if (m) this.send({ t: 'map', map: { id: m.id, hash: m.hash, name: m.name, modded: m.modded } });
    });
    const controls = el('div', 'online-option-grid');
    controls.append(field('Map', source, 'onlineMap'));
    if (!st.map) {
      const size = select(MAP_SIZES.map((v) => [v, `${LABELS.mapSize[v]} (${v} x ${v})`]), st.options.mapSize, (v) =>
        this.send({ t: 'options', options: { ...st.options, mapSize: Number(v) } }),
      );
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
      seedRow.append(seed, button('New seed', null, () => this.send({ t: 'options', options: { ...st.options, seed: randomSeed() } })));
      controls.append(field('Map size', size, 'mapSize'), field('Seed', seedRow, 'seed', seed));
    }
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) this.uploadMap(file.files[0]);
      file.value = '';
    });
    const upload = button('Upload map file', null, () => file.click());
    box.append(controls, upload, file);
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

  chatLine(name, textValue, system = false, team = false) {
    if (this.inGame) {
      this.gameLine(name ? `${team ? '[Team] ' : ''}${name}: ${textValue}` : textValue);
      return;
    }
    if (!this.chatLog) return;
    const line = el('div', system ? 'online-chat-line online-chat-system' : 'online-chat-line');
    if (name) line.append(el('strong', null, `${name}: `));
    line.append(document.createTextNode(textValue));
    this.chatLog.append(line);
    while (this.chatLog.childElementCount > CHAT_LINES) this.chatLog.firstElementChild.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  async loadServerMaps() {
    try {
      const maps = await api.maps();
      this.serverMaps = Array.isArray(maps) ? maps : [];
      if (this.state) this.renderLobby();
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
    const r = parseMap(textValue);
    if (!r.ok) throw new Error(`Invalid map: ${r.errors.slice(0, 3).join('; ')}`);
    const engine = JSON.parse(this.ctx.Game.validate_map(r.canonical));
    if (!engine.ok) throw new Error(`Invalid map: ${engine.errors.slice(0, 3).join('; ')}`);
    const hash = await mapHash(r.map);
    if (engine.hash !== hash) throw new Error('Map hash mismatch between the game and the protocol.');
    // Modded is decided from the content, never from what the server claims.
    return { canonical: r.canonical, hash, modded: r.modded || engine.modded, name: r.map.name };
  }

  setMapStatus(hash, textValue, ok = true) {
    this.mapStatus = { hash, text: textValue, ok };
    if (this.state) this.renderLobby();
  }

  /** Download, verify and (after the modded warning) install the lobby map. */
  async ensureMap(ref) {
    if (!ref) return this.setMapStatus(null, '');
    if (this.installed.has(ref.hash)) return this.setMapStatus(ref.hash, 'Map installed.');
    this.setMapStatus(ref.hash, 'Downloading the map...');
    const current = () => this.state && this.state.map && this.state.map.hash === ref.hash;
    try {
      const textValue = await api.mapText(ref.id);
      const map = await this.checkMap(textValue);
      if (map.hash !== ref.hash) throw new Error('The downloaded map does not match the lobby (hash mismatch).');
      if (!current()) return undefined;
      if (map.modded && !(await confirmModdedMap(map.name))) {
        if (current()) this.setMapStatus(ref.hash, 'You declined the modded map, so you cannot be ready.', false);
        return undefined;
      }
      this.installed.set(map.hash, map.canonical);
      if (current()) this.setMapStatus(ref.hash, 'Map installed.');
    } catch (err) {
      if (current()) this.setMapStatus(ref.hash, messageOf(err), false);
    }
    return undefined;
  }

  async uploadMap(file) {
    try {
      if (file.size > 1024 * 1024) throw new Error('Map files are limited to 1 MiB.');
      const map = await this.checkMap(await file.text());
      if (map.modded && !(await confirmModdedMap(map.name))) return;
      const res = await api.uploadMap(map.canonical);
      if (res.hash !== map.hash) throw new Error('The server computed a different map hash.');
      this.installed.set(map.hash, map.canonical);
      await this.loadServerMaps();
      this.send({ t: 'map', map: { id: res.id, hash: res.hash, name: map.name, modded: map.modded } });
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
    const catchUp = st.rejoin || !st.lobbySeen;
    this.pendingNet ??= [];
    const conn = this.conn;
    let mapText = null;
    let session;
    this.startingGame = true;
    try {
      if (m.map) {
        mapText = this.installed.get(m.map.hash) ?? (await this.installMapForGame(m.map));
        if (!mapText) throw new Error('The map is not installed.');
      }
      if (this.conn !== conn) return;
      // The game, its LockstepDriver and its recorder run where the
      // simulation runs (a worker when possible); `driver` relays to it.
      session = await this.ctx.createGame({
        spec: {
          kind: 'online',
          options: m.options,
          map: mapText,
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
            player: me ? me.player : null,
            engine: this.ctx.version,
            title: st.session.name,
          },
        },
        conn,
        onCaughtUp: () => {
          // Players take their seat back; spectators confirm (the server counts them as catching up until then).
          if (!spectator) this.send({ t: 'resume' });
          else {
            this.send({ t: 'synced' });
            this.gameLine('Caught up: watching live.');
          }
        },
        onCheck: (ok, tick) => {
          if (!ok) this.gameLine(`After catching up, your game differs from the other players' (tick ${tick}). Leave and rejoin to try again.`, true);
        },
      });
    } catch (err) {
      this.leaveSession();
      this.showBrowser(`Could not start the game: ${err.message ?? err}`);
      return;
    } finally {
      this.startingGame = false;
    }
    if (this.conn !== conn || this.driver) {
      // The connection went away (or the game started) while the simulation loaded.
      session.host.dispose();
      return;
    }
    const { host, game, driver, recorder } = session;
    this.driver = driver;
    // Messages that arrived while the game was being set up.
    const pending = this.pendingNet;
    this.pendingNet = null;
    for (const [type, msg] of pending) this.net(type, msg);
    this.inGame = true;
    this.root.hidden = true;
    this.buildGameOverlay(m.players, m.options.cheats === true, spectator, hasTeamChat(m.options.players, me ? me.player : null));
    this.ctx.onStartGame({
      host,
      game,
      player: me ? me.player : 0,
      driver,
      options: m.options,
      recorder,
      spectator,
      onQuit: () => {
        this.leaveSession();
        driver.stop();
      },
    });
  }

  /** The game's map when this client does not have it yet (rejoin after a reload, late spectator). */
  async installMapForGame(ref) {
    const textValue = await api.mapText(ref.id);
    const map = await this.checkMap(textValue);
    if (map.hash !== ref.hash) throw new Error('The downloaded map does not match the game (hash mismatch).');
    if (map.modded && !(await confirmModdedMap(map.name))) throw new Error('You declined the modded map.');
    this.installed.set(map.hash, map.canonical);
    return map.canonical;
  }

  /**
   * The in-game log and chat line. OpenRA's chat keys (js/chatkeys.js): Enter
   * opens team chat (all chat without a team mate), Shift+Enter all chat;
   * in the line Shift+Tab switches between them, Tab completes a name, Enter
   * sends, Esc closes.
   */
  buildGameOverlay(players, cheats = false, spectator = false, teamChat = false) {
    const field2 = document.getElementById('field') || document.body;
    const box = el('div', 'online-game');
    box.id = 'online-game';
    this.gameLog = el('div', 'online-game-log');
    this.gameLog.setAttribute('aria-live', 'polite');
    this.waitLine = el('div', 'online-game-wait', 'Waiting for players...');
    this.waitLine.hidden = true;
    const chatInput = el('input', 'online-input online-game-chat');
    chatInput.maxLength = CHAT_MAX;
    chatInput.hidden = true;
    const names = players.map((p) => p.name).filter(Boolean);
    let mode = 'all';
    let completion = null;
    const setMode = (m) => {
      mode = m;
      chatInput.placeholder = `${mode === 'team' ? (spectator ? 'Spectators' : 'Team') : 'All'}: Enter sends, Shift+Tab switches, Esc closes`;
      chatInput.setAttribute('aria-label', mode === 'team' ? 'Team chat' : 'Chat to all');
    };
    const close = () => {
      chatInput.value = '';
      chatInput.hidden = true;
      chatInput.blur();
    };
    const open = (wantTeam) => {
      setMode(chatMode(wantTeam, teamChat));
      chatInput.hidden = false;
      chatInput.focus();
    };
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        close();
      } else if (e.key === 'Enter') {
        if (chatInput.value.trim()) this.send({ t: 'chat', text: chatInput.value, ...(mode === 'team' ? { team: true } : {}) });
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          // OpenRA ToggleChatMode: only when there is a team to talk to.
          if (teamChat) setMode(mode === 'team' ? 'all' : 'team');
          return;
        }
        // OpenRA Autocomplete: player names.
        const r = completeName(chatInput.value, names, completion);
        if (r) {
          completion = r.state;
          chatInput.value = r.text;
        }
        return;
      }
      completion = null;
    });
    // Enter and Shift+Enter open the chat line (not while a button has focus:
    // Enter presses it); the chat line's own keys are listed in the Controls
    // page and fixed, like OpenRA's Readonly chat-input keys.
    const handlers = { openTeamChat: () => open(true), openGeneralChat: () => open(false) };
    for (const h of CHAT_HOTKEYS) {
      hotkeys.registerAction(h.name, undefined, handlers[h.name] ?? (() => {}), { openra: h.openra, inControls: false, listOnly: h.listOnly });
    }
    box.append(this.gameLog, this.waitLine, chatInput);
    field2.append(box);
    const list = names.join(', ');
    this.gameLine(spectator ? `Watching: ${list}. Press Enter to chat.` : `Online game: ${list}. Press Enter to chat${teamChat ? ' with your team, Shift+Enter with everyone' : ''}.`);
    if (cheats) this.gameLine('Cheats are enabled in this game: every player can use the debug menu.', true);
    setInterval(() => {
      if (this.driver) this.waitLine.hidden = !(this.driver.stalledMs > 600 && !this.driver.stopped);
    }, 250);
  }

  gameLine(textValue, important = false) {
    if (!this.gameLog) return;
    const line = el('div', important ? 'online-game-line online-game-important' : 'online-game-line', textValue);
    this.gameLog.append(line);
    while (this.gameLog.childElementCount > 8) this.gameLog.firstElementChild.remove();
    if (!important) setTimeout(() => line.remove(), 15_000);
  }
}

/** Entry point used by main.js. */
export function mountOnline(root, ctx) {
  return new OnlineUI(root, ctx);
}
