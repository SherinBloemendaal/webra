// Restart in place (js/main.js start(), js/gamesession.js): the game screen's
// parts are built again for every game in the same page, so taking them down
// must leave nothing behind. These tests build the parts js/main.js builds,
// the way it builds them, three times over with a Disposer in between, and
// count what is left on the window, the document, the elements that outlive
// a game (the canvas, the sidebar, the battlefield, the overlay sections) and
// the hotkey registry. A leak would show as a count that grows per restart;
// a hotkey action left registered makes the next game throw at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeElement, installDom, uninstallDom, memoryStorage } from './dom-fixtures.mjs';
import { Disposer } from '../js/disposer.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';

const NONE = 0xffffffff;

// The command bar's icons are static SVG markup (js/commandbar.js ICONS);
// the fake DOM refuses innerHTML, so here it is taken and dropped.
Object.defineProperty(FakeElement.prototype, 'innerHTML', { configurable: true, get: () => '', set() {} });

/** Every listener under `node` (itself included). */
function listenersUnder(node) {
  let n = [...node.listeners.values()].reduce((sum, l) => sum + l.length, 0);
  for (const c of node.childNodes ?? []) n += listenersUnder(c);
  return n;
}

/** A fake engine handle: enough for the parts to build and draw once. */
function fakeGame() {
  return {
    map_width: () => 32,
    map_height: () => 32,
    radar_state: () => 0,
    minimap_blips: () => new Int32Array(0),
    pick: () => NONE,
    actor_json: () => 'null',
    are_allies: (a, b) => a === b,
    set_selection() {},
    selection: () => new Uint32Array(0),
    deploy_state: () => 0,
    deploy_summary: () => 0,
    command_state: () => JSON.stringify({ units: 0, armed: 0, guard: 0, scatter: 0, stances: {} }),
    has_minelayer: () => false,
    cheats_enabled: () => false,
    player_json: () => null,
  };
}

/** The page js/main.js runs in: the elements that outlive a game. */
function page() {
  const doc = installDom({ windowEvents: true });
  const el = (tag, id, parent = doc.body) => {
    const e = doc.createElement(tag);
    if (id) e.id = id;
    parent.append(e);
    return e;
  };
  const app = el('div', 'app');
  const field = el('main', 'field', app);
  const view = el('canvas', 'view', field);
  const hudRow = el('div', 'hud-row', field);
  const hudButtons = el('div', null, field);
  hudButtons.className = 'hud-buttons';
  const toggle = el('button', 'sidebar-toggle', hudButtons);
  const menuButton = el('button', 'menu-button', hudButtons);
  const sidebar = el('aside', 'sidebar', app);
  const gameover = el('section', 'gameover');
  const stats = el('section', 'stats-screen');
  const gameMenu = el('section', 'game-menu');
  for (const s of [gameover, stats, gameMenu]) s.hidden = true;
  globalThis.window.innerWidth = 1280;
  globalThis.window.innerHeight = 800;
  globalThis.window.devicePixelRatio = 1;
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame ??= () => 0;
  globalThis.cancelAnimationFrame ??= () => {};
  return { doc, app, field, view, hudRow, hudButtons, toggle, menuButton, sidebar, gameover, stats, gameMenu };
}

/** The session's NetQuality (js/netquality.js) lives in the online screen, across games: its listeners must go with each game. */
const netListeners = new Map();
const netQuality = {
  self: null,
  players: new Map(),
  waiting: null,
  on(type, fn) {
    if (!netListeners.has(type)) netListeners.set(type, new Set());
    netListeners.get(type).add(fn);
    return () => netListeners.get(type).delete(fn);
  },
};
const netListenerCount = () => [...netListeners.values()].reduce((n, set) => n + set.size, 0);

