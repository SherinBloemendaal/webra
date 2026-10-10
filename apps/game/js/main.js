// Boot: load the simulation (WebAssembly), the WebGPU renderer and the lobby,
// then run the fixed-step game loop with interpolated rendering.
//
// Every game is recorded (js/replay.js): skirmish through a local lockstep
// driver, online games through the network driver. The game menu saves
// skirmish games (browser storage or a file) and downloads replays; the
// lobby's Load game and Replays buttons (js/records.js) load them again.
// Spectators and the replay viewer watch with the observer panel
// (js/observer.js): whole map or one player's view, and player stats.
// When the local player is defeated or wins, js/endgame.js shows what
// happened (single player pauses meanwhile); a defeated player can watch on
// as a spectator. The end-game statistics (js/stats.js) come from the engine
// and show at the end, for spectators and in replays. Restart (js/restart.js)
// plays a single player game again with the same settings.
//
// The simulation (the wasm Game, its driver, the recorder) runs in a Web
// Worker when the browser allows it (js/sim): the UI talks to a game handle
// with the Game's method names, and the loop draws the newest frame the
// worker sent, so ticks never block rendering or input.

import init, { Game, base_rules_json, version } from '../pkg/webra_sim.js';
import { NEUTRAL_COLOR, Renderer, TEAM_COLORS, TEAM_PALETTE } from './renderer.js';
import { buildAtlas } from './sprites.js';
import { AnimClock } from './anim.js';
import { Input } from './input.js';
import { Sidebar } from './sidebar.js';
import { PowerBar } from './powers.js';
import { CommandBar } from './commandbar.js';
import { registerGameKeys } from './gamekeys.js';
import { RadarPings } from './radarpings.js';
import { Lobby } from './lobby.js';
import { AudioSystem } from './audio/index.js';
import { NO_PLAYER } from './audio/director.js';
import { mountAudioPanel } from './audio/panel.js';
import { mountMusicPanel } from './audio/musicplayer.js';
import { CURSORS, setCursorArt, tickCursors } from './cursors.js';
import { hotkeys, formatCombo } from './hotkeys.js';
import { settings } from './settings.js';
import { GameMenu } from './gamemenu.js';
import { fullscreenAvailable, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen.js';
import { MouseCapture, pointerLockAvailable } from './mouselock.js';
import { DebugMenu } from './debug.js';
import { chooseInstancePath } from './crowd.js';
import { NotificationView } from './notifications.js';
import { BattleFx, motionReduced } from './battlefx.js';
import { AttackMoveTip, TipView } from './hints.js';
import { importOramap } from './oramap/index.js';
import { Minimap } from './minimap.js';
import { mountReleaseNotes } from './releasenotes-dialog.js';
import { TouchControls } from './touch.js';
import { Layout, hudText, renderPixelRatio } from './layout.js';
import { attachHudTooltips } from './hudtips.js';
import { hideTooltip } from './ui/tooltip.js';
import { UiScale, resolveGameScale, screenOf, watchPixelRatio } from './scale.js';
import { buildTerrainAtlas, cellTiles } from './art/terrain.js';
import { ContentSystem } from './content/index.js';
import { mountContentPanel, mountContentNotice } from './content/panel.js';
import { shouldShowNotice, canAutoInstall } from './content/download.js';
import { AccountSession } from './account/session.js';
import { askConflict, mountAccountEntry, openSignIn } from './account/ui.js';
import { PlayAccess, PlayAccessLost } from './account/gate.js';
import { defaultRegistry } from './registry.js';
import { setCameoArt } from './cameo.js';
import { RECIPES } from './audio/synth.js';
import { allOriginalNames } from './audio/catalog.js';
import { NO_EFFECT, WeatherFx, weatherInfo } from './weather-fx.js';
import { createSimHost } from './sim/host.js';
import { DriverHandle, RecorderHandle, ReplayHandle } from './sim/proxy.js';
import { askOf } from './sim/methods.js';
import { COMBINED_VIEW, ObserverPanel, OBSERVER_VIEW, viewOnly } from './observer.js';
import { EndGameDialog, EndGameFlow } from './endgame.js';
import { StatsScreen } from './stats.js';
import { restartRecord, saveRestart, takeRestart } from './restart.js';

const PLAYER = 0;

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
/** The engine compiled once: the page and the simulation worker instantiate it. */
let wasmModule = null;
let renderer;
/** js/replay.js and js/records.js (recording, saves, replays), or null when they failed to load. */
let records = null;
// Sound (js/audio): synthesized by default, original files when the player installed them.
let audio = null;
/** The Sound dialog (js/audio/panel.js), also opened from the game menu. */
let audioPanel = null;
/** Release notes dialog (js/releasenotes-dialog.js): lobby, game menu and "What's new". */
let releaseNotes = null;
// Installed content (js/content): original graphics from the player's own copy and texture packs.
let content = null;
/** The Original content dialog (js/content/panel.js), also opened from the game menu and the Sound dialog. */
let contentPanel = null;
/** The start screen notice about the original content (js/content/panel.js), while shown. */
let contentNotice = null;
/** The signed-in account (js/account/session.js): online play, settings sync, the one-click content install. */
let account = null;
/**
 * Loads of game files after the start (lazy modules, the simulation worker):
 * when the server stops serving them mid-session (js/account/gate.js), the
 * player gets a sign-in prompt; the running game is not touched.
 */
const playAccess = new PlayAccess({ onLost: playAccessLost });
/** The page's UI scale (js/scale.js): follows the setting and the screen, previewed by the game menu. */
let uiScale = null;

async function boot() {
  let gpuError = null;
  try {
    wasm = await loadEngine();
  } catch (err) {
    gpuError = `Could not load the game engine: ${err.message}`;
  }
  $('version').textContent = wasm ? `v${version()}` : '';
  // UI scale first, so every screen and dialog opens at its size.
  uiScale = new UiScale({ settings, win: window, root: document.documentElement });
  setupAudio();
  setupAccount();
  setupContent();
  releaseNotes = mountReleaseNotes($('release-notes'), { version: wasm ? version() : null });
  const lobby = new Lobby($('menu'), {
    colors: TEAM_COLORS,
    colorNames: COLOR_NAMES,
    mapPreview: (seed, size) => Game.map_preview(seed, size),
    // Skirmish lobby: previews per player count and map files.
    maps: {
      preview: (seed, size, players, style = 'random', biome = 'temperate') => Game.map_preview_styled(seed, size, players, style, biome),
      // "Rivers, Snow": the style and biome a seed gives a generated map.
      describe: (seed, style, biome) => `${capitalize(Game.resolved_style(seed, style))}, ${capitalize(Game.resolved_biome(seed, biome))}`,
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
  // Restart (js/restart.js): the game the page was reloaded for, with the same settings.
  const again = takeRestart(sessionStore());
  if (again && !gpuError && renderer) startSkirmish(again.options, lobby);
  else offerLinkedMap(lobby);
  // Once per new version: what changed since this browser last played.
  releaseNotes.showWhatsNewOnce();
}

/** Compile the engine (kept for the simulation worker) and instantiate it for the lobby. */
async function loadEngine() {
  const url = new URL('../pkg/webra_sim_bg.wasm', import.meta.url);
  try {
    wasmModule = await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // Served without the wasm MIME type: compile from the bytes.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wasmModule = await WebAssembly.compile(await res.arrayBuffer());
  }
  return init({ module_or_path: wasmModule });
}

/** Where the next game's simulation runs (js/sim/host.js): a worker if possible. */
function newSimHost() {
  return playAccess.load(() => createSimHost({ Game, memory: () => wasm.memory, module: wasmModule }));
}

/** The game files were refused (js/account/gate.js): sign in again, or see why on the account page. */
async function playAccessLost(state) {
  if (state === 'signin' && account) {
    await openSignIn(account, {
      reason: 'Your sign-in has ended, so the game cannot load the rest of its files. Sign in again to go on; the game that is running keeps running.',
      returnTo: location.pathname + location.search,
    });
    return;
  }
  showToast(state === 'signin' ? 'Your sign-in has ended. Sign in on the account page to go on playing.' : 'Your account cannot load the game right now. The account page says why.');
}

/** The message for a load that failed: the sign-in prompt already explains a refusal. */
function loadErrorText(err) {
  return err instanceof PlayAccessLost ? err.message : (err?.message ?? String(err));
}

/**
 * Recording, saves and replays. They load as modules of their own, so a
 * problem there leaves plain skirmish playable (without recording).
 */
async function setupRecords(lobby, gpuError) {
  try {
    const [replay, ui, protocol] = await playAccess.load(() => Promise.all([import('./replay.js'), import('./records.js'), import('./protocol.js')]));
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
    // The music player opens from the Sound dialog (start screen and in games) and the game menu.
    const musicPanel = mountMusicPanel($('music-panel'), audio, { onContent: () => contentPanel?.open() });
    audioPanel = mountAudioPanel($('audio-button'), $('audio-panel'), audio, { onContent: () => contentPanel?.open(), onMusicPlayer: () => musicPanel.open($('audio-button')) });
  } catch (err) {
    // The game stays playable without sound.
    console.warn('Sound is unavailable:', err);
    audio = null;
  }
}

/**
 * The account (js/account): who is signed in, what the site allows, and the
 * settings sync. The game works the same signed out; only online play may
 * need an account (site setting).
 */
function setupAccount() {
  try {
    account = new AccountSession({ registry: defaultRegistry(), storage: browserStorage(), onConflict: askConflict, win: window });
    mountAccountEntry($('account-entry'), account);
    // The one-click content install follows the account (the server decides: canUseContentRelay).
    account.onChange(() => {
      const allowed = canAutoInstall(account.user);
      contentPanel?.setAutoInstall(allowed);
      contentNotice?.setAutoInstall(allowed);
    });
    // Back from Discord (#discord=ok or #discord=error&code=...): say how it went, then clean the address.
    const discord = /^#discord=(ok|error)(?:&code=([a-z_]{1,32}))?$/.exec(location.hash);
    if (discord) {
      history.replaceState(null, '', location.pathname + location.search);
      if (discord[1] === 'error') showToast(`Discord sign-in did not work (${discord[2] ?? 'unknown'}). Try again, or use the account page.`);
    }
    account.refresh();
    // Back on the tab: settings changed on another device arrive.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && account.user) account.sync?.flush().catch(() => {});
    });
  } catch (err) {
    console.warn('Accounts are unavailable:', err);
    account = null;
  }
}

/** This tab's sessionStorage, or null when the browser blocks it. */
function sessionStore() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The restart record of a single player game (js/restart.js), or null when it cannot have one. */
function restartOf(options) {
  try {
    return restartRecord(options);
  } catch {
    return null;
  }
}

/** This page's localStorage, or null when the browser blocks it. */
function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Original graphics and texture packs (js/content), loaded into memory ahead
 * of the first game so the game can build its art at once. The game plays
 * the same without them.
 */
function setupContent() {
  try {
    const actors = wasm ? JSON.parse(base_rules_json()).actors ?? [] : [];
    const known = {
      actors: new Set(actors.map((a) => String(a.id).toUpperCase())),
      sounds: new Set([...Object.keys(RECIPES), ...allOriginalNames()]),
    };
    content = new ContentSystem({ settings, known });
    contentPanel = mountContentPanel($('content-button'), $('content-panel'), content, audio, {
      actorNames: new Map(actors.map((a) => [String(a.id).toUpperCase(), a.name ?? a.id])),
      autoInstall: canAutoInstall(account?.user ?? null),
    });
    const sync = () => {
      setCameoArt(content.cameos());
      // Red Alert's own mouse cursors when the original graphics are in use (cursors.js).
      setCursorArt(content.cursors());
      audio?.setPackSounds(content.packSounds()).catch((err) => console.warn('Texture pack sounds are unavailable:', err));
    };
    content.onChange(sync);
    // The notice goes once something is installed (here or from another tab's dialog).
    content.onChange(() => {
      if (!contentNotice?.open) return;
      content
        .summary()
        .then((s) => s.total > 0 && contentNotice.close())
        .catch(() => {});
    });
    content
      .load()
      .then(async () => {
        // Start screen: how to get the original content, until installed or dismissed.
        const installed = (await content.summary()).total > 0;
        if ($('app').hidden && shouldShowNotice({ installed, registry: defaultRegistry() })) {
          contentNotice = mountContentNotice(document.body, {
            registry: defaultRegistry(),
            onFiles: (files) => dropContent(files),
            onOpen: () => contentPanel.open(),
            onDownload: () => contentPanel.download(),
            autoInstall: canAutoInstall(account?.user ?? null),
          });
        }
      })
      .catch((err) => console.warn('Installed content is unavailable:', err));
    setupContentDrop();
  } catch (err) {
    console.warn('Original content and texture packs are unavailable:', err);
    content = null;
  }
}

/**
 * Drag and drop of Red Alert files (ra-quickinstall.zip, CD images, .mix files) and
 * texture packs onto the lobby or the game: they go to the Original content
 * dialog. Other drops are left alone.
 */
function setupContentDrop() {
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  const show = (on) => document.body.classList.toggle('content-drop', on);
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    show(true);
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    depth = 0;
    show(false);
    e.preventDefault();
    const files = [...(e.dataTransfer.files ?? [])];
    await dropContent(files);
  });
}

