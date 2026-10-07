// Online multiplayer UI: server browser, host dialog, password prompt, online
// lobby (slots, options, map, chat, ready, start), the modded-map warning
// (docs/contracts.md, section 2) and the in-game overlay (status and chat).
// Loaded on demand by main.js so local skirmish never depends on it.

import {
  CHAT_MAX,
  COLOR_COUNT,
  DIFFICULTIES,
  GAME_SPEEDS,
  MAP_SIZES,
  mapHash,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MODDED_WARNING,
  NAME_MAX,
  parseMap,
  PASSWORD_MAX,
  PROTOCOL_VERSION,
  ProtocolError,
  SEED_MAX,
  SESSION_ID_RE,
  SESSION_NAME_MAX,
  SPEED_MS,
  STARTING_CASH,
  STARTING_UNITS,
  TEAM_MAX,
  TECH_LEVELS,
  validName,
} from './protocol.js';
import { api, ApiError, Connection, LockstepDriver } from './net.js';

const STORAGE_KEY = 'webra.online.v1';
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
};
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

function field(label, control) {
  const row = el('label', 'online-field');
  row.append(el('span', 'online-field-label', label), control);
  return row;
}

function rgbCss(c) {
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

function loadName() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return data && typeof data.name === 'string' ? data.name : '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name }));
  } catch {
    // Storage blocked: the name is simply not remembered.
  }
}

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & SEED_MAX;
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
   *   onStartGame: (start: { game: any, player: number, driver: LockstepDriver, options: object, onQuit: () => void }) => void,
   *   onBack: () => void,
   * }} ctx
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
    this.showBrowser();
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
    const m = /#join=([0-9a-f]{64})$/.exec(location.hash);
    if (m) joinId.value = m[1];
    const joinById = () => {
      const id = (/([0-9a-f]{64})/.exec(joinId.value.trim()) || [])[1];
      if (!id || !SESSION_ID_RE.test(id)) return this.setError('That is not a valid session ID.');
      this.join({ id, name: 'Private session', locked: null });
    };
    joinId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinById();
    });

    const tools = el('div', 'online-tools');
    tools.append(
      field('Your name', nameInput),
      button('Host game', 'online-btn-primary', () => this.hostDialog()),
      button('Refresh', null, () => this.refresh()),
    );
    const joinRow = el('div', 'online-tools');
    joinRow.append(field('Join by ID', joinId), button('Join', null, joinById));

    const table = el('div', 'online-sessions');
    table.setAttribute('role', 'table');
    this.sessionList = table;
    this.listStatus = el('p', 'online-muted', 'Loading sessions...');

    page.append(head, this.banner, tools, joinRow, table, this.listStatus);
    this.root.append(page);
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  setError(message) {
    if (!this.banner) return;
    this.banner.textContent = message || '';
    this.banner.hidden = !message;
  }

  playerName() {
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
      join.disabled = !same;
      if (!same) join.title = `Needs game version ${s.version}`;
      row.append(el('div', 'online-cell', String(s.host)), el('div', 'online-cell', `${s.players} / ${s.maxPlayers}`), map);
      row.prepend(name);
      const action = el('div', 'online-cell');
      action.append(join);
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
      const pub = el('input');
      pub.type = 'checkbox';
      pub.checked = true;
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
      this.setError(messageOf(err));
    }
  }

  async join(session) {
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
      await this.connect(session.id, hello);
    } catch (err) {
      this.setError(messageOf(err));
    }
  }

  async connect(id, hello) {
    saveName(hello.name);
    const conn = new Connection(id);
    conn
      .on('lobby', (m) => this.onLobby(m))
      .on('chat', (m) => this.chatLine(m.name, m.text, m.from === null))
      .on('left', (m) => this.chatLine(null, `${m.name} ${m.reason === 'kicked' ? 'was removed' : m.reason === 'dropped' ? 'was dropped' : 'left'}.`, true))
      .on('error', (m) => this.onServerError(m))
      .on('start', (m) => this.onStart(m))
      .on('close', (reason) => this.onClose(reason));
    const welcome = await conn.open({ version: this.ctx.version, ...hello });
    clearInterval(this.refreshTimer);
    this.conn = conn;
    this.state = { you: welcome.you, hostId: welcome.hostId, session: welcome.session, slots: [], options: null, map: null };
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    this.buildLobby();
    this.loadServerMaps();
  }

  leaveSession() {
    clearInterval(this.refreshTimer);
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
    if (this.inGame) this.gameLine(`Server: ${m.message}`);
    else this.setError(m.message);
  }

  onClose(reason) {
    if (!this.conn) return; // we left on purpose
    this.conn = null;
    if (this.inGame) {
      this.driver?.stop();
      this.gameLine(`Disconnected${reason ? `: ${reason}` : ''}. The game cannot continue.`, true);
      return;
    }
    this.showBrowser(`Disconnected${reason ? `: ${reason}` : '.'}`);
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
      const link = `${location.origin}${location.pathname}#join=${s.id}`;
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
    const left = el('div', 'online-col');
    left.append(this.slotBox, this.optionBox);
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
    Object.assign(this.state, { slots: m.slots, options: m.options, map: m.map, hostId: m.hostId });
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
    this.readyBtn.hidden = this.isHost;
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

  renderSlots() {
    const box = this.slotBox;
    box.textContent = '';
    const head = el('div', 'online-slot online-row-head');
    head.setAttribute('role', 'row');
    for (const h of ['Player', 'Faction', 'Color', 'Team', '']) head.append(el('div', 'online-cell', h));
    box.append(head);
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
          if (slot.client === this.state.hostId) who.append(el('span', 'online-badge', 'HOST'));
          if (i === mine) who.append(el('span', 'online-badge online-badge-you', 'YOU'));
        } else {
          who.append(el('span', 'online-player-name', 'Computer'));
          const diff = select(DIFFICULTIES.map((d) => [d, LABELS.difficulty[d]]), slot.difficulty, (v) =>
            this.send({ t: 'slot', slot: i, difficulty: v }),
          );
          diff.disabled = !host;
          diff.setAttribute('aria-label', `Player ${i + 1} difficulty`);
          who.append(diff);
        }
        const faction = select(FACTION_GROUPS, slot.faction, (v) => this.send({ t: 'slot', slot: i, faction: v }), true);
        faction.disabled = !editable;
        faction.setAttribute('aria-label', `Player ${i + 1} faction`);
        const color = select(
          Array.from({ length: COLOR_COUNT }, (_, c) => [c, this.ctx.colorNames[c] || `Color ${c + 1}`]),
          slot.color,
          (v) => this.send({ t: 'slot', slot: i, color: Number(v) }),
        );
        color.disabled = !editable;
        color.setAttribute('aria-label', `Player ${i + 1} color`);
        const team = select(
          Array.from({ length: TEAM_MAX + 1 }, (_, t) => [t, t === 0 ? 'None' : `Team ${t}`]),
          slot.team,
          (v) => this.send({ t: 'slot', slot: i, team: Number(v) }),
        );
        team.disabled = !editable;
        team.setAttribute('aria-label', `Player ${i + 1} team`);
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
        action.append(type);
      }
      if (slot.type === 'open') action.append(button('Take', null, () => this.send({ t: 'slot', slot: i })));
      row.append(action);
      box.append(row);
    });
  }

  renderOptions() {
    const box = this.optionBox;
    const o = this.state.options;
    box.textContent = '';
    box.append(el('h2', 'online-panel-title', 'Game options'));
    const host = this.isHost;
    const set = (key, value) => this.send({ t: 'options', options: { ...this.state.options, [key]: value } });
    const grid = el('div', 'online-option-grid');
    for (const [key, label, choices] of SELECT_OPTIONS) {
      const numeric = typeof choices[0][0] === 'number';
      const s = select(choices, o[key], (v) => set(key, numeric ? Number(v) : v));
      s.disabled = !host;
      grid.append(field(label, s));
    }
    const toggles = el('div', 'online-toggles');
    for (const [key, label] of TOGGLES) {
      const row = el('label', 'online-toggle');
      const box2 = el('input');
      box2.type = 'checkbox';
      box2.checked = o[key];
      box2.disabled = !host;
      box2.addEventListener('change', () => set(key, box2.checked));
      row.append(box2, el('span', null, label));
      toggles.append(row);
    }
    box.append(grid, toggles);
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
      caption.textContent = `Generated, ${LABELS.mapSize[st.options.mapSize]} ${st.options.mapSize} x ${st.options.mapSize}, seed ${st.options.seed}`;
      this.drawPreview(canvas, () => this.ctx.Game.map_preview_players(st.options.seed, st.options.mapSize, players), st.options.mapSize);
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
    controls.append(field('Map', source));
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
      controls.append(field('Map size', size), field('Seed', seedRow));
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

  chatLine(name, textValue, system = false) {
    if (this.inGame) {
      this.gameLine(name ? `${name}: ${textValue}` : textValue);
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

  onStart(m) {
    const st = this.state;
    if (!st || !this.conn) return;
    const me = m.players.find((p) => p.client === st.you);
    if (!me) {
      this.showBrowser('The game started without you.');
      return;
    }
    let game;
    try {
      const options = JSON.stringify(m.options);
      if (m.map) {
        const json = this.installed.get(m.map.hash);
        if (!json) throw new Error('The map is not installed.');
        game = this.ctx.Game.from_map(json, options);
      } else {
        game = this.ctx.Game.from_options(options);
      }
    } catch (err) {
      this.showBrowser(`Could not start the game: ${err.message ?? err}`);
      return;
    }
    const conn = this.conn;
    const driver = new LockstepDriver(conn, game, { delay: m.delay, tickMs: SPEED_MS[m.options.gameSpeed] ?? SPEED_MS.normal });
    this.driver = driver;
    // Frames follow the start message immediately; register before returning.
    conn.on('frame', (f) => driver.onFrame(f));
    conn.on('desync', (d) => this.gameLine(`Desync detected at tick ${d.tick}: the game states differ. Results may not match.`, true));
    this.inGame = true;
    this.root.hidden = true;
    this.buildGameOverlay(m.players);
    this.ctx.onStartGame({
      game,
      player: me.player,
      driver,
      options: m.options,
      onQuit: () => {
        this.leaveSession();
        driver.stop();
      },
    });
  }

  buildGameOverlay(players) {
    const field2 = document.getElementById('field') || document.body;
    const box = el('div', 'online-game');
    box.id = 'online-game';
    this.gameLog = el('div', 'online-game-log');
    this.gameLog.setAttribute('aria-live', 'polite');
    this.waitLine = el('div', 'online-game-wait', 'Waiting for players...');
    this.waitLine.hidden = true;
    const chatInput = el('input', 'online-input online-game-chat');
    chatInput.maxLength = CHAT_MAX;
    chatInput.placeholder = 'Chat (Enter to send, Esc to close)';
    chatInput.hidden = true;
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        chatInput.hidden = true;
        chatInput.blur();
      } else if (e.key === 'Enter') {
        if (chatInput.value.trim()) this.send({ t: 'chat', text: chatInput.value });
        chatInput.value = '';
        chatInput.hidden = true;
        chatInput.blur();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      chatInput.hidden = false;
      chatInput.focus();
    });
    box.append(this.gameLog, this.waitLine, chatInput);
    field2.append(box);
    const names = players.map((p) => p.name).join(', ');
    this.gameLine(`Online game: ${names}. Press Enter to chat.`);
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