/** Build the parts of one game like js/main.js runGame, into `scope`. */
async function buildGame(p, scope, { hotkeys, settings }) {
  const { Input } = await import('../js/input.js');
  const { CommandBar } = await import('../js/commandbar.js');
  const { TouchControls } = await import('../js/touch.js');
  const { Minimap } = await import('../js/minimap.js');
  const { Sidebar } = await import('../js/sidebar.js');
  const { GameMenu } = await import('../js/gamemenu.js');
  const { StatsScreen } = await import('../js/stats.js');
  const { EndGameDialog, EndGameFlow } = await import('../js/endgame.js');
  const { ChatPanel } = await import('../js/chatpanel.js');
  const { TextLog } = await import('../js/chatlog.js');
  const { Layout } = await import('../js/layout.js');
  const { NotificationView } = await import('../js/notifications.js');
  const { PowerBar } = await import('../js/powers.js');
  const { PowerTimers } = await import('../js/powertimers.js');
  const { BattleFx } = await import('../js/battlefx.js');
  const { TipView } = await import('../js/hints.js');
  const { MuteIndicator } = await import('../js/muteindicator.js');
  const { DebugMenu } = await import('../js/debug.js');
  const { MissionView } = await import('../js/campaign/view.js');
  const { ProgressOverlay, ReplayBar } = await import('../js/records.js');
  const { registerGameKeys } = await import('../js/gamekeys.js');
  const { attachHudTooltips } = await import('../js/hudtips.js');
  const { onFullscreenChange } = await import('../js/fullscreen.js');
  const { watchPixelRatio } = await import('../js/scale.js');
  const game = fakeGame();
  const rules = { actors: [], players: [], pxPerCell: 24, lowPowerModifier: 100 };
  const layout = scope.own(new Layout({ app: p.app, toggle: p.toggle }));
  const input = scope.own(new Input(p.view, game, rules, 0, { onSelectionChanged() {}, onPowerTargeting() {}, onMode() {} }, { hotkeys, settings }));
  const commandBar = scope.own(new CommandBar(p.field, { game, input, player: 0, hotkeys }));
  const touch = scope.own(new TouchControls({ canvas: p.view, field: p.field, input, hotkeys }));
  touch.bindSidebar(p.sidebar, () => {});
  const sidebar = scope.own(new Sidebar(p.sidebar, game, rules, 0, { onMenu() {}, onMode() {}, onDeploy() {} }, { ticksPerSecond: 25, hotkeys }));
  // The radar sits in the sidebar's radar slot.
  const radar = sidebar.radarEl;
  scope.own(new Minimap(radar, { game, fog: () => new Uint8Array(32 * 32), player: 0, input, colors: [[1, 1, 1]], touch }));
  scope.own(new NotificationView(p.field));
  scope.own(new TipView(p.field)).show('A tip that is open when the game goes');
  scope.own(new BattleFx({ field: p.field, rules, pxPerWorld: 1, allied: () => true, colorOf: () => 'red', nameOf: () => 'P', line() {}, reduced: () => true }));
  scope.own(new ChatPanel(p.field, { log: new TextLog(), hotkeys, send: null, names: [], mutable: () => [], sound() {}, withTime: true, win: globalThis.window }));
  let muted = false;
  const prefSubs = new Set();
  scope.own(new MuteIndicator(p.hudButtons, { muted: () => muted, subscribe: (fn) => (prefSubs.add(fn), () => prefSubs.delete(fn)) }));
  scope.own(new PowerBar(p.hudRow, { ticksPerSecond: 25, onSelect() {}, hotkeys }));
  scope.own(new PowerTimers(p.hudRow));
  // An online game's connection parts (js/netwarn.js) on a NetQuality stand-in that outlives the game.
  const { NetWarn } = await import('../js/netwarn.js');
  scope.own(new NetWarn({ quality: netQuality, roster: [{ client: 1, player: 0, name: 'P' }], you: 1, field: p.field, slot: sidebar.netSlot, registry: settings.registry, line() {} }));
  const debug = scope.own(new DebugMenu(p.field, { game, input, player: 0, rules, colors: [[1, 1, 1]], online: false, tickMs: 40, perf: { recorder: { recording: false, last: null, progress: () => null }, toggle() {}, download() {}, settings } }));
  p.toggle.before(debug.button);
  const feed = { state: null, take: () => [] };
  scope.own(new MissionView({ field: p.field, hudButtons: p.hudButtons, panelBefore: p.hudRow, feed, centerOn() {}, ping() {}, toScreen: () => null, pxPerCell: 24, tickMs: 40, onRestart() {}, onLeave() {} }));
  const stats = scope.own(new StatsScreen(p.stats, { load: async () => null, players: [], rules, localPlayer: 0, live: true, actions: [] }));
  await stats.open();
  const flow = new EndGameFlow();
  scope.own(new EndGameDialog(p.gameover, { flow, actions: {}, context: () => ({}) }));
  scope.own(new ProgressOverlay(p.field));
  scope.own(new ReplayBar(p.field, { length: 100, ticks: 0, speed: 1, playing: true, ended: false, seeking: false, diverged: null, togglePlay() {}, setSpeed() {}, seek() {} }));
  const menu = scope.own(
    new GameMenu(p.gameMenu, {
      online: false,
      hotkeys,
      settings,
      fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
      mouseCapture: { available: () => false },
      onChange() {},
      renderRatio: () => 1,
      restart: { run() {} },
      onLeave() {},
      onExit() {},
    }),
  );
  // The game menu is open when Restart is clicked in it.
  menu.open();
  scope.on(p.menuButton, 'click', () => menu.toggle());
  scope.add(attachHudTooltips({ hotkeys, menuButton: p.menuButton, debugButton: debug.button, toggle: p.toggle, isMenuOpen: () => menu.isOpen, isCollapsed: () => layout.collapsed }));
  scope.add(registerGameKeys(hotkeys, { menu: () => menu.toggle(), pause: () => {}, debugMenu: () => debug.toggle() }));
  scope.add(onFullscreenChange(() => {}, p.doc));
  scope.on(p.doc, 'visibilitychange', () => {});
  scope.on(globalThis.window, 'resize', () => {});
  scope.add(watchPixelRatio(globalThis.window, () => {}));
  scope.on(globalThis.window, 'beforeunload', () => {});
  for (const key of ['gameScale', 'pixelRatioCap', 'lowQuality']) scope.add(settings.subscribe(key, () => {}));
  return { input, prefSubs };
}

