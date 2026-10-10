// What the main thread's UI holds instead of the wasm Game: an object with
// the same method names (js/sim/methods.js), so input, sidebar, command bar,
// minimap, debug menu and audio work unchanged whether the simulation runs in
// a worker or on the main thread.
//
// - DirectGame: the simulation runs on this thread (js/sim/core.js); every
//   call goes straight to the engine.
// - RemoteGame: the simulation runs in a worker. Orders are sent in order;
//   queries answer from what the worker sent with its last frame (and are
//   asked again with the next step while the UI keeps calling them); the
//   actor table answers owner / kind / type lookups; `ask.<query>()` returns
//   a promise of a fresh answer, for code that acts on it (clicks, hotkeys).
//
// Both also offer the frame-level values the main loop needs: tick_count,
// take_audio_events (once per new frame), selection (alive ids), fog_bytes.

import {
  actorInfo,
  FOLLOW_LATEST,
  NONE,
  ORDERS,
  QUERIES,
  QUERY_DEFAULTS,
  queryKey,
  tableInfo,
  UI_STATE,
} from './methods.js';

const SETTINGS = ["set_audio_events", "set_health_bars", "set_building_overlays", "set_sprite_poses", "set_original_slots", "set_death_art"];
/** A query stays live (asked again with every step) this long after the UI last called it. */
export const LIVE_MS = 300;
/** A query not called for this long is forgotten. */
export const EXPIRE_MS = 3000;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * What a mission sends with its frames (js/sim/core.js `mission`): the newest
 * panel state (engine `mission_state`) and the events of its scripts since
 * the UI last took them (engine `take_mission_events`).
 */
export class MissionFeed {
  constructor() {
    this.state = null;
    this.events = [];
  }

  onFrame(m) {
    if (!m) return;
    if (m.state) this.state = JSON.parse(m.state);
    if (m.events) for (const e of JSON.parse(m.events)) this.events.push(e);
  }

