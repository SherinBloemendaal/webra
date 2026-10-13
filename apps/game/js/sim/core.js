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
//                        (per frame: instances; `instances: 'gpu'`: tick-rate
//                        records for the GPU instance pass, only when they change)
//   command(name, args)  network, replay, recorder and debug controls
// Events (network sends, caught up, hash check) go out through `emit`.

import { LockstepDriver } from '../net.js';
import { coopStart, LocalDriver, newGame, Recorder, ReplayController } from '../replay.js';
import { RECT_REC_FLOATS, SPRITE_EXTRA_FLOATS, SPRITE_REC_FLOATS } from '../crowd.js';
import { COMPOSITES, isOrder, isQuery, isUiState } from './methods.js';
import { engineError } from './engine-error.js';
import { C2S } from '../protocol.js';

/** Floats per line instance: `[x0, y0, x1, y1, r, g, b, a, width]` (engine/src/paths.rs LINE_FLOATS). */
const LINE_FLOATS = 9;

const MAX_TICKS_PER_FRAME = 8;

/** How many of the newest state hashes an error report gets. */
const REPORT_HASHES = 4;

/** Calls the main thread may make besides orders and UI state. */
const SETTINGS = new Set(["set_audio_events", "set_health_bars", "set_building_overlays", "set_sprite_poses", "set_original_slots", "set_death_art"]);

export class SimCore {
  /**
   * @param {{ Game: any, memory: () => WebAssembly.Memory,
   *   emit?: (type: string, payload: any) => void, now?: () => number,
   *   engine?: { version?: () => string, takePanic?: () => string | undefined } | null,
   *   onFailure?: (err: Error) => void }} o
   *   `engine`: the wasm module's `version` and `take_panic` exports, for
   *   errors that say what the engine did (js/sim/engine-error.js);
   *   `onFailure`: called once with the engine error that stops the game
   */
  constructor({ Game, memory, emit = () => {}, now = null, engine = null, onFailure = null }) {
    this.Game = Game;
    this.memory = memory;
    this.emit = emit;
    this.engine = engine;
    this.onFailure = onFailure;
    /** The engine error that stopped this game: every later call throws it. */
    this.failure = null;
    /** The last tick a frame was built for, and the newest state hashes `[tick, hash]` sent online. */
    this.lastTick = 0;
    this.sentHashes = [];
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
    /** Bumped by everything besides a tick that changes what is drawn (orders, selection, hover, settings, seeks). */
    this.renderEpoch = 0;
    /** What the last records were built for (GPU instance path), and their generation. */
    this.recordsKey = null;
    this.recordsGen = 0;
    /** Whether the game plays a mission (asked once), and the tick its panel state was sent for. */
    this.missionOn = null;
    this.missionTick = -1;
    // Every call into the engine goes through `guard`: a panic or trap
    // becomes an EnginePanic / EngineTrap with the game's facts.
    for (const name of ['start', 'call', 'query', 'command', 'step']) {
      const fn = this[name];
      this[name] = (...args) => this.guard(() => fn.apply(this, args));
    }
  }

  /** Run `fn`; an engine panic or trap stops the game and is thrown as an EngineError. */
  guard(fn) {
    if (this.failure) throw this.failure;
    try {
      return fn();
    } catch (err) {
      const out = engineError(err, { takePanic: this.engine?.takePanic, context: () => this.context() });
      if (out !== err) {
        this.failure = out;
        try {
          this.onFailure?.(out);
        } catch {
          // Reporting must never hide the error itself.
        }
      }
      throw out;
    }
  }

  /** A state hash sent to the server (online): the newest few go into error reports. */
  noteHash(tick, hash) {
    this.sentHashes.push([tick, hash]);
    if (this.sentHashes.length > REPORT_HASHES) this.sentHashes.shift();
  }

  /**
   * Facts about the game for an error report: the engine version, the game
   * mode, the last tick drawn and the newest state hashes (sent online, or
   * kept by the recorder). Never calls into the game: after a panic it
   * cannot be used any more.
   */
  context() {
    let engine = null;
    try {
      engine = this.engine?.version?.() ?? null;
    } catch {
      engine = null;
    }
    const kept = this.sentHashes.length ? this.sentHashes : (this.recorder?.hashes ?? []);
    return {
      engine,
      mode: this.kind,
      tick: this.lastTick,
      hashes: kept.slice(-REPORT_HASHES).map(([tick, hash]) => [tick, hash]),
    };
  }

  // ---- Start ------------------------------------------------------------------------