test('the game screen comes down completely: three restarts leave no listener, part or hotkey behind', async () => {
  const p = page();
  const warn = console.warn;
  try {
    const settings = createSettings(createRegistry({ storage: memoryStorage() }));
    const hotkeys = new HotkeyRegistry(settings);
    const win = globalThis.window;
    const counts = () => ({
      window: listenersUnder(win) - listenersUnder(p.doc.documentElement) - [...p.doc.listeners.values()].reduce((s, l) => s + l.length, 0),
      document: [...p.doc.listeners.values()].reduce((s, l) => s + l.length, 0),
      view: listenersUnder(p.view),
      sidebar: listenersUnder(p.sidebar),
      sidebarParts: p.sidebar.childNodes.length,
      toggle: listenersUnder(p.toggle),
      menuButton: listenersUnder(p.menuButton),
      field: p.field.childNodes.length,
      hudRow: p.hudRow.childNodes.length,
      hudButtons: p.hudButtons.childNodes.length,
      sections: [p.gameover, p.stats, p.gameMenu].map((s) => `${s.childNodes.length}:${s.hidden}`).join(' '),
      actions: hotkeys.actions.size,
      hotkeyListeners: hotkeys.listeners.size,
    });
    // The window itself has no children: count its own listeners.
    const winOwn = () => [...win.listeners.values()].reduce((s, l) => s + l.length, 0);
    const before = { ...counts(), window: winOwn() };
    const after = [];
    for (let round = 0; round < 3; round++) {
      const scope = new Disposer({ onError: (err) => assert.fail(`a part could not be taken down: ${err.stack}`) });
      const { prefSubs } = await buildGame(p, scope, { hotkeys, settings });
      const during = { ...counts(), window: winOwn() };
      assert.ok(during.window > before.window && during.actions > before.actions && during.field > before.field, 'the game set things up');
      assert.equal(prefSubs.size, 1);
      scope.dispose();
      assert.equal(prefSubs.size, 0, 'the mute indicator stopped following the sound settings');
      assert.equal(netListenerCount(), 0, 'the connection parts stopped following the session');
      after.push({ ...counts(), window: winOwn() });
    }
    // The shared tooltip layer and the hotkeys' focus watcher listen to the
    // document and the window once per page, from the first game on: after
    // that, no restart adds a single listener.
    assert.deepEqual(after[1], after[0]);
    assert.deepEqual(after[2], after[0]);
    const { window: w0, document: d0, ...rest } = after[0];
    const { window: wb, document: db, ...restBefore } = before;
    assert.deepEqual(rest, restBefore, 'everything else is as before the first game');
    assert.ok(w0 - wb <= 2 && d0 - db <= 4, `once-per-page listeners only (window +${w0 - wb}, document +${d0 - db})`);
    assert.equal(p.view.classList.contains('has-tooltip'), false);
    assert.equal(p.menuButton.classList.contains('has-tooltip'), false, 'the HUD tooltips are detached');
  } finally {
    console.warn = warn;
    uninstallDom();
  }
});

