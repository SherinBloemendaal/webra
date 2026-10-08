// Boot: load the simulation (WebAssembly), the WebGPU renderer and the lobby,
// then run the fixed-step game loop with interpolated rendering.
//
// Every game is recorded (js/replay.js): skirmish through a local lockstep
// driver, online games through the network driver. The game menu saves
// skirmish games (browser storage or a file) and downloads replays; the
// lobby's Load game and Replays buttons (js/records.js) load them again.
// Spectators and the replay viewer watch with the observer panel
// (js/observer.js): whole map or one player's view, and player stats.

import init, { Game, base_rules_json, version } from '../pkg/webra_sim.js';
import { Renderer, TEAM_COLORS } from './renderer.js';
import { buildAtlas } from './sprites.js';
import { AnimClock } from './anim.js';
import { Input } from './input.js';
import { Sidebar } from './sidebar.js';
import { PowerBar } from './powers.js';
import { CommandBar } from './commandbar.js';
import { Lobby } from './lobby.js';
import { AudioSystem } from './audio/index.js';
import { mountAudioPanel } from './audio/panel.js';
import { CURSORS } from './cursors.js';
import { hotkeys } from './hotkeys.js';
import { settings } from './settings.js';
import { GameMenu } from './gamemenu.js';
import { fullscreenAvailable, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen.js';
import { DebugMenu } from './debug.js';
import { NotificationView } from './notifications.js';
import { importOramap } from './oramap/index.js';
import { Minimap } from './minimap.js';
import { mountReleaseNotes } from './releasenotes-dialog.js';
import { TouchControls } from './touch.js';
import { Layout, hudText, renderPixelRatio } from './layout.js';

const PLAYER = 0;
const MAX_TICKS_PER_FRAME = 8;

// OpenRA game speeds: milliseconds per simulation tick.
const SPEEDS = { slowest: 80, slower: 50, normal: 40, fast: 35, faster: 30, fastest: 20 };
const COLOR_NAMES = ['Blue', 'Red', 'Gold', 'Green', 'Purple', 'Orange', 'Teal', 'White'];
const RANDOM_POOLS = {
  random: ['england', 'france', 'germany', 'russia', 'ukraine'],
  randomallies: ['england', 'france', 'germany'],
  randomsoviet: ['russia', 'ukraine'],
};

const $ = (id) => document.getElementById(id);

let wasm;
let renderer;
/** js/replay.js and js/records.js (recording, saves, replays), or null when they failed to load. */
let records = null;
// Sound (js/audio): synthesized by default, original files when the player installed them.
let audio = null;
/** The Sound dialog (js/audio/panel.js), also opened from the game menu. */
let audioPanel = null;
/** Release notes dialog (js/releasenotes-dialog.js): lobby, game menu and "What's new". */
let releaseNotes = null;

async function boot() {
  let gpuError = null;
  try {
    wasm = await init();
  } catch (err) {
    gpuError = `Could not load the game engine: ${err.message}`;
  }
  $('version').textContent = wasm ? `v${version()}` : '';
  setupAudio();
  releaseNotes = mountReleaseNotes($('release-notes'), { version: wasm ? version() : null });
  const lobby = new Lobby($('menu'), {
    colors: TEAM_COLORS,
    colorNames: COLOR_NAMES,
    mapPreview: (seed, size) => Game.map_preview(seed, size),
    // Skirmish lobby: previews per player count and map files.
    maps: {
      preview: (seed, size, players) => Game.map_preview_players(seed, size, players),
      spawns: (seed, size, players) => JSON.parse(Game.generated_map(seed, size, players)).spawns,
      validate: (json) => JSON.parse(Game.validate_map(json)),
      filePreview: (json) => Game.map_file_preview(json),
      // OpenRA .oramap maps: converted in the browser, checked by the engine like any map file.
      importOramap: (bytes, fileName) =>
        importOramap(bytes, {
          baseRules: JSON.parse(base_rules_json()),
          validate: (json) => JSON.parse(Game.validate_map(json)),
          fileName,
        }),
    },
    onStart: (options) => startSkirmish(options, lobby),
    onStress: ({ seed, units }) => startStress(seed, units, lobby),
    onReleaseNotes: () => releaseNotes.open(),
  });
  if (!gpuError) {
    try {
      renderer = await Renderer.create($('view'));
    } catch (err) {
      gpuError = `${err.message} WebRA needs a browser with WebGPU (Chrome or Edge 113+, Safari 26+).`;
    }
  }
  if (gpuError) lobby.showError(gpuError);
  await setupRecords(lobby, gpuError);
  setupOnline(lobby, gpuError);
  offerLinkedMap(lobby);
  // Once per new version: what changed since this browser last played.
  releaseNotes.showWhatsNewOnce();
}

/**
 * Recording, saves and replays. They load as modules of their own, so a
 * problem there leaves plain skirmish playable (without recording).
 */
async function setupRecords(lobby, gpuError) {
  try {
    const [replay, ui, protocol] = await Promise.all([import('./replay.js'), import('./records.js'), import('./protocol.js')]);
    records = { ...replay, ...ui, replayOptions: protocol.replayOptions };
  } catch (err) {
    console.warn('Saves and replays are unavailable:', err);
    return;
  }
  records.mountRecordEntries($('records-entry'), {
    version: wasm ? version() : '',
    canPlay: () => !gpuError && !!renderer,
    showError: (msg) => lobby.showError(msg),
    onLoadSave: (replay) => loadSave(replay, lobby),
    onWatchReplay: (replay) => watchReplay(replay, lobby),
  });
}

function setupAudio() {
  try {
    audio = new AudioSystem();
    audioPanel = mountAudioPanel($('audio-button'), $('audio-panel'), audio);
  } catch (err) {
    // The game stays playable without sound.
    console.warn('Sound is unavailable:', err);
    audio = null;
  }
}

/**
 * A map handed over by the URL (`?editorTest=1` from the map editor, or
 * `?map=<id>` from the website's map list) goes through the lobby's normal map
 * flow: validation, and the modded-map warning before it is installed.
 */
async function offerLinkedMap(lobby) {
  const params = new URLSearchParams(location.search);
  if (params.get('editorTest') !== '1' && !params.get('map')) return;
  try {
    const { loadPendingMap } = await import('./maploader.js');
    const map = await loadPendingMap(params);
    if (map) lobby.offerMapText(JSON.stringify(map));
  } catch (err) {
    lobby.reportMapProblem(err?.message ?? err);
  }
}

// ---- Online multiplayer hook --------------------------------------------------
// The "Play online" entry point. js/online.js (and the protocol package) load
// only when used, so local skirmish keeps working when they are unavailable.
function setupOnline(lobby, gpuError) {
  const entry = $('online-button');
  const root = $('online-root');
  if (!entry || !root) return;
  entry.hidden = false;
  let ui = null;
  const open = async () => {
    if (gpuError || !renderer) {
      lobby.showError(gpuError || 'WebGPU is not available.');
      return;
    }
    $('menu').hidden = true;
    entry.hidden = true;
    root.hidden = false;
    if (ui) return;
    try {
      const { mountOnline } = await import('./online.js');
      ui = mountOnline(root, {
        Game,
        version: version(),
        colors: TEAM_COLORS,
        colorNames: COLOR_NAMES,
        onBack: () => {
          root.hidden = true;
          $('menu').hidden = false;
          entry.hidden = false;
        },
        onStartGame: ({ game, player, driver, options, onQuit, recorder = null, spectator = false }) => {
          entry.hidden = true;
          applyColors(options.players);
          start(game, {
            stress: false,
            tickMs: driver.tickMs,
            player: spectator ? 0 : player,
            online: { driver, onQuit, spectator },
            recorder,
            viewer: spectator ? viewerPlayers(options.players) : null,
          });
        },
      });
    } catch (err) {
      root.hidden = true;
      $('menu').hidden = false;
      entry.hidden = false;
      lobby.showError(`Online play is unavailable: ${err.message ?? err}`);
    }
  };
  entry.addEventListener('click', open);
  // Invite links (?join=<session id>, also #join=) open the online screen
  // directly, and so does a reload during an online game (it rejoins).
  if (/[?&]join=[0-9a-f]{64}(&|$)/.test(location.search) || /^#join=[0-9a-f]{64}$/.test(location.hash) || hasRejoinRecord()) open();
}

/** Whether this tab was in an online game before a reload (js/online.js keeps the rejoin key per tab). */
function hasRejoinRecord() {
  try {
    return sessionStorage.getItem('webra.rejoin.v1') !== null;
  } catch {
    return false;
  }
}

/** Names and colours of the players in a game's options, for the observer panel. */
function viewerPlayers(players) {
  return players.map((p, i) => ({
    name: p.type === 'human' ? p.name : p.name || `Computer (${p.difficulty})`,
    color: TEAM_COLORS[i] ?? [1, 1, 1],
  }));
}

/** Resolve "random" factions deterministically from the seed. */
function resolveFactions(options) {
  const players = options.players.map((p, i) => {
    const pool = RANDOM_POOLS[p.faction];
    if (!pool) return { ...p };
    return { ...p, faction: pool[(options.seed + i * 7919) % pool.length] };
  });
  return { ...options, players };
}

/**
 * The renderer and sidebar colour player N with TEAM_COLORS[N]; reorder the
 * shared palette in place so each slot gets the colour picked in the lobby.
 */
function applyColors(slots) {
  // Engine player N is the N-th slot that actually plays (closed and open
  // slots are left out by the engine too), so skip them here as well.
  const players = slots.filter((p) => p && p.type !== 'closed' && p.type !== 'open' && Number.isInteger(p.color));
  const palette = TEAM_COLORS.map((c) => c.slice());
  const used = new Set(players.map((p) => p.color));
  const rest = palette.map((_, i) => i).filter((i) => !used.has(i));
  players
    .map((p) => p.color)
    .concat(rest)
    .forEach((src, dst) => {
      TEAM_COLORS[dst] = palette[src];
    });
}

async function startSkirmish(options, lobby) {
  if (!renderer) return;
  // Skirmish slots: closed slots do not play, so engine players are the
  // remaining slots in order; a map file (options.map) replaces the generated map.
  const { map, ...rest } = options;
  const resolved = resolveFactions(rest);
  const playing = resolved.players.filter((p) => p.type !== 'closed');
  const player = Math.max(0, playing.findIndex((p) => p.type === 'human'));
  // Recorded games start from the replay form of the options (closed slots
  // left out, slots renumbered: the same game for the engine), so the replay
  // starts exactly like this game.
  let engineOptions = resolved;
  let recorder = null;
  let canonicalMap = map ?? null;
  if (records) {
    try {
      engineOptions = records.replayOptions(resolved);
      if (map) canonicalMap = Game.map_canonical(map);
      recorder = new records.Recorder({
        mode: 'skirmish',
        options: engineOptions,
        map: canonicalMap,
        mapHash: canonicalMap ? Game.map_hash(canonicalMap) : null,
        player,
        engine: version(),
        title: skirmishTitle(engineOptions, player),
      });
    } catch (err) {
      console.warn('This game is not recorded:', err.message ?? err);
      engineOptions = resolved;
      canonicalMap = map ?? null;
      recorder = null;
    }
  }
  let game;
  try {
    const json = JSON.stringify(engineOptions);
    game = canonicalMap ? Game.from_map(canonicalMap, json) : Game.from_options(json);
  } catch (err) {
    lobby.showError(`Could not start the game: ${err.message ?? err}`);
    return;
  }
  applyColors(playing);
  const local = records ? new records.LocalDriver(game, { player, recorder }) : null;
  start(game, { stress: false, tickMs: SPEEDS[resolved.gameSpeed] ?? SPEEDS.normal, player, local, recorder });
}

/** "England vs 2 opponents" style title for a recorded skirmish. */
function skirmishTitle(options, player) {
  const others = options.players.length - 1;
  const me = options.players[player];
  const faction = me ? me.faction[0].toUpperCase() + me.faction.slice(1) : 'Skirmish';
  return `${faction} vs ${others} ${others === 1 ? 'opponent' : 'opponents'}`;
}

/** Ask before running a modded map from a replay or save (docs/contracts.md section 2). */
async function acceptMap(replay) {
  if (!replay.map) return true;
  const v = JSON.parse(Game.validate_map(replay.map));
  if (!v.ok) throw new Error(`The map in this file is invalid: ${v.errors.slice(0, 2).join('; ')}`);
  if (v.hash !== replay.mapHash) throw new Error('The map in this file does not match its hash.');
  return !v.modded || records.confirmModdedMap(JSON.parse(replay.map).name);
}

/** Continue a saved skirmish: re-simulate it, check its state hash, play on. */
async function loadSave(replay, lobby) {
  if (!renderer || !records) return;
  const mismatch = records.engineMismatch(replay, version());
  if (mismatch) return lobby.showError(mismatch);
  let game;
  try {
    if (!(await acceptMap(replay))) return;
    game = records.newGame(Game, replay);
  } catch (err) {
    return lobby.showError(`Could not load the save: ${err.message ?? err}`);
  }
  applyColors(replay.options.players);
  // The recording goes on from the save's frames.
  const recorder = new records.Recorder({ ...replay, frames: replay.frames, hashes: replay.hashes, createdAt: Date.now() });
  const local = new records.LocalDriver(game, { player: replay.player, recorder, preload: replay });
  start(game, { stress: false, tickMs: SPEEDS[replay.options.gameSpeed] ?? SPEEDS.normal, player: replay.player, local, recorder });
}

/** Open the replay viewer. */
async function watchReplay(replay, lobby) {
  if (!renderer || !records) return;
  const mismatch = records.engineMismatch(replay, version());
  if (mismatch) return lobby.showError(mismatch);
  let controller;
  try {
    if (!(await acceptMap(replay))) return;
    controller = new records.ReplayController(Game, replay);
  } catch (err) {
    return lobby.showError(`Could not open the replay: ${err.message ?? err}`);
  }
  applyColors(replay.options.players);
  start(controller.game, {
    stress: false,
    tickMs: SPEEDS[replay.options.gameSpeed] ?? SPEEDS.normal,
    player: 0,
    replay: controller,
    viewer: viewerPlayers(replay.options.players),
  });
}

function startStress(seed, units, lobby) {
  if (!renderer) return;
  const n = Math.max(100, Math.min(200000, units || 10000));
  const size = Math.max(96, Math.ceil(Math.sqrt(n) * 2.2));
  try {
    start(Game.new_stress(seed >>> 0, n, size), { stress: true, tickMs: SPEEDS.normal });
  } catch (err) {
    lobby.showError(`Could not start the stress test: ${err.message ?? err}`);
  }
}

// `player` and `online` are set for online games (see setupOnline): the
// lockstep driver then decides when the simulation ticks and there is no pause.
// `local` (js/replay.js LocalDriver) runs and records skirmish games, `replay`
// (ReplayController) plays a replay back; `viewer` (the players' names and
// colours) turns the screen into a spectator view: no sidebar, no orders, the
// observer panel with the view switcher and stats.
function start(game, { stress, tickMs, player = PLAYER, online = null, local = null, replay = null, recorder = null, viewer = null }) {
  $('menu').hidden = true;
  $('records-entry').hidden = true;
  // The game's own arrow everywhere in the game screen (sidebar included);
  // the battlefield canvas sets its cursor per frame (js/input.js).
  $('app').style.cursor = CURSORS.select;
  // The lobby's "Play online" entry must not float over the game (any mode).
  const onlineEntry = $('online-button');
  if (onlineEntry) onlineEntry.hidden = true;
  $('app').hidden = false;
  const rules = JSON.parse(game.rules_json());
  // The chrome follows the local player's side: steel blue Allies, red Soviets (css/theme.css).
  document.documentElement.dataset.faction = rules.players?.[player]?.side === 1 ? 'soviet' : 'allies';
  audio?.attachGame({ game, rules, player, worldUnitsPerCell: Game.world_units_per_cell() });
  // Orders and production clicks made through `ui` get unit replies and announcements.
  // Spectators and replays look around and select, but cannot give orders.
  const watched = audio ? audio.watch(game) : game;
  const ui = viewer && records ? records.viewOnly(watched) : watched;
  // Whose eyes the screen uses: the player, or for viewers the whole map or one player.
  const view = { player: viewer && records ? records.OBSERVER_VIEW : player };
  const busy = () => !!(local?.loading || online?.driver.catchingUp || replay?.seeking);
  const atlas = buildAtlas(rules.actors);
  renderer.setAtlas(atlas);
  // Animated building layers (art/animated.js): the engine draws them, the GPU picks the frame.
  game.set_building_overlays(atlas.overlays);
  const animClock = new AnimClock();
  animClock.watchReducedMotion();
  // Health bars besides the selection and the hovered actor (game menu, Settings).
  const HEALTH_BARS = { off: 0, damaged: 1, all: 2 };
  game.set_health_bars(HEALTH_BARS[settings.get('healthBars')] ?? 0);
  settings.subscribe('healthBars', (v) => game.set_health_bars(HEALTH_BARS[v] ?? 0));
  // Mobile GPUs: the player caps the pixel ratio or picks low quality (game menu, Settings).
  renderer.pixelRatio = () => renderPixelRatio(window.devicePixelRatio || 1, settings.get('pixelRatioCap'), settings.get('lowQuality'));
  // Phone layouts (js/layout.js): the sidebar becomes a drawer, the HUD gets compact.
  const layout = new Layout({ app: $('app'), toggle: $('sidebar-toggle') });
  renderer.setMapSize(game.map_width(), game.map_height());

  let sidebar = null;
  let powerBar = null;
  let commandBar = null;
  let touch = null;
  const placementEnded = () => {
    sidebar?.setPlacing(null);
    layout.setPlacing(false);
    touch?.update();
  };
  const input = new Input($('view'), ui, rules, player, {
    onPowerTargeting: (key) => {
      powerBar?.setTargeting(key);
      if (key) audio?.selectTarget();
    },
    onSelectionChanged: (ids) => {
      audio?.selection(ids);
      sidebar?.setSelection(selectionInfo(game, ids));
      sidebar?.setDeployState(input.deployState());
      commandBar?.update();
    },
    // Command bar (js/commandbar.js): armed modes and Ctrl / Alt / Shift clicks.
    commandMouseDown: (w, e) => commandBar?.mouseDown(w, e) ?? false,
    commandClick: (w, mods) => commandBar?.click(w, mods) ?? false,
    commandCursor: (w, mods) => commandBar?.cursor(w, mods) ?? null,
    cancelCommand: () => commandBar?.cancel() ?? false,
    queuesAttackMove: (shift) => commandBar?.queuesAttackMove(shift) ?? shift,
    onPlaced: placementEnded,
    onCancelPlace: placementEnded,
    onNumpad: (slot, opts) => sidebar?.activateSlot(slot, opts),
    onTab: (dir) => sidebar?.cycleTab(dir),
    onSellMode: (on) => sidebar?.setSellMode(on),
    onMenu: () => menu.open(),
  });
  // Spectators and replays have no sidebar (and no sidebar drawer on phones).
  if (viewer) $('app').classList.add('viewer');
  sidebar = new Sidebar(
    $('sidebar'),
    ui,
    rules,
    player,
    {
      onPlace: (id) => {
        input.startPlacing(id);
        sidebar.setPlacing(id);
        layout.setPlacing(true);
        touch?.update();
      },
      onCancelPlace: () => {
        input.placing = null;
        placementEnded();
      },
      shiftLatched: () => !!touch?.queue,
      onSell: () => input.toggleSellMode(),
      onDeploy: () => input.deploySelection(),
      onMenu: () => menu.toggle(),
    },
    { ticksPerSecond: Game.ticks_per_second() },
  );
  // Radar minimap in the sidebar's radar slot (js/minimap.js); the stress
  // test leaves the slot empty, which shows "Radar offline".
  const minimap = stress ? null : new Minimap($('radar'), { game: ui, memory: wasm.memory, player, input, colors: TEAM_COLORS });
  // Touch and pen (js/touch.js): gestures on the battlefield, the touch action
  // bar and placement buttons, long press on sidebar cards.
  touch = new TouchControls({ canvas: $('view'), field: $('field'), input, hotkeys });
  touch.bindSidebar($('sidebar'), (id) => sidebar.onCardCancel(id));
  // Announcer lines as text at the bottom of the battlefield (shown with sound off too).
  const notices = new NotificationView($('field'));
  audio?.onAnnounce((key) => notices.announce(key));
  // Support power bar (js/powers.js): pick a ready power, then a target on the map.
  powerBar = new PowerBar($('field'), {
    ticksPerSecond: Game.ticks_per_second(),
    onSelect: (power) => input.startPowerTargeting(power),
    onTargetLost: () => input.cancelPower(),
  });
  // Command bar (js/commandbar.js): orders, modes and fire stances for the selection.
  commandBar = new CommandBar($('field'), { game: ui, input, player, hotkeys });
  // Spectators and replays give no orders: no power bar, no command bar.
  if (viewer) {
    powerBar.root.hidden = true;
    commandBar.root.hidden = true;
  }
  // Debug menu (js/debug.js): cheats when the game allows them, local views, stepping while paused.
  let paused = false;
  const debug = new DebugMenu($('field'), {
    game,
    input,
    player,
    rules,
    colors: TEAM_COLORS,
    online: !!online,
    tickMs,
    memory: wasm.memory,
    isPaused: () => paused,
    setPaused: online || replay ? undefined : (on) => {
      paused = on;
    },
    step: () => {
      if (!paused || online || replay || busy()) return false;
      if (local) local.tick();
      else game.tick();
      return true;
    },
  });
  // Observer panel and replay controls (js/observer.js, js/records.js).
  let observer = null;
  let replayBar = null;
  if (viewer && records) {
    observer = new records.ObserverPanel($('field'), {
      players: viewer,
      view: view.player,
      onView: (v) => {
        view.player = v;
        input.player = v === records.OBSERVER_VIEW ? 0 : v;
      },
    });
  }
  if (replay && records) replayBar = new records.ReplayBar($('field'), replay);
  const progress = records ? new records.ProgressOverlay($('field')) : null;
  // HUD buttons in one row at the top right: Debug, Build / Map (phones), Menu.
  $('sidebar-toggle').before(debug.button);
  // Handle for debugging from the browser console.
  window.webra = { game, input, sidebar, powerBar, commandBar, minimap, renderer, wasm, rules, debug, touch, layout, notices, local, replay, recorder };
  const [sx, sy] = game.start_position(player);
  input.centerOn(sx, sy);
  if (stress) input.camera.zoom = 1;

  // ---- Game menu and pause -------------------------------------------------------
  // Esc (js/input.js), F10, the HUD button, and in single player P / Pause open
  // the menu (js/gamemenu.js). Single player pauses while it is open; online
  // games cannot pause (the lockstep server drops a player who holds the game
  // up), so there the menu opens over the running game. The debug menu can
  // also pause a local game without the menu (`paused` is declared above).
  let leaving = false;
  const leave = () => {
    leaving = true;
    online?.onQuit();
    replay?.dispose();
    location.reload();
  };
  const exit = () => {
    leaving = true;
    online?.onQuit();
    location.href = new URL('../', location.href).href;
  };
  // Saves and replays (js/records.js): what the game menu and the game over screen offer.
  const recordActions = records && recorder ? records.recordActions({ game, recorder, local, stress, showToast }) : [];
  const fullscreen = {
    available: () => fullscreenAvailable(),
    active: () => isFullscreen(),
    toggle: () => toggleFullscreen(),
  };
  const menu = new GameMenu($('game-menu'), {
    online: !!online || !!replay,
    replay: !!replay,
    actions: recordActions,
    hotkeys,
    settings,
    fullscreen,
    onChange: (open, isPaused) => {
      input.setSuspended(open);
      if (open) touch.reset();
      paused = isPaused;
      $('menu-button').textContent = open ? 'Resume' : 'Menu';
    },
    onSound: audioPanel ? () => audioPanel.open() : undefined,
    onReleaseNotes: () => releaseNotes.open(),
    onLeave: leave,
    onExit: exit,
  });
  $('menu-button').hidden = false;
  $('menu-button').addEventListener('click', () => menu.toggle());
  $('again').addEventListener('click', leave);
  hotkeys.registerAction('debugMenu', '`', () => debug.toggle(), { label: 'Debug menu', group: 'Game' });
  hotkeys.registerAction('menu', 'F10', () => menu.toggle(), { label: 'Game menu (Esc also opens it)', group: 'Game' });
  if (replay) hotkeys.registerAction('pause', ['Pause', 'P'], () => replay.togglePlay(), { label: 'Pause (replays: play and pause)', group: 'Game' });
  else if (!online) hotkeys.registerAction('pause', ['Pause', 'P'], () => menu.toggle(), { label: 'Pause (opens the menu)', group: 'Game' });
  // OpenRA has no default key for its path lines; L is free in WebRA's set.
  hotkeys.registerAction(
    'showUnitPaths',
    'L',
    () => {
      const on = settings.set('showUnitPaths', !settings.get('showUnitPaths'));
      showToast(on ? 'Unit paths shown' : 'Unit paths hidden');
    },
    { label: 'Show unit paths', group: 'Game' },
  );
  hotkeys.registerAction(
    'fullscreen',
    'Alt+Enter',
    async () => {
      const r = await fullscreen.toggle();
      if (!r.ok) showToast(r.message);
    },
    { label: 'Fullscreen', group: 'Game' },
  );
  // Production tabs, OpenRA's Red Alert keys (E R T Y U I), and Tab / Shift+Tab to cycle.
  ['Buildings', 'Defense', 'Infantry', 'Vehicles', 'Aircraft', 'Naval'].forEach((name, q) => {
    hotkeys.registerAction(`productionTab${name}`, 'ERTYUI'[q], () => sidebar.selectTab(q), { label: `${name} tab`, group: 'Production' });
  });
  // Not while a button has focus, so Tab still moves between the sidebar's buttons there.
  hotkeys.registerAction('nextTab', 'Tab', () => sidebar.cycleTab(1), { label: 'Next production tab', group: 'Production', inControls: false });
  hotkeys.registerAction('previousTab', 'Shift+Tab', () => sidebar.cycleTab(-1), { label: 'Previous production tab', group: 'Production', inControls: false });
  // Fullscreen changes the canvas size; the renderer and input follow it each
  // frame, the toast says when the browser refused.
  onFullscreenChange(() => {
    if (menu.isOpen) menu.render();
  });
  // A single-player game opens the menu (and so pauses) when its tab is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !stress && !online && !replay) menu.open();
  });
  const replayButton = $('gameover-replay');
  const download = recordActions.find((a) => a.id === 'replay');
  if (replayButton && download) {
    replayButton.hidden = false;
    replayButton.addEventListener('click', () => showToast(download.run()));
  }
  // Leaving the page by accident (a browser shortcut, a misclick) loses the game: ask first.
  if (!stress && !replay) {
    window.addEventListener('beforeunload', (e) => {
      if (leaving || over) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  let acc = 0;
  let last = performance.now();
  let simMs = 0;
  let fpsFrames = 0;
  let fpsTime = last;
  let fps = 0;
  let uiTime = 0;
  let over = false;

  function frame(now) {
    const dt = Math.min(now - last, 250);
    last = now;
    let alpha = paused ? 1 : acc / tickMs;
    let simFrameMs = 0;
    if (online || replay) {
      const t0 = performance.now();
      const r = online ? online.driver.advance(dt) : replay.advance(dt, tickMs);
      simFrameMs = performance.now() - t0;
      if (r.ticks > 0 && !busy()) simMs = simMs * 0.9 + (simFrameMs / r.ticks) * 0.1;
      alpha = r.alpha;
    } else if (local?.loading) {
      // Loading a save: re-simulate it within a time budget per frame.
      if (local.load()) {
        acc = 0;
        if (local.error) {
          leaving = true;
          showToast(local.error);
          setTimeout(() => location.reload(), 4000);
        }
      }
    } else if (!paused) {
      acc += dt;
      let ticks = 0;
      const t0 = performance.now();
      while (acc >= tickMs && ticks < MAX_TICKS_PER_FRAME) {
        if (local) local.tick();
        else game.tick();
        acc -= tickMs;
        ticks++;
      }
      simFrameMs = performance.now() - t0;
      if (ticks > 0) simMs = simMs * 0.9 + (simFrameMs / ticks) * 0.1;
      if (ticks === MAX_TICKS_PER_FRAME) acc = 0; // too slow: drop time instead of spiralling
      alpha = acc / tickMs;
    }

    const catching = busy();
    progress?.show(catching ? progressText() : null);
    if ((catching || menu.isOpen) !== input.suspended) input.setSuspended(catching || menu.isOpen);
    input.update(dt / 1000);
    if (game.terrain_dirty()) {
      const ptr = game.terrain_ptr();
      const terrain = new Uint8Array(wasm.memory.buffer, ptr, game.terrain_len());
      renderer.uploadTerrain(terrain);
      minimap?.terrainChanged(terrain);
    }
    const fogPtr = game.fog_ptr(view.player);
    renderer.uploadFog(new Uint8Array(wasm.memory.buffer, fogPtr, game.fog_len()));
    // Sounds of what happened this frame, heard from the camera (fog hides enemy sounds).
    // Fast-forwarding (loading, rejoining, seeking) stays silent.
    if (catching) game.take_audio_events();
    else audio?.frame(input.viewRect(), () => new Uint8Array(wasm.memory.buffer, fogPtr, game.fog_len()));

    // UI rects call into wasm (placement preview), which may grow its memory and
    // detach existing views, so collect them before taking views of wasm memory.
    const renderStart = performance.now();
    const uiRects = input.uiRects();
    commandBar.frame();
    const v = input.viewRect();
    const spriteCount = game.build_render(view.player, alpha, v.x0, v.y0, v.x1, v.y1);
    // "Show unit paths" (Esc menu setting): routes of the selected units (8 floats per segment).
    const lineCount = settings.get('showUnitPaths') ? game.build_paths(view.player, alpha) : 0;
    const sprites = new Float32Array(wasm.memory.buffer, game.sprite_ptr(), spriteCount * 8);
    const lines = lineCount ? new Float32Array(wasm.memory.buffer, game.path_ptr(), lineCount * 8) : null;
    const simRectCount = game.rect_count();
    const rects = new Float32Array(simRectCount * 8 + uiRects.length);
    rects.set(new Float32Array(wasm.memory.buffer, game.rect_ptr(), simRectCount * 8));
    rects.set(uiRects, simRectCount * 8);
    // Building animations run on wall time but stop with the game (and for reduced motion).
    animClock.advance(dt, paused);
    renderer.draw(input.camera, now / 1000, sprites, spriteCount, rects, rects.length / 8, animClock.uniform(), lines, lineCount);
    // After drawing: the debug views call into wasm, which may detach the views above.
    debug.frame({ frameMs: dt, renderMs: performance.now() - renderStart, simFrameMs, simMs, fps });
    minimap?.frame(now);

    fpsFrames++;
    if (now - fpsTime >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsTime);
      fpsFrames = 0;
      fpsTime = now;
    }
    if (now - uiTime >= 100) {
      uiTime = now;
      input.refreshSelection();
      const state = JSON.parse(game.player_json(player));
      if (!viewer) {
        sidebar.update(state);
        powerBar.update(state.powers ?? []);
        commandBar.update();
        audio?.playerState(state);
        sidebar.setSelection(selectionInfo(game, input.selection));
        sidebar.setDeployState(input.deployState());
      }
      observer?.update(JSON.parse(game.observer_stats()), game.tick_count());
      replayBar?.update();
      updateHud(game, state, fps, simMs, stress, paused, layout.compact, replay ? 'Replay' : online?.spectator ? 'Spectating' : null);
      touch.update();
      debug.update(state);
      if (!over && !stress && !viewer && (state.won || state.defeated || (state.winner !== null && state.winner !== undefined))) {
        over = true;
        $('gameover-title').textContent = state.won ? 'Mission accomplished' : 'Mission failed';
        $('gameover').hidden = false;
        audio?.gameOver(!!state.won);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function progressText() {
    if (local?.loading) return `Loading the saved game... ${Math.round(local.progress() * 100)}%`;
    if (online?.driver.catchingUp) {
      const d = online.driver;
      return d.waitingSync ? 'Joining the game...' : `Catching up with the game... ${Math.round(d.progress() * 100)}%`;
    }
    if (replay?.seeking) return `Seeking... ${records.formatTicks(replay.target)}`;
    return null;
  }
}

function selectionInfo(game, ids) {
  if (ids.length === 0) return null;
  if (ids.length === 1) return JSON.parse(game.actor_json(ids[0]));
  return { count: ids.length, name: `${ids.length} units selected` };
}

function updateHud(game, state, fps, simMs, stress, paused, compact, mode = null) {
  const units = stress ? game.actor_count() : 0;
  const hud = hudText({ paused, fps, simMs, stress, units, flowFields: state.flowFields }, compact);
  // Spectators and replays say so in front.
  const text = mode ? `${mode}  |  ${hud}` : hud;
  if ($('hud').textContent !== text) $('hud').textContent = text;
}

boot();

/** Short message over the battlefield (for example when fullscreen is refused). */
function showToast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    box.hidden = true;
  }, 4000);
}