  /** The events since the last call, oldest first. */
  take() {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** Static facts shared by both handles (from SimCore.info()). */
class StaticFacts {
  constructor(info) {
    this.info = info;
    this.rules = JSON.parse(info.rulesJson);
    this.actorIds = this.rules.actors.map((a) => a.id);
  }

  rules_json() {
    return this.info.rulesJson;
  }

  map_width() {
    return this.info.mapWidth;
  }

  map_height() {
    return this.info.mapHeight;
  }

  cheats_enabled() {
    return this.info.cheats;
  }

  player_count() {
    return this.info.players;
  }

  start_position(player) {
    return Float32Array.from(this.info.startPositions[player] ?? []);
  }

  are_allies(a, b) {
    return this.info.allies[a]?.[b] === true;
  }

  /** The sky at the start (biome, weather mode); per frame it comes with the frame (`frame.weather`). */
  weather_json() {
    return this.info.weatherJson ?? '{"biome":"temperate","mode":"off","weather":"clear"}';
  }
}

// ---- Main thread ---------------------------------------------------------------------

/** The game when the simulation runs on the main thread. */
export class DirectGame extends StaticFacts {
  /**
   * @param {import('./core.js').SimCore} core
   * @param {object} info SimCore.info()
   */
  constructor(core, info) {
    super(info);
    this.core = core;
    this.pendingAudio = null;
    this.mission = new MissionFeed();
    this.lastFrame = null;
    for (const m of [...ORDERS, ...UI_STATE, ...SETTINGS]) this[m] = (...args) => core.call(m, args);
    for (const m of QUERIES) this[m] = (...args) => core.query(m, args);
    const ask = {};
    for (const m of [...QUERIES, 'fog_bytes']) {
      ask[m] = (...args) => {
        try {
          return Promise.resolve(core.query(m, args));
        } catch (err) {
          return Promise.reject(err);
        }
      };
    }
    this.ask = ask;
  }

  /** Called by the host after each step. */
  onFrame(frame) {
    this.lastFrame = frame;
    this.pendingAudio = frame.audio;
    this.mission.onFrame(frame.mission);
  }

  tick_count() {
    return this.core.game.tick_count();
  }

  take_audio_events() {
    const events = this.pendingAudio ?? new Int32Array(0);
    this.pendingAudio = null;
    return events;
  }

  selection() {
    return this.core.game.selection();
  }

  actor_info(id) {
    return actorInfo(this.core.game, id);
  }

  /** Fog bytes of `player` (0 shroud, 128 fog, 255 visible): a view of wasm memory, use it at once. */
  fog_bytes(player) {
    const g = this.core.game;
    const ptr = g.fog_ptr(player);
    return new Uint8Array(this.core.memory().buffer, ptr, g.fog_len());
  }
}

// ---- Worker -------------------------------------------------------------------------------

/**
 * Synchronous answers for a remote simulation: the last answer per query, the
 * list of queries to ask with the next step, and answers to store.
 */
export class QueryCache {
  constructor(now = clock) {
    this.now = now;
    /** key -> { method, args, value, has, called } */
    this.entries = new Map();
    /** method -> last answer (FOLLOW_LATEST) */
    this.latest = new Map();
  }

  get(method, args) {
    const key = queryKey(method, args);
    const t = this.now();
    let e = this.entries.get(key);
    if (!e) {
      e = { method, args, value: undefined, has: false, called: t };
      this.entries.set(key, e);
    } else {
      e.called = t;
    }
    if (e.has) return e.value;
    if (FOLLOW_LATEST.has(method) && this.latest.has(method)) return this.latest.get(method);
    return QUERY_DEFAULTS[method]();
  }

  /** `[[key, method, args], ...]` of the queries called recently; forgets old ones. */
  collect() {
    const t = this.now();
    const out = [];
    for (const [key, e] of this.entries) {
      const idle = t - e.called;
      if (idle > EXPIRE_MS) this.entries.delete(key);
      else if (idle <= LIVE_MS) out.push([key, e.method, e.args]);
    }
    return out;
  }

  /** Store `[[key, value], ...]` from a frame (undefined: the query failed, keep the old value). */
  answer(list) {
    if (!list) return;
    for (const [key, value] of list) {
      const e = this.entries.get(key);
      if (!e || value === undefined) continue;
      e.value = value;
      e.has = true;
      if (FOLLOW_LATEST.has(e.method)) this.latest.set(e.method, value);
    }
  }
}

/** The game when the simulation runs in a worker (js/sim/host.js WorkerHost). */
export class RemoteGame extends StaticFacts {
  /**
   * @param {{ post(msg: object): void, ask(method: string, args: any[]): Promise<any> }} link
   * @param {object} info SimCore.info()
   */
  constructor(link, info, { now = clock } = {}) {
    super(info);
    this.link = link;
    this.cache = new QueryCache(now);
    this.selected = new Uint32Array(0);
    this.hover = NONE;
    this.table = null;
    this.tick = info.tick;
    this.pendingAudio = null;
    this.mission = new MissionFeed();
    this.frameFog = null;
    this.viewPlayer = null;
    for (const m of [...ORDERS, ...SETTINGS]) this[m] = (...args) => link.post({ t: 'call', method: m, args });
    for (const m of QUERIES) this[m] = (...args) => this.cache.get(m, args);
    const ask = {};
    for (const m of [...QUERIES, 'fog_bytes']) ask[m] = (...args) => link.ask(m, args);
    this.ask = ask;
  }

  set_selection(ids) {
    this.selected = Uint32Array.from(ids);
    this.link.post({ t: 'call', method: 'set_selection', args: [this.selected] });
  }

  set_hover(id) {
    if (id === this.hover) return;
    this.hover = id;
    this.link.post({ t: 'call', method: 'set_hover', args: [id] });
  }

  /** Control groups for the numbers on selection boxes: `ids[k]` is in group `groups[k]`. */
  set_control_groups(ids, groups) {
    this.link.post({ t: 'call', method: 'set_control_groups', args: [Uint32Array.from(ids), Uint8Array.from(groups)] });
  }

  /** The queries to ask with the next step. */
  collectQueries() {
    return this.cache.collect();
  }

  /**
   * A new frame arrived: its answers, actor table, tick, sound events and fog.
   * @param {object} frame js/sim/host.js frame
   * @param {number} viewPlayer the player whose fog the frame carries
   */
  onFrame(frame, viewPlayer) {
    this.cache.answer(frame.answers);
    if (frame.table) this.table = frame.table;
    this.tick = frame.tick;
    if (frame.audio) this.pendingAudio = this.pendingAudio ? concat(this.pendingAudio, frame.audio) : frame.audio;
    this.mission.onFrame(frame.mission);
    this.frameFog = frame.fog;
    this.viewPlayer = viewPlayer;
  }

  tick_count() {
    return this.tick;
  }

  take_audio_events() {
    const events = this.pendingAudio ?? new Int32Array(0);
    this.pendingAudio = null;
    return events;
  }

  /** Selected ids still alive and on the map (from the actor table). */
  selection() {
    if (!this.table) return this.selected.slice();
    return this.selected.filter((id) => this.actor_info(id)?.inWorld === true);
  }

  /** Owner, kind and type of an actor (js/sim/methods.js tableInfo), or null when it is gone. */
  actor_info(id) {
    return tableInfo(this.table, this.actorIds, id);
  }

  /** Fog bytes of `player`: the frame's when it shows that player, else the last answer to a fog query. */
  fog_bytes(player) {
    if (player === this.viewPlayer && this.frameFog) return this.frameFog();
    const key = 'fog_bytes';
    const e = this.cache.entries.get(queryKey(key, [player]));
    // Registered like any query (the worker answers with a copy).
    if (!e) {
      this.cache.entries.set(queryKey(key, [player]), { method: key, args: [player], value: undefined, has: false, called: this.cache.now() });
      return null;
    }
    e.called = this.cache.now();
    return e.has ? e.value : null;
  }
}

function concat(a, b) {
  const out = new Int32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---- Driver, replay and recorder handles ------------------------------------------------------

/**
 * The online driver as js/online.js sees it: network messages go to the
 * LockstepDriver where the simulation runs, its state comes back with each
 * frame (`update`). Sends from the driver arrive through the host's `send`
 * event and go out on the connection current when they were made.
 */
export class DriverHandle {
  /**
   * @param {{ command(name: string, args?: any[]): Promise<any>, on(type: string, fn: Function): void }} host
   * @param {{ send(msg: object): void }} conn
   * @param {{ tickMs: number, onCaughtUp?: () => void, onCheck?: (ok: boolean, tick: number) => void }} o
   */
  constructor(host, conn, { tickMs, onCaughtUp = null, onCheck = null }) {
    this.host = host;
    this.conn = conn;
    this.tickMs = tickMs;
    this.epoch = 0;
    this.stopped = false;
    this.stalledMs = 0;
    this.catchingUp = true;
    this.waitingSync = false;
    this.progressValue = 0;
    host.on('send', ({ msg, epoch }) => {
      if (epoch !== this.epoch) return; // made for a connection that is gone
      try {
        this.conn.send(msg);
      } catch (err) {
        console.error('Could not send', msg?.t, err?.message ?? err);
      }
    });
    host.on('caughtUp', () => onCaughtUp?.());
    host.on('check', ({ ok, tick }) => onCheck?.(ok, tick));
  }

  /** The driver's state from a frame's status. */
  update(online) {
    if (!online) return;
    this.catchingUp = online.catchingUp;
    this.waitingSync = online.waitingSync;
    this.progressValue = online.progress;
    this.stalledMs = online.stalledMs;
    this.stopped = this.stopped || online.stopped;
  }

  progress() {
    return this.progressValue;
  }

  onFrame(frame) {
    this.host.command('net', ['frame', frame]);
  }

  onLog(msg) {
    this.host.command('net', ['log', msg]);
  }

  onSync(msg) {
    this.host.command('net', ['sync', msg]);
  }

  onBack(tick) {
    this.host.command('back', [tick]);
  }

  /** A new connection after a reconnect: the old one's late sends are dropped. */
  reattach(conn) {
    this.conn = conn;
    this.epoch++;
    this.catchingUp = true;
    this.waitingSync = true;
    this.host.command('reattach', [this.epoch]);
  }

  stop() {
    this.stopped = true;
    this.host.command('stop');
  }
}

/** The replay viewer's controller (js/records.js ReplayBar) for a ReplayController where the simulation runs. */
export class ReplayHandle {
  constructor(host, length) {
    this.host = host;
    this.length = length;
    this.ticks = 0;
    this.playing = true;
    this.speed = 1;
    this.ended = false;
    this.seeking = false;
    this.target = null;
    this.diverged = null;
  }

  update(r) {
    if (!r) return;
    Object.assign(this, {
      ticks: r.ticks,
      length: r.length,
      playing: r.playing,
      speed: r.speed,
      ended: r.ended,
      seeking: r.seeking,
      target: r.target,
      diverged: r.diverged,
    });
  }

  togglePlay() {
    // Shown at once; the next frame brings the controller's own state.
    this.playing = this.ended ? true : !this.playing;
    this.host.command('togglePlay');
  }

  setSpeed(speed) {
    this.speed = speed;
    this.host.command('setSpeed', [speed]);
  }

  seek(ticks) {
    this.seeking = true;
    this.target = Math.max(0, Math.min(this.length, Math.round(ticks)));
    this.host.command('seek', [ticks]);
  }

  dispose() {
    this.host.command('dispose');
  }
}

/** The recorder of the running game, for the game menu's save and replay actions. */
export class RecorderHandle {
  constructor(host, start) {
    this.host = host;
    this.start = start;
    this.full = false;
  }

  update(full) {
    if (full !== undefined) this.full = full;
  }

  /** `{ text, ticks, full }` of a save or replay of the game so far (rejects with the reason). */
  encode(kind) {
    return this.host.command('encode', [kind]);
  }

  /** The online save file at the agreed save point (`ticks`, `hash`, the server's record `id`). */
  encodeOnlineSave(ticks, hash, id) {
    return this.host.command('encodeOnlineSave', [ticks, hash, id]);
  }
}
