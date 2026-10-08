// The simulation side of a game: the wasm Game, the driver that decides when
// it ticks (skirmish and saves: LocalDriver, online: LockstepDriver, replays:
// ReplayController, the stress test: plain ticks), the recorder, and the
// per-frame output the main thread draws. No DOM, so the same code runs in
// the simulation worker (js/sim/worker.js), on the main thread when workers
// are unavailable (js/sim/host.js, direct mode) and headless in the tests.
//
// The main thread drives it with messages (docs/contracts.md, section 8):
//   start(spec)          create the game and its driver; returns static facts
//   call(method, args)   an order or a selection / hover change
//   query(method, args)  a read-only Game query
//   step(request)        advance by the frame's wall time, build the render data
//   command(name, args)  network, replay, recorder and debug controls
// Events (network sends, caught up, hash check) go out through `emit`.

import { LockstepDriver } from '../net.js';
import { LocalDriver, newGame, Recorder, ReplayController } from '../replay.js';
import { COMPOSITES, isOrder, isQuery, isUiState } from './methods.js';

const MAX_TICKS_PER_FRAME = 8;

/** Calls the main thread may make besides orders and UI state. */
const SETTINGS = new Set(['set_audio_events', 'set_health_bars', 'set_building_overlays']);

export class SimCore {
  /**
   * @param {{ Game: any, memory: () => WebAssembly.Memory,
   *   emit?: (type: string, payload: any) => void, now?: () => number }} o
   */
  constructor({ Game, memory, emit = () => {}, now = null }) {
    this.Game = Game;
    this.memory = memory;
    this.emit = emit;
    this.now = now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.game = null;
    this.kind = null;
    this.local = null;
    this.driver = null;
    this.replay = null;
    this.recorder = null;
    this.tickMs = 40;
    this.acc = 0;
    this.simMs = 0;
    this.hidden = false;
    /** Connection epoch for network sends (bumped by a reconnect). */
    this.epoch = 0;
    this.tableTick = -1;
    this.tableDirty = true;
  }

  // ---- Start ------------------------------------------------------------------------

  /**
   * Create the game.
   * @param {object} spec `{ kind: 'skirmish' | 'save' | 'replay' | 'stress' | 'online', tickMs, ... }`:
   *   skirmish: options, map (canonical text or null), player, recorder (Recorder start or null)
   *   save:     replay (the save)
   *   replay:   replay
   *   stress:   seed, units, size
   *   online:   options, map, player, spectator, delay, rejoining, recorder (start or null)
   * @returns {object} static facts about the game (see `info`)
   */
  start(spec) {
    if (this.game) throw new Error('this simulation already runs a game');
    const G = this.Game;
    this.kind = spec.kind;
    this.tickMs = spec.tickMs ?? 40;
    switch (spec.kind) {
      case 'skirmish': {
        const json = JSON.stringify(spec.options);
        this.game = spec.map ? G.from_map(spec.map, json) : G.from_options(json);
        this.recorder = spec.recorder ? new Recorder(spec.recorder) : null;
        this.local = new LocalDriver(this.game, { player: spec.player, recorder: this.recorder });
        break;
      }
      case 'save': {
        const save = spec.replay;
        this.game = newGame(G, save);
        // The recording goes on from the save's frames.
        this.recorder = new Recorder({ ...save, frames: save.frames, hashes: save.hashes, createdAt: Date.now() });
        this.local = new LocalDriver(this.game, { player: save.player, recorder: this.recorder, preload: save });
        break;
      }
      case 'replay': {
        this.replay = new ReplayController(G, spec.replay);
        this.game = this.replay.game;
        break;
      }
      case 'stress': {
        this.game = G.new_stress(spec.seed >>> 0, spec.units, spec.size);
        break;
      }
      case 'online': {
        const json = JSON.stringify(spec.options);
        this.game = spec.map ? G.from_map(spec.map, json) : G.from_options(json);
        try {
          this.recorder = spec.recorder ? new Recorder(spec.recorder) : null;
        } catch {
          this.recorder = null;
        }
        const conn = { send: (msg) => this.emit('send', { msg, epoch: this.epoch }) };
        this.driver = new LockstepDriver(conn, this.game, {
          delay: spec.delay,
          tickMs: this.tickMs,
          spectator: !!spec.spectator,
          rejoining: !!spec.rejoining,
          recorder: this.recorder,
          onCaughtUp: () => this.emit('caughtUp', null),
          onCheck: (ok, tick) => this.emit('check', { ok, tick }),
          hidden: () => this.hidden,
          now: this.now,
        });
        break;
      }
      default:
        throw new Error(`unknown game kind ${spec.kind}`);
    }
    return this.info();
  }