  /**
   * Create the game.
   * @param {object} spec `{ kind: 'skirmish' | 'mission' | 'save' | 'replay' | 'stress' | 'online', tickMs, ... }`:
   *   skirmish: options, map (canonical text or null), player, recorder (Recorder start or null)
   *   mission:  mission (the mission file's text), options ({ seed, gameSpeed, options }), recorder
   *   save:     replay (the save), mission (its mission file's text for a mission save)
   *   replay:   replay, mission (likewise)
   *   stress:   seed, units, size
   *   online:   options, map, player, spectator, delay, rejoining, recorder (start or null),
   *             mission ({ text, id, hash, options } of a co-op mission, or null)
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
      case 'mission': {
        // The person playing is player 0 (engine mission/setup.rs).
        this.game = G.from_mission(spec.mission, JSON.stringify(spec.options));
        this.recorder = spec.recorder ? new Recorder(spec.recorder) : null;
        this.local = new LocalDriver(this.game, { player: 0, recorder: this.recorder });
        break;
      }
      case 'save': {
        const save = spec.replay;
        this.game = newGame(G, save, spec.mission ?? null);
        // The recording goes on from the save's frames.
        this.recorder = new Recorder({ ...save, frames: save.frames, hashes: save.hashes, createdAt: Date.now() });
        this.local = new LocalDriver(this.game, { player: save.player, recorder: this.recorder, preload: save });
        break;
      }
      case 'replay': {
        this.replay = new ReplayController(G, spec.replay, { missionText: spec.mission ?? null });
        this.game = this.replay.game;
        break;
      }
      case 'stress': {
        this.game = G.new_stress(spec.seed >>> 0, spec.units, spec.size);
        break;
      }
      case 'online': {
        const json = JSON.stringify(spec.options);
        // A co-op mission (`mission`: its file's text, id, hash and options): every client is its own local player.
        if (spec.mission) this.game = G.from_mission(spec.mission.text, coopStart(spec.mission, spec.options.seed, spec.player ?? 0, spec.options.movement));
        else this.game = spec.map ? G.from_map(spec.map, json) : G.from_options(json);
        try {
          this.recorder = spec.recorder ? new Recorder(spec.recorder) : null;
        } catch {
          this.recorder = null;
        }
        const conn = {
          send: (msg) => {
            if (msg?.t === C2S.HASH) this.noteHash(msg.tick, msg.hash);
            this.emit('send', { msg, epoch: this.epoch });
          },
        };
        this.driver = new LockstepDriver(conn, this.game, {
          delay: spec.delay,
          tickMs: this.tickMs,
          spectator: !!spec.spectator,
          player: spec.spectator ? null : (spec.player ?? null),
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
      // Biome and weather at the start (engine/src/weather.rs): the terrain art and the minimap palette follow the biome.
      weatherJson: g.weather_json(),
      recorder: this.recorder ? { start: this.recorder.start } : null,
      // A mission (engine mission/): where the camera starts (world pixels) and its players' names and colours.
      mission: g.is_mission() ? { camera: Array.from(g.mission_camera()), players: JSON.parse(g.mission_state()).players } : null,
    };
  }

  // ---- Calls and queries ---------------------------------------------------------------

  /** An order, a selection or hover change, or a setting. Unknown methods throw. */
  call(method, args) {
    if (!isOrder(method) && !isUiState(method) && !SETTINGS.has(method)) throw new Error(`not a callable Game method: ${method}`);
    this.game[method](...args);
    this.renderEpoch++;
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
        this.renderEpoch++;
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
      // An online save at the agreed save point (`save` message `saved`).
      case 'encodeOnlineSave': {
        const [ticks, hash, id] = args;
        if (!this.recorder) throw new Error('This game is not recorded.');
        if (this.game.tick_count() < ticks) throw new Error('The game has not reached the save point yet.');
        return this.recorder.encodeOnlineSave(ticks, hash, id);
      }
      // Debug menu: one tick while paused (local games only).
      case 'debugStep':
        if (this.driver || this.replay || this.busy()) return false;
        if (this.local) this.local.tick();
        else this.game.tick();
        this.tableDirty = true;
        this.renderEpoch++;
        return true;
      case 'stateHash':
        return this.game.state_hash();
      case 'tick':
        return this.game.tick_count();
      // Facts for an error report (js/telemetry): a desync, for example.
      case 'report':
        return this.context();
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
   *   audio?: boolean, table?: boolean, paths?: boolean, targetLines?: number[], queries?: Array<[string, string, any[]]>,
   *   instances?: 'cpu' | 'gpu',
   * }} req `view`: the player whose eyes the screen uses (or the observer
   *   view), `rect`: the visible world rectangle [x0, y0, x1, y1] in pixels,
   *   `audio`: take the sound events, `table`: send the actor table when it
   *   changed, `paths`: build the selected units' route lines ("Show unit paths"),
   *   `targetLines`: the selected units whose target lines show (js/targetlines.js),
   *   `instances`: 'cpu' (default) builds this frame's interpolated and culled
   *   sprites and rects; 'gpu' builds tick-rate records of the whole map for
   *   the GPU instance pass (js/crowd-gpu.js) and sends them, with the fog,
   *   only when they changed (a tick, an order, the selection, the view)
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
    this.lastTick = tick;
    if (req.table && (this.tableDirty || tick !== this.tableTick)) {
      table = g.actor_table();
      this.tableTick = tick;
      this.tableDirty = false;
    }
    const status = this.status(busy);
    if (loadError) status.loadError = loadError;
    // A mission: its panel state when a tick ran (or first), and what its
    // scripts asked to show or play (dropped while fast-forwarding, like sounds).
    let mission = null;
    this.missionOn ??= g.is_mission();
    if (this.missionOn) {
      const events = g.take_mission_events();
      mission = {
        state: ticks > 0 || this.missionTick !== tick ? g.mission_state() : null,
        events: busy || events === '[]' ? null : events,
      };
      this.missionTick = tick;
    }

    let terrain = null;
    if (g.terrain_dirty()) terrain = { ptr: g.terrain_ptr(), len: g.terrain_len() };
    const gpu = req.instances === 'gpu';
    const buildStart = this.now();
    let fog = null;
    let spriteCount = 0;
    let rectCount = 0;
    let sprites = { ptr: 0, len: 0 };
    let rects = { ptr: 0, len: 0 };
    let records = null;
    if (gpu) {
      // Records change with a tick, an order or UI state, or the view; the
      // GPU interpolates and culls them every frame in between.
      const key = `${tick}:${req.view}:${this.renderEpoch}`;
      if (key !== this.recordsKey) {
        this.recordsKey = key;
        const count = g.build_render_records(req.view);
        records = {
          gen: ++this.recordsGen,
          sprites: { ptr: g.record_ptr(), len: count * SPRITE_REC_FLOATS },
          extras: { ptr: g.record_extra_ptr(), len: g.record_extra_count() * SPRITE_EXTRA_FLOATS },
          rects: { ptr: g.rect_record_ptr(), len: g.rect_record_count() * RECT_REC_FLOATS },
        };
        fog = { ptr: g.fog_ptr(req.view), len: g.fog_len() };
      }
    } else {
      // A CPU frame: the GPU path builds its records afresh when it comes back.
      this.recordsKey = null;
      fog = { ptr: g.fog_ptr(req.view), len: g.fog_len() };
      const [x0, y0, x1, y1] = req.rect;
      spriteCount = g.build_render(req.view, alpha, x0, y0, x1, y1);
      sprites = { ptr: g.sprite_ptr(), len: spriteCount * 8 };
      rectCount = g.rect_count();
      rects = { ptr: g.rect_ptr(), len: rectCount * 8 };
    }
    // Range circles, rally lines of selected structures, the unit routes with
    // "Show unit paths" and the target lines of the units js/targetlines.js shows.
    const lineCount = g.build_lines(req.view, alpha, !!req.paths, req.targetLines?.length ? Uint32Array.from(req.targetLines) : undefined);
    const lines = { ptr: lineCount ? g.path_ptr() : 0, len: lineCount * LINE_FLOATS };
    // Heat shimmer over hot vehicles in view (4 floats each) and the sky
    // (weather_json, a short string): on both instance paths.
    const [hx0, hy0, hx1, hy1] = req.rect;
    const heatCount = g.build_heat_fx(req.view, hx0, hy0, hx1, hy1);
    const heat = { ptr: heatCount ? g.fx_ptr() : 0, len: heatCount * 4 };
    const weather = g.weather_json();
    const buildMs = this.now() - buildStart;
    // Render data handed to the main thread (and the GPU) this frame.
    const renderBytes =
      (sprites.len + rects.len + lines.len + heat.len) * 4 +
      (fog ? fog.len : 0) +
      (records ? (records.sprites.len + records.extras.len + records.rects.len) * 4 : 0);
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
      mission,
      instances: gpu ? 'gpu' : 'cpu',
      buildMs,
      renderBytes,
      spriteCount,
      rectCount,
      lineCount,
      heatCount,
      weather,
      terrain,
      fog,
      sprites,
      rects,
      lines,
      heat,
      records,
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