test('js/main.js: the game setup puts what outlives a game into its scope, and Restart no longer reloads', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const start = main.indexOf('function runGame(');
  const end = main.indexOf('\n/** OpenRA metrics PlayerStanceColor', start);
  assert.ok(start > 0 && end > start);
  const body = main.slice(start, end);
  // Listeners on the window, the document and the HUD buttons that stay in the page.
  assert.doesNotMatch(body, /\bwindow\.addEventListener\(/);
  assert.doesNotMatch(body, /\bdocument\.addEventListener\(/);
  assert.doesNotMatch(body, /\$\('(menu-button|sidebar-toggle|view|sidebar)'\)\.addEventListener\(/);
  // Subscriptions: every one is handed to the scope.
  for (const m of body.matchAll(/(settings\.subscribe|content\?\.onChange|audio\?\.onAnnounce|rematch\?\.subscribe|watchPixelRatio|registerGameKeys|attachHudTooltips|onFullscreenChange|watchReducedMotion)\(/g)) {
    const lineStart = body.lastIndexOf('\n', m.index) + 1;
    assert.match(body.slice(lineStart, m.index + m[0].length), /scope\.add\(/, `${m[1]} goes into the scope`);
  }
  // Parts with listeners or timers of their own.
  for (const part of ['Input', 'Sidebar', 'Minimap', 'TouchControls', 'NotificationView', 'TipView', 'BattleFx', 'ChatPanel', 'MuteIndicator', 'PowerBar', 'PowerTimers', 'CommandBar', 'WorldTooltip', 'MissionView', 'DebugMenu', 'StatsScreen', 'GameMenu', 'EndGameDialog', 'MouseCapture', 'Layout']) {
    assert.match(body, new RegExp(`scope\\.own\\(new ${part}\\(`), `${part} is owned by the scope`);
  }
  assert.match(body, /scope\.own\(new records\.ProgressOverlay\(/);
  assert.match(body, /scope\.own\(new records\.ReplayBar\(/);
  // The loop stops, the simulation (worker), the GPU resources and the sound go.
  assert.match(body, /cancelAnimationFrame\(rafId\)/);
  assert.match(body, /host\.dispose\(\);\s*renderer\.releaseGame\(\);\s*audio\?\.detachGame\(\);/);
  // Restart and the next mission go through the session, not a reload.
  const restartAt = body.indexOf('const restartGame =');
  const restart = body.slice(restartAt, body.indexOf('const exit =', restartAt));
  assert.match(restart, /session\.replace\(/);
  assert.doesNotMatch(restart, /location\.reload\(\)/);
  const nextAt = body.indexOf('const playNext =');
  const next = body.slice(nextAt, body.indexOf('};', nextAt));
  assert.match(next, /session\.replace\(/);
  assert.doesNotMatch(next, /location\.reload\(\)/);
  // A game that stops before its first frame fails the loading screen instead of leaving it up (FirstFrameGuard).
  assert.match(body, /host\.on\('failed', \(message\) => \{[^}]*firstFrame\.fail\(/);
  assert.match(body, /function frame\(now\) \{\s*if \(stopped\) return;[^}]*firstFrame\.run\(\(\) => frameBody\(now\)\);/);
  // The first frame closes the screen; the game starts once it is gone (docs/contracts.md section 8, "Start").
  assert.match(body, /firstFrame\.firstFrame\(\)\.then\(\(\) => \{\s*if \(!stopped\) gameStart\.begin\(performance\.now\(\)\);/);
  assert.match(body, /const \{ raw: rawDt, dt \} = gameStart\.frame\(now\);/);
  assert.match(body, /const suspend = !gameStart\.started \|\|/);
  assert.match(body, /const on = gameStart\.started && runsInBackground\(/);
  assert.doesNotMatch(body, /Math\.min\(rawDt, 250\)/);
  assert.match(body, /if \(online && !online\.spectator\) \{\s*import\('\.\/net\.js'\)\s*\.then\(\(\{ sendLoaded \}\) => sendLoaded\(online\.driver\.conn\)\)/);
  // Every start's simulation is held until then.
  assert.equal(main.match(/host\.start\(\{ \.\.\.spec, held: true \}\)/g)?.length, 2);
  assert.equal(main.match(/host\.start\(/g)?.length, 2);
  // The campaign's progress is not shadowed by the save loading overlay (a won mission records its progress).
  assert.doesNotMatch(body, /const progress = /);
});

test('sound: the left game\'s sounds and lines stop, its game over music ends, the playlist goes on', async () => {
  const { AudioSystem } = await import('../js/audio/index.js');
  const audio = new AudioSystem({ registry: createRegistry({ storage: memoryStorage() }), doc: null });
  await audio.loaded;
  audio.prefs.set({ enabled: true });
  audio.attachGame({ game: { set_audio_events() {}, map_width: () => 64 }, rules: { actors: [], weapons: [], pxPerCell: 24, players: [] }, player: 0, worldUnitsPerCell: 1024 });
  const stopped = [];
  audio.mixer.stopBus = (bus) => stopped.push(bus);
  let spoken = true;
  audio.speech.cancel = () => (spoken = false);
  const handle = { stopped: false };
  handle.stop = () => (handle.stopped = true);
  audio.notifications.set('RadarUp', [handle]);
  audio.announcer.queue.push({ key: 'lowPower', at: 0, world: true });
  audio.deferred.push({ at: 0, run: 0, world: true, play() {} });
  audio.gameOverTrack = 'score';
  audio.setPaused(true);
  audio.detachGame();
  assert.equal(audio.director, null);
  assert.equal(audio.game, null);
  assert.deepEqual(stopped.sort(), ['effects', 'voices'], 'effects and voices stop; the music bus plays on');
  assert.equal(spoken, false);
  assert.equal(handle.stopped, true);
  assert.equal(audio.notifications.size, 0);
  assert.equal(audio.announcer.queue.length, 0);
  assert.equal(audio.deferred.length, 0);
  assert.equal(audio.gameOverTrack, null);
  assert.equal(audio.paused, false);
  assert.equal(audio.inGame, true, 'still in a game: the music goes on into the next one');
  // The next game attaches as usual.
  audio.attachGame({ game: { set_audio_events() {}, map_width: () => 32 }, rules: { actors: [], weapons: [], pxPerCell: 24, players: [] }, player: 0, worldUnitsPerCell: 1024 });
  assert.ok(audio.director);
  assert.equal(audio.mapWidth, 32);
});

test('GPU: the left game\'s atlases and map textures are destroyed, and a new map size frees the old textures', async () => {
  const { Renderer } = await import('../js/renderer.js');
  const made = [];
  const tex = (name) => {
    const t = { name, destroyed: false, createView: () => ({}) };
    t.destroy = () => (t.destroyed = true);
    made.push(t);
    return t;
  };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
  const r = Object.create(Renderer.prototype);
  r.device = { createTexture: () => tex('map'), createBindGroup: () => ({}) };
  r.fogLayout = {};
  r.linearSampler = {};
  r.setMapSize(64, 64);
  const first = made.slice();
  assert.equal(first.length, 3);
  r.setMapSize(96, 96);
  assert.ok(first.every((t) => t.destroyed), 'the old terrain, cell and fog textures are destroyed');
  for (const key of ['atlasTex', 'maskTex', 'frames', 'terrainAtlasTex']) r[key] = tex(key);
  const live = ['atlasTex', 'maskTex', 'frames', 'terrainTex', 'cellTex', 'fogTex', 'terrainAtlasTex'].map((k) => r[k]);
  r.spriteGroup = {};
  r.releaseGame();
  assert.ok(live.every((t) => t.destroyed), 'every texture and the frame table of the game');
  assert.equal(r.atlasTex, null);
  assert.equal(r.spriteGroup, null);
  assert.equal(r.fogGroup, null);
  r.releaseGame();
});

test('the simulation on the main thread: release stops background ticks and frees the game once', async () => {
  const { SimCore } = await import('../js/sim/core.js');
  let ids = 0;
  const live = new Set();
  const timers = {
    setInterval: () => (live.add(++ids), ids),
    clearInterval: (id) => live.delete(id),
  };
  const core = new SimCore({ Game: {}, memory: () => null, timers });
  let freed = 0;
  core.game = { free: () => freed++ };
  core.background = { id: timers.setInterval(() => {}), last: 0 };
  let stoppedDriver = 0;
  core.driver = { stop: () => stoppedDriver++ };
  core.release();
  assert.equal(freed, 1);
  assert.equal(stoppedDriver, 1);
  assert.equal(live.size, 0, 'no background tick runs on');
  assert.equal(core.game, null);
  core.release();
  assert.equal(freed, 1);
});