  /** Facts that do not change during the game, for the main thread's mirror. */
  info() {
    const g = this.game;
    const players = g.player_count();
    const startPositions = [];
    const allies = [];
    for (let p = 0; p < players; p++) {
      startPositions.push(Array.from(g.start_position(p)));
      const row = [];
      for (let q = 0; q < players; q++) row.push(g.are_allies(p, q));
      allies.push(row);
    }
    return {
      kind: this.kind,
      rulesJson: g.rules_json(),
      mapWidth: g.map_width(),
      mapHeight: g.map_height(),
      cheats: g.cheats_enabled(),
      players,
      startPositions,
      allies,
      tick: g.tick_count(),
      replayLength: this.replay ? this.replay.length : 0,
      recorder: this.recorder ? { start: this.recorder.start } : null,
    };
  }

  // ---- Calls and queries ---------------------------------------------------------------

  /** An order, a selection or hover change, or a setting. Unknown methods throw. */
  call(method, args) {
    if (!isOrder(method) && !isUiState(method) && !SETTINGS.has(method)) throw new Error(`not a callable Game method: ${method}`);
    this.game[method](...args);
  }

  /** A read-only query (js/sim/methods.js QUERIES), plus `fog_bytes(player)` (a copy). */
  query(method, args) {
    const g = this.game;
    if (method === 'fog_bytes') {
      const ptr = g.fog_ptr(args[0]);
      return new Uint8Array(this.memory().buffer, ptr, g.fog_len()).slice();
    }
    if (!isQuery(method)) throw new Error(`not a Game query: ${method}`);
    const composite = COMPOSITES[method];
    return composite ? composite(g, ...args) : g[method](...args);
  }

  /** Answers for `[[key, method, args], ...]`: `[[key, value | undefined], ...]` (undefined when it threw). */
  queries(list) {
    const out = [];
    for (const [key, method, args] of list) {
      try {
        out.push([key, this.query(method, args)]);
      } catch {
        out.push([key, undefined]);
      }
    }
    return out;
  }

  // ---- Commands ---------------------------------------------------------------------------

  /** Network, replay, recorder and debug controls. Returns a plain value. */
  command(name, args = []) {
    switch (name) {
      // Online (LockstepDriver).
      case 'net': {
        const [type, msg] = args;
        if (!this.driver) return null;
        if (type === 'frame') this.driver.onFrame(msg);
        else if (type === 'log') this.driver.onLog(msg);
        else if (type === 'sync') this.driver.onSync(msg);
        return null;
      }
      case 'back':
        this.driver?.onBack(args[0]);
        return null;
      case 'reattach':
        // A new connection: sends made for the old one are dropped by the main thread.
        this.epoch = args[0];
        this.driver?.reattach(this.driver.conn);
        return null;
      case 'stop':
        this.driver?.stop();
        return null;
      case 'hidden':
        this.hidden = !!args[0];
        return null;
      // Replays (ReplayController).
      case 'seek':
        this.replay?.seek(args[0]);
        this.tableDirty = true;
        return null;
      case 'setSpeed':
        this.replay?.setSpeed(args[0]);
        return null;
      case 'togglePlay':
        this.replay?.togglePlay();
        return null;
      case 'dispose':
        this.replay?.dispose();
        return null;
      // Saves and replays of the running game (Recorder).
      case 'encode': {
        const [kind] = args;
        if (!this.recorder) throw new Error('This game is not recorded.');
        if (this.local?.loading) throw new Error('Wait until the game has loaded.');
        const ticks = this.game.tick_count();
        const text = kind === 'save' ? this.recorder.encode('save', ticks, this.game.state_hash()) : this.recorder.encode('replay', ticks);
        return { text, ticks, full: this.recorder.full };
      }
      // Debug menu: one tick while paused (local games only).
      case 'debugStep':
        if (this.driver || this.replay || this.busy()) return false;
        if (this.local) this.local.tick();
        else this.game.tick();
        this.tableDirty = true;
        return true;
      case 'stateHash':
        return this.game.state_hash();
      case 'tick':
        return this.game.tick_count();
      default:
        throw new Error(`unknown simulation command ${name}`);
    }
  }

  // ---- Step ---------------------------------------------------------------------------------

  /** Fast-forwarding (loading a save, catching up online, seeking a replay): no sound, no input. */
  busy() {
    return !!(this.local?.loading || this.driver?.catchingUp || this.replay?.seeking);
  }