/** Install dropped or picked files through the Original content dialog (progress and result show there). */
async function dropContent(files) {
  try {
    if (!(await contentPanel?.drop(files))) showToast('Drop ra-quickinstall.zip, a freeware Red Alert CD image (.iso), Red Alert .mix files or a texture pack here.');
  } catch (err) {
    showToast(`Could not read the files: ${err.message ?? err}`);
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
    const { loadPendingMap } = await playAccess.load(() => import('./maploader.js'));
    const map = await loadPendingMap(params);
    if (map) lobby.offerMapText(JSON.stringify(map), params.get('editorTest') === '1' ? 'editor' : 'link');
  } catch (err) {
    lobby.reportMapProblem(loadErrorText(err));
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
      const { mountOnline } = await playAccess.load(() => import('./online.js'));
      ui = mountOnline(root, {
        Game,
        version: version(),
        createGame: createOnlineGame,
        colors: TEAM_COLORS,
        colorNames: COLOR_NAMES,
        // A host shares .oramap maps too: converted like in the skirmish lobby, checked by the engine.
        importOramap: (bytes, fileName) =>
          importOramap(bytes, {
            baseRules: JSON.parse(base_rules_json()),
            validate: (json) => JSON.parse(Game.validate_map(json)),
            fileName,
          }),
        account: account ? { session: account, signIn: (reason) => openSignIn(account, { reason }) } : undefined,
        // OpenRA's lobby and chat sounds (ChatLine, PlayerJoined, PlayerLeft, LobbyOptionChanged).
        sounds: audio ? { chatLine: () => audio.chatLine(), lobby: (event) => audio.lobby(event) } : undefined,
        onBack: () => {
          root.hidden = true;
          $('menu').hidden = false;
          entry.hidden = false;
        },
        onStartGame: ({ host, player, driver, options, onQuit, recorder = null, spectator = false, rematch = null, save = null }) => {
          entry.hidden = true;
          applyColors(options.players);
          start(host, {
            stress: false,
            tickMs: driver.tickMs,
            player: spectator ? 0 : player,
            online: { driver, onQuit, spectator, rematch, save },
            recorder,
            viewer: spectator ? viewerPlayers(options.players) : null,
            roster: viewerPlayers(options.players),
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

/**
 * The simulation of an online game (js/online.js): the LockstepDriver runs
 * where the game runs; `driver` forwards the network to it and sends what it
 * sends on `conn`.
 */
async function createOnlineGame({ spec, conn, onCaughtUp, onCheck }) {
  const host = await newSimHost();
  let info;
  try {
    info = await host.start(spec);
  } catch (err) {
    host.dispose();
    throw err;
  }
  const driver = new DriverHandle(host, conn, { tickMs: spec.tickMs, onCaughtUp, onCheck });
  const recorder = info.recorder ? new RecorderHandle(host, info.recorder.start) : null;
  return { host, game: host.game, driver, recorder };
}

/** Whether this tab was in an online game before a reload (js/online.js keeps the rejoin key per tab). */
function hasRejoinRecord() {
  try {
    return sessionStorage.getItem('webra.rejoin.v1') !== null;
  } catch {
    return false;
  }
}

/** Names and colours of the players in a game's options, for the observer panel and the statistics. */
function viewerPlayers(players) {
  return players.map((p, i) => ({
    name: p.type === 'human' ? p.name || `Player ${i + 1}` : p.name || `Computer (${p.difficulty})`,
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
  // From the colours as they start: the last game may have recoloured a slot (its neutral player).
  const palette = TEAM_PALETTE.map((c) => c.slice());
  const used = new Set(players.map((p) => p.color));
  const rest = palette.map((_, i) => i).filter((i) => !used.has(i));
  players
    .map((p) => p.color)
    .concat(rest)
    .forEach((src, dst) => {
      TEAM_COLORS[dst] = palette[src];
    });
}

/** Only one game starts at a time (starting is asynchronous: the simulation worker loads first). */
let starting = false;

/**
 * Start a game's simulation (js/sim/host.js) from a js/sim/core.js start spec.
 * Returns `{ host, info }`, or null after showing `failText` and the error.
 */
async function launch(spec, lobby, failText) {
  if (starting) return null;
  starting = true;
  let host = null;
  try {
    // Installed graphics are read before the first frame, so a game never starts with WebRA art for a moment.
    await content?.load();
    host = await newSimHost();
    const info = await host.start(spec);
    return { host, info };
  } catch (err) {
    host?.dispose();
    lobby.showError(`${failText}: ${loadErrorText(err)}`);
    return null;
  } finally {
    starting = false;
  }
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
  // starts exactly like this game. The recorder runs with the simulation.
  let engineOptions = resolved;
  let recording = null;
  let canonicalMap = map ?? null;
  if (records) {
    try {
      engineOptions = records.replayOptions(resolved);
      if (map) canonicalMap = Game.map_canonical(map);
      recording = {
        mode: 'skirmish',
        options: engineOptions,
        map: canonicalMap,
        mapHash: canonicalMap ? Game.map_hash(canonicalMap) : null,
        player,
        engine: version(),
        title: skirmishTitle(engineOptions, player),
      };
    } catch (err) {
      console.warn('This game is not recorded:', err.message ?? err);
      engineOptions = resolved;
      canonicalMap = map ?? null;
      recording = null;
    }
  }
  const tickMs = SPEEDS[resolved.gameSpeed] ?? SPEEDS.normal;
  const run = await launch({ kind: 'skirmish', options: engineOptions, map: canonicalMap, player, recorder: recording, tickMs }, lobby, 'Could not start the game');
  if (!run) return;
  applyColors(playing);
  start(run.host, { stress: false, tickMs, player, recorder: recorderOf(run), roster: viewerPlayers(playing), restart: restartOf(options) });
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
  // An online save continues only online, with its players (js/online.js).
  if (replay.mode === 'online') return lobby.showError('This is a saved online game: resume it with its players from Play online.');
  const mismatch = records.engineMismatch(replay, version());
  if (mismatch) return lobby.showError(mismatch);
  try {
    if (!(await acceptMap(replay))) return;
  } catch (err) {
    return lobby.showError(`Could not load the save: ${err.message ?? err}`);
  }
  const tickMs = SPEEDS[replay.options.gameSpeed] ?? SPEEDS.normal;
  // The recording goes on from the save's frames (js/sim/core.js).
  const run = await launch({ kind: 'save', replay, tickMs }, lobby, 'Could not load the save');
  if (!run) return;
  applyColors(replay.options.players);
  start(run.host, {
    stress: false,
    tickMs,
    player: replay.player,
    recorder: recorderOf(run),
    roster: viewerPlayers(replay.options.players),
    // Restart plays the saved game again from its start, with its settings.
    restart: restartOf({ ...replay.options, map: replay.map ?? null }),
    fromSave: true,
  });
}

/** Open the replay viewer. */
async function watchReplay(replay, lobby) {
  if (!renderer || !records) return;
  const mismatch = records.engineMismatch(replay, version());
  if (mismatch) return lobby.showError(mismatch);
  try {
    if (!(await acceptMap(replay))) return;
  } catch (err) {
    return lobby.showError(`Could not open the replay: ${err.message ?? err}`);
  }
  const tickMs = SPEEDS[replay.options.gameSpeed] ?? SPEEDS.normal;
  const run = await launch({ kind: 'replay', replay, tickMs }, lobby, 'Could not open the replay');
  if (!run) return;
  applyColors(replay.options.players);
  start(run.host, {
    stress: false,
    tickMs,
    player: 0,
    replay: new ReplayHandle(run.host, run.info.replayLength),
    viewer: viewerPlayers(replay.options.players),
  });
}

async function startStress(seed, units, lobby) {
  if (!renderer) return;
  const n = Math.max(100, Math.min(200000, units || 10000));
  const size = Math.max(96, Math.ceil(Math.sqrt(n) * 2.2));
  const run = await launch({ kind: 'stress', seed: seed >>> 0, units: n, size, tickMs: SPEEDS.normal }, lobby, 'Could not start the stress test');
  if (run) start(run.host, { stress: true, tickMs: SPEEDS.normal });
}

/** The game menu's handle on the recorder that runs with the simulation, or null. */
function recorderOf({ host, info }) {
  return info.recorder ? new RecorderHandle(host, info.recorder.start) : null;
}

// `host` runs the simulation (js/sim/host.js): skirmish games and saves with
// a LocalDriver, online games with the LockstepDriver, replays with a
// ReplayController, all where the game runs (a worker when possible).
// `player` and `online` are set for online games (see setupOnline): the
// lockstep driver then decides when the simulation ticks and there is no pause.
// `replay` (ReplayHandle) controls a replay; `recorder` (RecorderHandle) saves
// and downloads; `viewer` (the players' names and colours) turns the screen
// into a spectator view: no sidebar, no orders, the observer panel with the
// view switcher and stats. `roster` names and colours the players of any
// game (statistics, the observer panel after a defeat); `restart` is the
// js/restart.js record of a single player game (null: no restart).
function start(host, { stress, tickMs, player = PLAYER, online = null, replay = null, recorder = null, viewer = null, roster = null, restart = null, fromSave = false }) {
  const game = host.game;
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
  // Relationships (engine World::are_allies): the same player, or the same non-zero team.
  const slots = rules.players ?? [];
  const allies = (a, b) => a === b || (!slots[a]?.neutral && !slots[b]?.neutral && !!slots[a]?.team && slots[a]?.team === slots[b]?.team);
  // The neutral player (civilian and tech buildings, trees, bridges: engine
  // neutral.rs) is drawn in a civilian tan, not a player's colour.
  slots.forEach((slot, i) => {
    if (slot.neutral && TEAM_COLORS[i]) TEAM_COLORS[i] = NEUTRAL_COLOR.slice();
  });
  /** Whether the local player (not a spectator) is allied to `owner`. */
  const allied = (owner) => !viewer && allies(player, owner);
  // Spectators and replays have no player of their own: they hear no player's
  // private notifications (placement, deploy and sell sounds, "Unit ready", ...).
  audio?.attachGame({ game, rules, player: viewer ? NO_PLAYER : player, worldUnitsPerCell: Game.world_units_per_cell(), allied });
  // Engine events (sound_events.rs) feed the sound and the radar pings, with or without sound.
  game.set_audio_events(true);
  // OpenRA StartGameNotification: "Battle control online" (a loaded save says "Game loaded" once it is ready).
  if (!stress && !fromSave) audio?.startGame();
  // Orders and production clicks made through `ui` get unit replies and announcements.
  // Spectators and replays look around and select, but cannot give orders.
  const watched = audio ? audio.watch(game) : game;
  // A defeated player who watches on gives no orders either (js/endgame.js).
  let spectating = false;
  const watching = () => !!viewer || spectating;
  const ui = viewer ? viewOnly(watched) : viewOnly(watched, () => spectating);
  const players = viewer ?? roster ?? [];
  // Whose eyes the screen uses: the player, or for viewers the whole map or one player.
  const view = { player: viewer ? OBSERVER_VIEW : player };
  // Driver state from the newest frame (loading a save, catching up, seeking).
  let status = { busy: false };
  const busy = () => !!status.busy;
  // The map's biome picks the terrain art and the original theater.
  let sky = JSON.parse(game.weather_json());
  let lastSky = null;
  const biome = sky.biome;
  // Sprites: WebRA's own art, or the original graphics and texture packs the
  // player installed (js/content, presentation only). Rebuilt when they change.
  const applyArt = () => {
    const art = content?.art(rules.actors, biome) ?? null;
    let atlas = null;
    let original = null;
    if (art?.slots.size) {
      try {
        atlas = buildAtlas(rules.actors, { slots: art.slots, layers: art.layers, filter: art.filter, maxSize: renderer.maxTextureSize, biome });
        original = art.original;
      } catch (err) {
        console.warn('Installed graphics do not fit; using WebRA art:', err);
      }
      if (art.report.problems.length) console.info('Installed graphics:', art.report);
    }
    atlas ??= buildAtlas(rules.actors, { biome });
    renderer.setAtlas(atlas);
    // Slots with original art are drawn the OpenRA way (rotors, effects, projectiles, overlays).
    game.set_original_slots(original?.slots ?? new Uint32Array(0), original?.info ?? new Int32Array(0));
    // Animated building layers (art/animated.js): the engine draws them, the GPU picks the frame.
    game.set_building_overlays(atlas.overlays);
    // Pre-rendered animations need to know what each actor is doing (engine render.rs Pose).
    game.set_sprite_poses(atlas.filter === 'nearest');
    // Dying soldiers play the death sequences of art that has them (engine infantry_render.rs).
    game.set_death_art(Uint32Array.from(atlas.deaths), Uint32Array.from(atlas.deathTicks));
  };
  applyArt();
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
  const mapW = game.map_width();
  const mapH = game.map_height();
  renderer.setMapSize(mapW, mapH);
  // Terrain art of the map's biome (js/art/terrain.js), or tile terrain from
  // installed content (js/content/terrain.js); the cell layer is built from
  // the first terrain upload below (terrain types never change).
  renderer.setTerrainAtlas(buildTerrainAtlas(biome));
  let cellsReady = false;
  let terrainTypes = null;
  const applyTerrain = () => {
    if (!terrainTypes) return;
    const w = game.map_width();
    const h = game.map_height();
    const tiles = content?.terrain(biome, terrainTypes, w, h) ?? null;
    if (tiles) {
      renderer.setTerrainAtlas(tiles.atlas);
      renderer.uploadCells(tiles.cells);
    } else {
      renderer.setTerrainAtlas(buildTerrainAtlas(biome));
      // Decals follow the map itself, so every player of a map sees the same ones.
      renderer.uploadCells(cellTiles(terrainTypes, w, h, terrainSeed(terrainTypes)));
    }
  };
  // Installed content changed (the Original content dialog, also in a game): new art at once.
  content?.onChange(() => {
    applyArt();
    applyTerrain();
    // Sidebar cameos were painted once: paint them again from the new content (cameo.js setCameoArt ran first).
    sidebar?.repaintIcons();
  });
  // Weather on screen (js/weather-fx.js): particles, sky tint, lightning and thunder.
  const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const weather = new WeatherFx({ reducedMotion, lowQuality: !!settings.get('lowQuality'), onThunder: (gain) => audio?.thunder(gain) });
  weather.update(sky, performance.now() / 1000);
  let weatherText = '';

  let sidebar = null;
  let notices = null;
  let powerBar = null;
  let commandBar = null;
  let touch = null;
  // One-time attack-move tip (js/hints.js); spectators give no orders.
  let attackMoveTip = null;
  const placementEnded = () => {
    sidebar?.setPlacing(null);
    layout.setPlacing(false);
    touch?.update();
  };
  // Radar pings (js/radarpings.js): attacks, beacons and superweapons of the
  // watched player and their allies; the last one is where Space jumps to.
  const watchedPlayer = () => (view.player === OBSERVER_VIEW || view.player === COMBINED_VIEW ? null : view.player);
  const pings = new RadarPings({
    visible: (owner) => watchedPlayer() !== null && allies(watchedPlayer(), owner),
    color: (owner) => TEAM_COLORS[owner] ?? [1, 1, 1],
    pxPerWorld: rules.pxPerCell / Game.world_units_per_cell(),
    tickMs,
  });
  // OpenRA's relationship colours (TogglePlayerStanceColor, game menu
  // Settings): you, allies, enemies and neutrals instead of the players' own
  // colours; never for spectators. TEAM_COLORS is changed in place, so the
  // renderer, the radar and the sidebar follow it.
  const ownColors = TEAM_COLORS.map((c) => c.slice());
  const applyRelationshipColors = () => {
    const on = !viewer && !!settings.get('playerStanceColors');
    slots.forEach((slot, i) => {
      const c = !on ? ownColors[i] : relationshipColor(i === player ? 'self' : allies(player, i) ? 'ally' : slot.neutral ? 'neutral' : 'enemy');
      if (c && TEAM_COLORS[i]) TEAM_COLORS[i].splice(0, 3, ...c.slice(0, 3));
    });
    sidebar?.repaintIcons();
  };
  settings.subscribe('playerStanceColors', applyRelationshipColors);
  const input = new Input($('view'), ui, rules, player, {
    onPowerTargeting: (key) => {
      powerBar?.setTargeting(key);
      if (key) audio?.selectTarget(key);
    },
    onSelectionChanged: (ids, info) => {
      audio?.selection(ids, info);
      sidebar?.setSelection(selectionInfo(game, ids, allied));
      sidebar?.setDeployState(input.deployState());
      commandBar?.update();
    },
    // Command bar (js/commandbar.js): armed modes and Ctrl / Alt / Shift clicks.
    commandMouseDown: (w, e) => commandBar?.mouseDown(w, e) ?? false,
    commandClick: (w, mods) => commandBar?.click(w, mods) ?? false,
    commandCursor: (w, mods) => commandBar?.cursor(w, mods) ?? null,
    cancelCommand: () => commandBar?.cancel() ?? false,
    queuesAttackMove: (shift) => commandBar?.queuesAttackMove(shift) ?? shift,
    onSmartOrder: (action) => audio?.smartOrder(action),
    onPlainMove: (units, at) => {
      attackMoveTip?.plainMove(units, at).catch((err) => console.warn('attack-move tip:', err));
    },
    onPlaced: placementEnded,
    onCancelPlace: placementEnded,
    onMode: (mode) => sidebar?.setMode(mode),
    lastEvent: () => pings.last(),
    feedback: (text) => notices?.push(text),
    onMenu: () => menu.open(),
  }, { spectator: !!viewer });
  input.watchAll = !!viewer && view.player === OBSERVER_VIEW;
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
      onMode: (mode) => input.toggleMode(mode),
      onDeploy: () => input.deploySelection(),
      onMenu: () => menu.toggle(),
      onCashTick: (direction) => audio?.cashTick(direction),
      onProductionClick: (id, outcome) => audio?.productionClick(id, outcome),
    },
    { ticksPerSecond: Game.ticks_per_second(), hotkeys },
  );
  applyRelationshipColors();
  // Radar minimap in the sidebar's radar slot (js/minimap.js); the stress
  // test leaves the slot empty, which shows "Radar offline".
  const minimap = stress
    ? null
    : new Minimap($('radar'), {
        game: ui,
        fog: (p) => game.fog_bytes(p),
        player,
        input,
        colors: TEAM_COLORS,
        biome: sky.biome,
        pings,
        // OpenRA IngameRadarDisplayLogic: RadarUp and RadarDown for the player (spectators have no radar of their own).
        onRadar: viewer ? null : (online) => audio?.radar(online),
      });
  // Touch and pen (js/touch.js): gestures on the battlefield, the touch action
  // bar and placement buttons, long press on sidebar cards.
  touch = new TouchControls({ canvas: $('view'), field: $('field'), input, hotkeys });
  touch.bindSidebar($('sidebar'), (id) => sidebar.onCardCancel(id));
  // Announcer lines as text at the bottom of the battlefield (shown with sound off too).
  notices = new NotificationView($('field'));
  if (!viewer) {
    const tipView = new TipView($('field'));
    attackMoveTip = new AttackMoveTip({
      registry: defaultRegistry(),
      ask: input.ask,
      player,
      keyLabel: () => {
        const key = hotkeys.bindingsFor('attackMove')[0];
        return key ? formatCombo(key) : null;
      },
      show: (text) => tipView.show(text),
    });
  }
  audio?.onAnnounce((key) => notices.announce(key));
  // Floating cash, camera shake, the nuke flash, game lines and the time limit
  // clock of the lobby options and big warheads (js/battlefx.js, presentation only).
  const cssColor = (c) => `rgb(${(c ?? [1, 1, 1]).slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(', ')})`;
  const battle = new BattleFx({
    field: $('field'),
    rules,
    pxPerWorld: rules.pxPerCell / Game.world_units_per_cell(),
    allied: (owner) => !!viewer || allies(player, owner),
    colorOf: (owner) => cssColor(TEAM_COLORS[owner]),
    nameOf: (owner) => players[owner]?.name ?? (owner === player && !viewer ? 'You' : `Player ${owner + 1}`),
    line: (text) => notices.push(text),
    reduced: () => motionReduced(settings.get('reduceMotion'), reducedMotion),
  });
  // Support power bar (js/powers.js): pick a ready power, then a target on the map.
  powerBar = new PowerBar($('field'), {
    ticksPerSecond: Game.ticks_per_second(),
    onSelect: (power) => input.startPowerTargeting(power),
    onInsufficientPower: (power) => audio?.insufficientPower(power),
    onTargetLost: () => input.cancelPower(),
    hotkeys,
  });
  // Command bar (js/commandbar.js): orders, modes and fire stances for the selection.
  commandBar = new CommandBar($('field'), { game: ui, input, player, hotkeys, spectator: !!viewer });
  // Spectators and replays give no orders: no power bar, no command bar.
  if (viewer) {
    powerBar.root.hidden = true;
    commandBar.root.hidden = true;
  }
  // Debug menu (js/debug.js): cheats when the game allows them, local views, stepping while paused.
  // A local game stands still while the menu, the debug menu's pause or an end-game dialog asks for it.
  let paused = false;
  let menuPaused = false;
  let debugPaused = false;
  // OpenRA's Pause hotkey stops a local game without the menu (js/gamekeys.js).
  let keyPaused = false;
  const updatePaused = () => {
    paused = menuPaused || debugPaused || keyPaused || flow.paused;
  };
  const debug = new DebugMenu($('field'), {
    game,
    input,
    player,
    rules,
    colors: TEAM_COLORS,
    online: !!online,
    tickMs,
    memoryBytes: () => status.memoryBytes ?? 0,
    sim: () => host.stats(),
    instances: () => instanceInfo,
    isPaused: () => paused,
    setPaused: online || replay ? undefined : (on) => {
      debugPaused = on;
      updatePaused();
    },
    step: () => {
      if (!paused || online || replay || busy()) return false;
      host.command('debugStep').catch(() => {});
      return true;
    },
  });
  // Observer panel and replay controls (js/observer.js, js/records.js).
  let observer = null;
  let replayBar = null;
  // End-game statistics (js/stats.js): at the end, for spectators and replays, from the menu once out.
  const statsScreen = stress
    ? null
    : new StatsScreen($('stats-screen'), {
        load: async () => {
          const text = await askOf(game).observer_report();
          return text ? JSON.parse(text) : null;
        },
        players,
        rules,
        localPlayer: viewer ? null : player,
        live: true,
        actions: [],
      });
  const openStats = () => statsScreen?.open();
  const mountObserver = () => {
    observer = new ObserverPanel($('field'), {
      players,
      view: view.player,
      onView: (v) => {
        view.player = v;
        // The whole map and all players' vision together are no player's view.
        const all = v === OBSERVER_VIEW || v === COMBINED_VIEW;
        input.player = all ? (viewer ? 0 : player) : v;
        input.watchAll = all;
      },
      onStats: statsScreen ? openStats : null,
    });
  };
  if (viewer) mountObserver();
  if (replay && records) replayBar = new records.ReplayBar($('field'), replay);
  const progress = records ? new records.ProgressOverlay($('field')) : null;
  // HUD buttons in one row at the top right: Debug, Build / Map (phones), Menu.
  $('sidebar-toggle').before(debug.button);
  // Handle for debugging from the browser console.
  window.webra = { game, host, input, sidebar, powerBar, commandBar, minimap, renderer, wasm, rules, debug, touch, layout, notices, replay, recorder };
  // Game scale (game menu, Settings; js/scale.js): the view's base zoom. Auto
  // follows the window and the render resolution, so those changes pick again.
  const applyGameScale = () => input.setGameScale(resolveGameScale(settings.get('gameScale'), { ...screenOf(window), ratio: renderer.pixelRatio() }));
  applyGameScale();
  for (const key of ['gameScale', 'pixelRatioCap', 'lowQuality']) settings.subscribe(key, applyGameScale);
  window.addEventListener('resize', applyGameScale);
  watchPixelRatio(window, applyGameScale);
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
  // OpenRA IngameMenuLogic.OnQuit: "Battle control terminated" is heard before the game closes.
  const leave = async () => {
    leaving = true;
    online?.onQuit();
    replay?.dispose();
    await audio?.leave();
    location.reload();
  };
  // Restart (js/restart.js): a replay plays again from 0 here; a single player
  // game reloads the page, which starts it again with the same settings and
  // fresh audio, notifications, statistics, minimap, sidebar, selection and
  // camera. Online games have a rematch instead (js/online.js): the host
  // proposes it, every player accepts, and the page reloads into the lobby.
  const rematch = online?.rematch ?? null;
  if (rematch) {
    rematch.onLobby = () => {
      leaving = true;
      location.reload();
    };
  }
  /** Whether the end of game screens offer the restart button now. */
  const canRestart = () => (rematch ? ['propose', 'accept'].includes(rematch.action()) : !!restartGame);
  const restartLabel = () => (rematch ? rematch.label() : replay ? 'Restart replay' : 'Play again');
  const restartGame = rematch
    ? () => rematch.run()
    : replay
    ? () => {
        replay.seek(0);
        if (!replay.playing) replay.togglePlay();
        flow.reset();
      }
    : restart && !online && !stress
      ? () => {
          if (!saveRestart(restart, sessionStore())) {
            showToast('Could not restart: this browser does not let the page keep the settings.');
            return;
          }
          leaving = true;
          location.reload();
        }
      : null;
  const exit = async () => {
    leaving = true;
    online?.onQuit();
    await audio?.leave();
    location.href = new URL('../', location.href).href;
  };
  // Saves and replays (js/records.js): what the game menu and the game over screen offer.
  // Online: Save game asks every player (js/online.js); the file is kept once they all agree.
  const onlineSave = online && !online.spectator ? (online.save ?? null) : null;
  const onlineSaveAction = onlineSave
    ? [
        {
          id: 'onlinesave',
          label: 'Save game',
          run: async () => {
            const action = onlineSave.action();
            if (action === 'propose' || action === 'accept') {
              onlineSave.run();
              return action === 'accept' ? 'You agreed to save the game.' : 'Every player must agree to save the game; it goes on meanwhile.';
            }
            if (action === 'waiting') return 'Waiting for the other players to agree.';
            if (action === 'saving') return 'The game is being saved.';
            return 'This game cannot be saved now.';
          },
        },
      ]
    : [];
  const recordActions = [...onlineSaveAction, ...(records && recorder ? records.recordActions({ recorder, ready: () => !status.loading, stress, onSaved: () => audio?.gameSaved() }) : [])];
  const fullscreen = {
    available: () => fullscreenAvailable(),
    active: () => isFullscreen(),
    toggle: () => toggleFullscreen(),
  };
  // Mouse capture (js/mouselock.js): the Pointer Lock API keeps the mouse in
  // the game (multi-monitor setups) and the game draws a cursor of its own.
  // Esc the browser kept while letting go acts like the game's Esc when the
  // player wants Esc to open the menu too. None without Pointer Lock or a mouse.
  const mouseCapture = pointerLockAvailable()
    ? new MouseCapture({
        root: $('app'),
        settings,
        hotkeys,
        isFullscreen,
        onHint: (text) => showToast(text),
        onEscape: () => {
          if (!input.suspended && !input.cancelMode()) menu.open();
        },
      })
    : null;
  const menu = new GameMenu($('game-menu'), {
    online: !!online || !!replay,
    replay: !!replay,
    actions: recordActions,
    hotkeys,
    settings,
    fullscreen,
    mouseCapture: { available: () => !!mouseCapture },
    onChange: (open, isPaused) => {
      input.setSuspended(open);
      if (open) {
        // The menu needs the OS cursor (sliders, lists): the mouse is let go.
        mouseCapture?.setBlocked(true);
        touch.reset();
        // A tooltip of the HUD would stay over the menu.
        hideTooltip();
      }
      menuPaused = isPaused;
      updatePaused();
      $('menu-button').textContent = open ? 'Resume' : 'Menu';
    },
    uiScale,
    renderRatio: () => renderer.pixelRatio(),
    audio,
    onSound: audioPanel ? () => audioPanel.open() : undefined,
    onContent: contentPanel ? () => contentPanel.open() : undefined,
    onReleaseNotes: () => releaseNotes.open(),
    restart: rematch
      ? { online: true, available: canRestart, label: () => rematch.label(), text: () => rematch.text(), run: restartGame }
      : restartGame
        ? { replay: !!replay, run: restartGame }
        : undefined,
    onStats: statsScreen ? openStats : undefined,
    // Live statistics of the other players would give a player still in the game away.
    statsAvailable: () => watching() || flow.over,
    onLeave: leave,
    onExit: exit,
  });
  $('menu-button').hidden = false;
  // A click on Menu opens the menu, which lets go of the mouse: it does not capture it first.
  $('menu-button').dataset.noCapture = '';
  $('menu-button').addEventListener('click', () => menu.toggle());
  // Tooltips of the HUD buttons, with their current keys (js/hudtips.js); the page reloads to leave the game.
  attachHudTooltips({
    hotkeys,
    menuButton: $('menu-button'),
    debugButton: debug.button,
    cheats: debug.cheats,
    toggle: $('sidebar-toggle'),
    isMenuOpen: () => menu.isOpen,
    isCollapsed: () => layout.collapsed,
  });
  // OpenRA DisableUserInterface / DisableAllUserInterface: only the battlefield
  // (and without the cursor), pressed again: everything back.
  let interfaceHidden = false;
  let cursorHidden = false;
  const toggleInterface = (all) => {
    if (!all && interfaceHidden && cursorHidden) cursorHidden = false;
    else if (all && interfaceHidden && !cursorHidden) cursorHidden = true;
    else {
      interfaceHidden = !interfaceHidden;
      cursorHidden = all && interfaceHidden;
    }
    $('app').classList.toggle('ui-hidden', interfaceHidden);
    $('app').classList.toggle('cursor-hidden', cursorHidden);
  };
  // OpenRA TakeScreenshot: the next frame of the battlefield, saved as a PNG.
  let screenshotPending = false;
  // The game screen's hotkeys (js/gamekeys.js): OpenRA's Red Alert set, plus
  // WebRA's debug menu, unit paths, fullscreen and the sidebar numpad.
  // Spectators and replays get OpenRA's spectator hotkeys.
  const HEALTH_BAR_CYCLE = ['off', 'damaged', 'all'];
  const quickSave = recordActions.find((a) => a.id === 'save');
  registerGameKeys(
    hotkeys,
    {
      // OpenRA Pause: the game stops (and goes on) without the menu; replays
      // play and pause. Online games cannot pause (the lockstep server drops
      // a player who holds the game up).
      pause: replay
        ? () => replay.togglePlay()
        : online
          ? undefined
          : () => {
              keyPaused = !keyPaused;
              updatePaused();
            },
      menu: () => menu.toggle(),
      debugMenu: () => debug.toggle(),
      showUnitPaths: () => {
        const on = settings.set('showUnitPaths', !settings.get('showUnitPaths'));
        showToast(on ? 'Unit paths shown' : 'Unit paths hidden');
      },
      fullscreen: async () => {
        const r = await fullscreen.toggle();
        if (!r.ok) showToast(r.message);
      },
      toggleMouseCapture: mouseCapture ? () => mouseCapture.toggle() : undefined,
      // OpenRA CycleStatusBars: Standard, Damaged, Always show.
      cycleStatusBars: () => {
        const i = HEALTH_BAR_CYCLE.indexOf(settings.get('healthBars'));
        settings.set('healthBars', HEALTH_BAR_CYCLE[(i + 1) % HEALTH_BAR_CYCLE.length]);
      },
      toggleMute: audio
        ? () => {
            const muted = audio.toggleMute();
            showToast(muted ? 'Audio muted' : 'Audio unmuted');
          }
        : undefined,
      togglePlayerStanceColor: () => settings.set('playerStanceColors', !settings.get('playerStanceColors')),
      takeScreenshot: () => {
        screenshotPending = true;
      },
      // OpenRA QuickSave: single player games only (skirmish saves, js/records.js).
      quickSave: quickSave && !online && !replay ? async () => showToast(await quickSave.run()) : undefined,
      disableUserInterface: () => toggleInterface(false),
      disableAllUserInterface: () => toggleInterface(true),
      productionTab: (q) => sidebar.openTab(q),
      selectProductionBuilding: () => input.selectProductionBuilding(sidebar.activeTab),
      cycleProductionBuildings: () => input.cycleProductionBuildings(),
      productionSlot: (n, e) => sidebar.activateSlot(n, { shift: !!e?.shiftKey }),
      cycleTab: (dir) => sidebar.cycleTab(dir),
      numpadSlot: (n, e) => sidebar.activateSlot(n, { shift: !!e?.shiftKey, cancel: !!(e?.ctrlKey || e?.metaKey) }),
      cancelPlacement: () => input.cancelPlacing(),
      supportPower: (i) => powerBar.activate(i),
      stopMusic: audio ? () => audio.music('stop') : undefined,
      pauseMusic: audio ? () => audio.music('pause') : undefined,
      prevMusic: audio ? () => audio.music('prev') : undefined,
      nextMusic: audio ? () => audio.music('next') : undefined,
      observerCombinedView: () => observer?.setView(COMBINED_VIEW),
      observerWorldView: () => observer?.setView(OBSERVER_VIEW),
      statistics: (panel) => observer?.showPanel(panel),
      replaySpeed: replayBar ? (speed) => replayBar.setSpeed(speed) : undefined,
    },
    { spectator: !!viewer },
  );
  // Fullscreen changes the canvas size; the renderer and input follow it each
  // frame, the toast says when the browser refused.
  onFullscreenChange((fs) => {
    if (menu.isOpen) menu.render();
    // Entering fullscreen captures the mouse (Settings: in fullscreen or always), leaving it lets go.
    mouseCapture?.fullscreenChanged(fs);
  });
  // A single-player game opens the menu (and so pauses) when its tab is hidden.
  // Online, the lockstep driver keeps up from network events meanwhile (it
  // runs where the game runs, so it is told).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !stress && !online && !replay) menu.open();
    if (online) host.command('hidden', [document.hidden]).catch(() => {});
  });
  // The worker stopped (an engine error): the game cannot go on.
  host.on('failed', (message) => {
    leaving = true;
    showToast(`The game stopped: ${message}`);
  });
  const download = recordActions.find((a) => a.id === 'replay');
  /** The statistics screen's buttons (the rematch button follows the proposal). */
  const statsActions = () => [
    ...(canRestart() ? [{ label: restartLabel(), run: () => (replay ? (statsScreen.close(), restartGame()) : restartGame()) }] : []),
    { label: online && !replay && !online.spectator ? 'Leave game' : 'Return to lobby', run: leave },
  ];
  if (statsScreen) statsScreen.opts.actions = statsActions();

  // ---- Defeat, victory and the end of the game (js/endgame.js) ----------------------
  /** Names of the winning side, from the newest player state. */
  let winner = null;
  const winnerText = () => {
    if (winner === null || winner === undefined) return '';
    const names = players.filter((_, i) => i === winner || game.are_allies(i, winner)).map((p) => p.name);
    if (!names.length) return '';
    return `${names.join(' and ')} ${names.length === 1 ? 'wins' : 'win'}`;
  };
  /** Defeated: the observer's screen, the whole map, no orders. */
  const enterSpectator = () => {
    spectating = true;
    for (let i = 0; i < 8 && input.cancelMode(); i++);
    input.cancelPlacing();
    placementEnded();
    input.setSelection([]);
    powerBar.root.hidden = true;
    commandBar.root.hidden = true;
    $('app').classList.add('viewer');
    view.player = OBSERVER_VIEW;
    if (!observer) mountObserver();
    else observer.setView(OBSERVER_VIEW, false);
  };
  const flow = new EndGameFlow({
    online: !!online,
    viewer: !!viewer,
    replay: !!replay,
    onChange: (f) => {
      updatePaused();
      if (f.spectating && !spectating) enterSpectator();
      endDialog.render();
    },
  });
  const endDialog = new EndGameDialog($('gameover'), {
    flow,
    actions: {
      spectate: () => flow.spectate(),
      continue: () => flow.close(),
      stats: openStats,
      restart: () => restartGame?.(),
      download: async () => showToast(await download.run()),
      leave,
      exit,
    },
    context: () => ({ winnerText: winnerText(), canRestart: canRestart(), restartLabel: restartLabel(), canDownload: !!download }),
    blocked: () => !!statsScreen?.isOpen || menu.isOpen,
  });
  // A rematch proposal changes what the end of game screens offer.
  rematch?.subscribe(() => {
    endDialog.render();
    if (statsScreen) {
      statsScreen.opts.actions = statsActions();
      if (statsScreen.isOpen) statsScreen.render();
    }
    if (menu.isOpen) menu.render();
  });
  // Leaving the page by accident (a browser shortcut, a misclick) loses the game: ask first.
  if (!stress && !replay) {
    window.addEventListener('beforeunload', (e) => {
      if (leaving || over) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // Instance path (js/crowd.js): the CPU path unless ?instances=gpu asks for the GPU pass (and it is available).
  const instancesParam = new URLSearchParams(location.search).get('instances');
  let instanceInfo = null;
  let uploadedFog = null;
  const NO_RECTS = new Float32Array(0);

  let last = performance.now();
  let simMs = 0;
  let fpsFrames = 0;
  let fpsTime = last;
  let fps = 0;
  let uiTime = 0;
  let over = false;
  let drawn = 0;

  function frame(now) {
    const dt = Math.min(now - last, 250);
    last = now;
    const catching = busy();
    const suspend = catching || menu.isOpen || flow.dialog !== null || !!statsScreen?.isOpen;
    if (suspend !== input.suspended) input.setSuspended(suspend);
    // Menus, the end of the game, statistics and modal dialogs (saves, online) get the OS cursor.
    mouseCapture?.setBlocked(suspend || !!document.querySelector('dialog[open]'));
    input.update(dt / 1000);
    // Animated original cursors step like OpenRA's (cursors.js); the input shows the new frame.
    if (tickCursors(now)) input.updateCursor();
    // Advance the simulation by this frame's time. In a worker this only
    // sends the time: the frame drawn below is the newest one it sent back.
    const v = input.viewRect();
    const choice = chooseInstancePath({
      gpuReady: !!renderer.instances,
      gpuReason: renderer.instancesReason,
      requested: instancesParam,
      forceCpu: debug.prefs.cpuInstances,
    });
    const t0 = performance.now();
    const f = host.step({
      dt,
      paused,
      view: view.player,
      rect: [v.x0, v.y0, v.x1, v.y1],
      audio: true,
      paths: settings.get('showUnitPaths'),
      instances: choice.path,
    });
    // Main thread time the simulation took this frame (in a worker: posting the step).
    const simFrameMs = performance.now() - t0;
    if (!f) {
      requestAnimationFrame(frame);
      return;
    }
    const fresh = f.id !== drawn;
    if (fresh) {
      drawn = f.id;
      const wasLoading = !!status.loading;
      status = f.status;
      // OpenRA StartGameNotification LoadedNotification: the saved game is ready.
      if (wasLoading && !status.loading && !status.loadError) audio?.gameLoaded();
      simMs = f.simMs;
      online?.driver.update(status.online);
      replay?.update(status.replay);
      recorder?.update(status.recorderFull);
      if (status.loadError && !leaving) {
        leaving = true;
        showToast(status.loadError);
        setTimeout(() => location.reload(), 4000);
      }
      if (f.terrain) {
        renderer.uploadTerrain(f.terrain);
        if (!cellsReady) {
          terrainTypes = f.terrain.slice();
          applyTerrain();
          cellsReady = true;
        }
        minimap?.terrainChanged(f.terrain);
      }
      // Lightning flashes and thunder follow the sky of every new frame.
      if (f.weather && f.weather !== lastSky) {
        lastSky = f.weather;
        sky = JSON.parse(f.weather);
      }
      if (sky) weather.update({ ...sky, tick: f.tick }, now / 1000, { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 });
      // The GPU path keeps one fog until it changes; the CPU path sends it every frame.
      const fog = f.fog();
      if (fog !== uploadedFog) renderer.uploadFog(fog);
      uploadedFog = f.instances === 'gpu' ? fog : null;
      instanceInfo = { path: f.instances, reason: f.instances === choice.path ? choice.reason : 'switching', buildMs: f.buildMs, bytes: f.renderBytes };
    }
    progress?.show(busy() ? progressText() : null);
    // Sounds of what happened, heard from the camera (fog hides enemy sounds),
    // and radar pings. Fast-forwarding (loading, rejoining, seeking) stays
    // silent: the simulation drops the events.
    const events = game.take_audio_events();
    pings.onEvents(events, now);
    battle.onEvents(events, BattleFx.ticksAt(now / 1000), (x, y) => {
      // In sight now: the frame's fog (255 visible) of the cell.
      const cx = Math.floor(x / rules.pxPerCell);
      const cy = Math.floor(y / rules.pxPerCell);
      const fog = f.fog();
      return !!viewer || (cx >= 0 && cy >= 0 && cx < mapW && cy < mapH && fog[cy * mapW + cx] === 255);
    });
    audio?.frame(v, () => f.fog(), events);

    // UI rects may call into wasm (placement preview, main thread mode), which
    // may grow its memory, so the frame's views are made after them.
    const renderStart = performance.now();
    const uiRects = input.uiRects();
    commandBar.frame();
    // GPU path: the simulation's rects come from the instance pass, these are the UI's.
    const records = f.instances === 'gpu' ? f.records() : null;
    const simRects = f.instances === 'gpu' ? NO_RECTS : f.rects();
    const rects = new Float32Array(simRects.length + uiRects.length);
    rects.set(simRects);
    rects.set(uiRects, simRects.length);
    // Building animations run on wall time but stop with the game (and for reduced motion).
    animClock.advance(dt, paused);
    const lines = f.lineCount ? f.lines() : null;
    const gpu = records ? { records, alpha: f.alpha, view: [v.x0, v.y0, v.x1, v.y1] } : null;
    // Weather (js/weather-fx.js) and heat shimmer from the same frame.
    const canvas = $('view');
    const fx = { ...weather.uniforms(now / 1000, canvas.width, canvas.height), heat: f.heatCount ? f.heat() : null, heatCount: f.heatCount ?? 0 };
    // Camera shake (js/battlefx.js) moves the picture, not the camera the input uses.
    const fxTick = BattleFx.ticksAt(now / 1000);
    const [shakeX, shakeY] = battle.cameraOffset(fxTick, (v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2);
    const drawCamera = shakeX || shakeY ? { ...input.camera, x: input.camera.x + shakeX, y: input.camera.y + shakeY } : input.camera;
    renderer.draw(drawCamera, now / 1000, f.sprites(), f.spriteCount, rects, rects.length / 8, animClock.uniform(), lines, f.lineCount, gpu, fx);
    battle.frame(fxTick, drawCamera);
    // Read the canvas in the same task as the draw, before it is presented.
    if (screenshotPending) {
      screenshotPending = false;
      saveScreenshot(canvas).then(showToast);
    }
    // Shared memory: count a frame the worker wrote over while it was read (js/sim/framebuffer.js).
    f.valid();
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
      // Null in a worker until its first answer.
      const json = game.player_json(player);
      const state = json ? JSON.parse(json) : null;
      if (state && !watching()) {
        sidebar.update(state);
        powerBar.update(state.powers ?? []);
        commandBar.update();
        audio?.playerState(state);
        sidebar.setSelection(selectionInfo(game, input.selection, allied));
        sidebar.setDeployState(input.deployState());
      }
      const stats = watching() ? game.observer_stats() : null;
      if (stats && observer) observer.update(JSON.parse(stats), game.tick_count(), observerExtra(observer.needs()));
      replayBar?.update();
      if (state) updateHud(state, fps, simMs, stress, status.actorCount ?? 0, paused, layout.compact, replay ? 'Replay' : online?.spectator || spectating ? 'Spectating' : null);
      // The sky of the newest frame: badge text (thunder and flashes follow in weather.update).
      if (f.weather) weatherText = updateWeatherBadge(JSON.parse(f.weather), weatherText);
      touch.update();
      if (state) debug.update(state);
      // The time limit clock (js/battlefx.js), for players and spectators alike.
      if (state) battle.timeLimit(state);
      if (state && !stress) {
        winner = state.winner ?? null;
        const event = flow.update(state, { ended: !!replay?.ended });
        // The announcer: "Mission failed" on the defeat, "Mission accomplished" on a win (also an ally's, after a defeat).
        if (event === 'defeat') audio?.gameOver(false);
        else if (event === 'victory' || (event === 'over' && !viewer && state.won)) audio?.gameOver(true);
        over = flow.over || flow.phase !== 'playing';
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** What the observer's statistics panel needs per player besides observer_stats (js/observer.js `needs`). */
  function observerExtra(need) {
    const names = (id) => rules.actors.find((a) => a.id === id)?.name ?? id;
    return (p) => {
      if (need === 'harvesters') return { harvesters: game.harvesters(p).length };
      if (need === 'army') {
        const flat = game.army_counts(p);
        const army = [];
        for (let i = 0; i + 1 < flat.length; i += 2) army.push([rules.actors[flat[i]]?.name ?? '?', flat[i + 1]]);
        return { army };
      }
      if (need === 'state') {
        const json = game.player_json(p);
        const state = json ? JSON.parse(json) : null;
        for (const q of state?.queues ?? []) for (const it of q) it.name = names(it.id);
        return { state };
      }
      return {};
    };
  }

  function progressText() {
    if (status.loading) return `Loading the saved game... ${Math.round((status.loadProgress ?? 0) * 100)}%`;
    if (online?.driver.catchingUp) {
      const d = online.driver;
      return d.waitingSync ? 'Joining the game...' : `Catching up with the game... ${Math.round(d.progress() * 100)}%`;
    }
    if (replay?.seeking) return `Seeking... ${records.formatTicks(replay.target)}`;
    return null;
  }
}

/** OpenRA metrics PlayerStanceColor*: rgb 0..1 for 'self', 'ally', 'enemy' and 'neutral'. */
function relationshipColor(kind) {
  const hex = { self: 0x32cd32, ally: 0xffff00, enemy: 0xff0000, neutral: 0xd2b48c }[kind];
  return [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Save the battlefield canvas as a PNG file (OpenRA's screenshot-<UTC time>.png); resolves to a message. */
function saveScreenshot(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve('Screenshots are not available in this browser.');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve('Could not take a screenshot.');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${stamp}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve(`Screenshot saved: ${a.download}`);
    }, 'image/png');
  });
}

/**
 * Selection panel info: actor_json() of one actor, with `description` set to
 * the TooltipDescription its viewer reads (tech buildings: @ally for the owner
 * and its allies, @other for the rest); a summary for several.
 * @param {(owner: number) => boolean} allied whether the local player is allied to `owner`
 */
function selectionInfo(game, ids, allied) {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const info = JSON.parse(game.actor_json(ids[0]));
    if (info) info.description = (allied(info.owner) ? info.allyDescription : info.otherDescription) || '';
    return info;
  }
  return { count: ids.length, name: `${ids.length} units selected` };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Seed for terrain decals: a hash of the map's terrain types (same map, same decals). */
function terrainSeed(terrain) {
  let h = 0x811c9dc5;
  for (let i = 0; i < terrain.length; i += 4) h = Math.imul(h ^ terrain[i], 0x01000193);
  return h >>> 0;
}

/** The biome and weather badge: name of the sky, and what it does to the battle. */
function updateWeatherBadge(sky, previous) {
  const { label, detail } = weatherInfo(sky);
  const key = `${label}|${detail}`;
  if (key === previous) return previous;
  const badge = $('weather');
  badge.hidden = !label;
  badge.textContent = label;
  if (label && sky.mode === 'full' && detail !== NO_EFFECT) {
    const line = document.createElement('span');
    line.className = 'effects';
    line.textContent = detail;
    badge.append(line);
  }
  badge.title = detail;
  return key;
}

function updateHud(state, fps, simMs, stress, units, paused, compact, mode = null) {
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