  /**
   * Advance the game by one animation frame and build its render data.
   * @param {{
   *   dt: number, paused?: boolean, view: number, rect: number[],
   *   audio?: boolean, table?: boolean, paths?: boolean, queries?: Array<[string, string, any[]]>,
   * }} req `view`: the player whose eyes the screen uses (or the observer
   *   view), `rect`: the visible world rectangle [x0, y0, x1, y1] in pixels,
   *   `audio`: take the sound events, `table`: send the actor table when it
   *   changed, `paths`: build the selected units' route lines ("Show unit paths")
   * @returns {object} the frame: timings, status, query answers, and
   *   `{ ptr, len }` locations in wasm memory of the render data (valid until
   *   the next call into the game; js/sim/worker.js copies them out)
   */
  step(req) {
    const g = this.game;
    const tickMs = this.tickMs;
    const dt = req.dt;
    const paused = !!req.paused;
    let alpha = paused ? 1 : this.acc / tickMs;
    let simFrameMs = 0;
    let ticks = 0;
    let loadError = null;
    if (this.driver || this.replay) {
      const t0 = this.now();
      const r = this.driver ? this.driver.advance(dt) : this.replay.advance(dt, tickMs);
      simFrameMs = this.now() - t0;
      ticks = r.ticks;
      if (r.ticks > 0 && !this.busy()) this.simMs = this.simMs * 0.9 + (simFrameMs / r.ticks) * 0.1;
      alpha = r.alpha;
    } else if (this.local?.loading) {
      // Loading a save: re-simulate it within a time budget per frame.
      const before = g.tick_count();
      if (this.local.load()) {
        this.acc = 0;
        if (this.local.error) loadError = this.local.error;
      }
      ticks = g.tick_count() - before;
    } else if (!paused) {
      this.acc += dt;
      const t0 = this.now();
      while (this.acc >= tickMs && ticks < MAX_TICKS_PER_FRAME) {
        if (this.local) this.local.tick();
        else g.tick();
        this.acc -= tickMs;
        ticks++;
      }
      simFrameMs = this.now() - t0;
      if (ticks > 0) this.simMs = this.simMs * 0.9 + (simFrameMs / ticks) * 0.1;
      if (ticks === MAX_TICKS_PER_FRAME) this.acc = 0; // too slow: drop time instead of spiralling
      alpha = this.acc / tickMs;
    }
    const busy = this.busy();

    // Everything that may allocate in wasm memory comes first: the locations
    // of the render data below stay valid only until the next call.
    const answers = req.queries?.length ? this.queries(req.queries) : null;
    // Sounds of what happened (fast-forwarding stays silent: they are dropped).
    let audio = null;
    if (busy || !req.audio) g.take_audio_events();
    else {
      const events = g.take_audio_events();
      if (events.length) audio = events;
    }
    let table = null;
    const tick = g.tick_count();
    if (req.table && (this.tableDirty || tick !== this.tableTick)) {
      table = g.actor_table();
      this.tableTick = tick;
      this.tableDirty = false;
    }
    const status = this.status(busy);
    if (loadError) status.loadError = loadError;

    let terrain = null;
    if (g.terrain_dirty()) terrain = { ptr: g.terrain_ptr(), len: g.terrain_len() };
    const fog = { ptr: g.fog_ptr(req.view), len: g.fog_len() };
    const [x0, y0, x1, y1] = req.rect;
    const spriteCount = g.build_render(req.view, alpha, x0, y0, x1, y1);
    const sprites = { ptr: g.sprite_ptr(), len: spriteCount * 8 };
    const rectCount = g.rect_count();
    const rects = { ptr: g.rect_ptr(), len: rectCount * 8 };
    const lineCount = req.paths ? g.build_paths(req.view, alpha) : 0;
    const lines = { ptr: lineCount ? g.path_ptr() : 0, len: lineCount * 8 };
    return {
      ticks,
      alpha,
      simFrameMs,
      simMs: this.simMs,
      tick,
      busy,
      status,
      answers,
      audio,
      table,
      spriteCount,
      rectCount,
      lineCount,
      terrain,
      fog,
      sprites,
      rects,
      lines,
    };
  }

  /** Driver state the main thread shows (progress, replay bar, online waiting line). */
  status(busy = this.busy()) {
    const s = { busy, memoryBytes: this.memory().buffer.byteLength };
    if (this.local) {
      s.loading = this.local.loading;
      s.loadProgress = this.local.progress();
    }
    if (this.driver) {
      const d = this.driver;
      s.online = {
        catchingUp: d.catchingUp,
        waitingSync: d.waitingSync,
        progress: d.progress(),
        stalledMs: d.stalledMs,
        stopped: d.stopped,
      };
    }
    if (this.replay) {
      const r = this.replay;
      s.replay = {
        ticks: r.ticks,
        length: r.length,
        playing: r.playing,
        speed: r.speed,
        ended: r.ended,
        seeking: r.seeking,
        target: r.target,
        diverged: r.diverged,
      };
    }
    if (this.recorder) s.recorderFull = this.recorder.full;
    if (this.kind === 'stress') s.actorCount = this.game.actor_count();
    return s;
  }
}

/** A typed-array view of `{ ptr, len }` in wasm memory (direct mode: no copy). */
export function wasmView(memory, Type, loc) {
  return loc ? new Type(memory.buffer, loc.ptr, loc.len) : null;
}
