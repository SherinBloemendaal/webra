// Boot: load the simulation (WebAssembly), the WebGPU renderer and the lobby,
// then run the fixed-step game loop with interpolated rendering.

import init, { Game, version } from '../pkg/webra_sim.js';
import { Renderer, TEAM_COLORS } from './renderer.js';
import { buildAtlas } from './sprites.js';
import { Input } from './input.js';
import { Sidebar } from './sidebar.js';
import { Lobby } from './lobby.js';

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

async function boot() {
  let gpuError = null;
  try {
    wasm = await init();
  } catch (err) {
    gpuError = `Could not load the game engine: ${err.message}`;
  }
  $('version').textContent = wasm ? `v${version()}` : '';
  const lobby = new Lobby($('menu'), {
    colors: TEAM_COLORS,
    colorNames: COLOR_NAMES,
    mapPreview: (seed, size) => Game.map_preview(seed, size),
    onStart: (options) => startSkirmish(options, lobby),
    onStress: ({ seed, units }) => startStress(seed, units, lobby),
  });
  if (!gpuError) {
    try {
      renderer = await Renderer.create($('view'));
    } catch (err) {
      gpuError = `${err.message} WebRA needs a browser with WebGPU (Chrome or Edge 113+, Safari 26+).`;
    }
  }
  if (gpuError) lobby.showError(gpuError);
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
function applyColors(players) {
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

function startSkirmish(options, lobby) {
  if (!renderer) return;
  const resolved = resolveFactions(options);
  let game;
  try {
    game = Game.from_options(JSON.stringify(resolved));
  } catch (err) {
    lobby.showError(`Could not start the game: ${err.message ?? err}`);
    return;
  }
  applyColors(resolved.players);
  start(game, { stress: false, tickMs: SPEEDS[resolved.gameSpeed] ?? SPEEDS.normal });
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

function start(game, { stress, tickMs }) {
  $('menu').hidden = true;
  $('app').hidden = false;
  const rules = JSON.parse(game.rules_json());
  renderer.setAtlas(buildAtlas(rules.actors));
  renderer.setMapSize(game.map_width(), game.map_height());

  let sidebar = null;
  const input = new Input($('view'), game, rules, PLAYER, {
    onSelectionChanged: (ids) => {
      sidebar?.setSelection(selectionInfo(game, ids));
      sidebar?.setDeployState(input.deployState());
    },
    onPlaced: () => sidebar?.setPlacing(null),
    onCancelPlace: () => sidebar?.setPlacing(null),
    onNumpad: (slot, opts) => sidebar?.activateSlot(slot, opts),
    onTab: (dir) => sidebar?.cycleTab(dir),
    onSellMode: (on) => sidebar?.setSellMode(on),
  });
  sidebar = new Sidebar($('sidebar'), game, rules, PLAYER, {
    onPlace: (id) => {
      input.startPlacing(id);
      sidebar.setPlacing(id);
    },
    onCancelPlace: () => {
      input.placing = null;
      sidebar.setPlacing(null);
    },
    onSell: () => input.toggleSellMode(),
    onDeploy: () => input.deploySelection(),
  });
  // Handle for debugging from the browser console.
  window.webra = { game, input, sidebar, renderer, wasm, rules };
  const [sx, sy] = game.start_position(PLAYER);
  input.centerOn(sx, sy);
  if (stress) input.camera.zoom = 1;

  // ---- Pause --------------------------------------------------------------------
  let paused = false;
  const setPaused = (on) => {
    paused = on;
    $('pause').hidden = !on;
    $('pause-button').textContent = on ? 'Resume' : 'Pause';
  };
  $('pause-button').hidden = false;
  $('pause-button').addEventListener('click', () => setPaused(!paused));
  $('resume').addEventListener('click', () => setPaused(false));
  $('quit').addEventListener('click', () => location.reload());
  $('again').addEventListener('click', () => location.reload());
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'p' || e.key === 'P' || e.key === 'Pause' || e.key === 'F10') {
      e.preventDefault();
      setPaused(!paused);
    }
  });
  // A single-player game pauses when its tab is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !stress) setPaused(true);
  });

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
    if (!paused) {
      acc += dt;
      let ticks = 0;
      const t0 = performance.now();
      while (acc >= tickMs && ticks < MAX_TICKS_PER_FRAME) {
        game.tick();
        acc -= tickMs;
        ticks++;
      }
      if (ticks > 0) simMs = simMs * 0.9 + ((performance.now() - t0) / ticks) * 0.1;
      if (ticks === MAX_TICKS_PER_FRAME) acc = 0; // too slow: drop time instead of spiralling
    }

    input.update(dt / 1000);
    if (game.terrain_dirty()) {
      const ptr = game.terrain_ptr();
      renderer.uploadTerrain(new Uint8Array(wasm.memory.buffer, ptr, game.terrain_len()));
    }
    const fogPtr = game.fog_ptr(PLAYER);
    renderer.uploadFog(new Uint8Array(wasm.memory.buffer, fogPtr, game.fog_len()));

    // UI rects call into wasm (placement preview), which may grow its memory and
    // detach existing views, so collect them before taking views of wasm memory.
    const uiRects = input.uiRects();
    const v = input.viewRect();
    const spriteCount = game.build_render(PLAYER, paused ? 1 : acc / tickMs, v.x0, v.y0, v.x1, v.y1);
    const sprites = new Float32Array(wasm.memory.buffer, game.sprite_ptr(), spriteCount * 8);
    const simRectCount = game.rect_count();
    const rects = new Float32Array(simRectCount * 8 + uiRects.length);
    rects.set(new Float32Array(wasm.memory.buffer, game.rect_ptr(), simRectCount * 8));
    rects.set(uiRects, simRectCount * 8);
    renderer.draw(input.camera, now / 1000, sprites, spriteCount, rects, rects.length / 8);

    fpsFrames++;
    if (now - fpsTime >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsTime);
      fpsFrames = 0;
      fpsTime = now;
    }
    if (now - uiTime >= 100) {
      uiTime = now;
      input.refreshSelection();
      const state = JSON.parse(game.player_json(PLAYER));
      sidebar.update(state);
      sidebar.setSelection(selectionInfo(game, input.selection));
      sidebar.setDeployState(input.deployState());
      updateHud(game, state, fps, simMs, stress, paused);
      if (!over && !stress && (state.won || state.defeated || (state.winner !== null && state.winner !== undefined))) {
        over = true;
        $('gameover-title').textContent = state.won ? 'Mission accomplished' : 'Mission failed';
        $('gameover').hidden = false;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function selectionInfo(game, ids) {
  if (ids.length === 0) return null;
  if (ids.length === 1) return JSON.parse(game.actor_json(ids[0]));
  return { count: ids.length, name: `${ids.length} units selected` };
}

function updateHud(game, state, fps, simMs, stress, paused) {
  const secs = Math.floor(state.tick / Game.ticks_per_second());
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const parts = [paused ? `${time} (paused)` : time, `${fps.toFixed(0)} fps`, `sim ${simMs.toFixed(2)} ms/tick`];
  if (stress) parts.push(`${game.actor_count()} units`, `${state.flowFields} flow fields`);
  $('hud').textContent = parts.join('  |  ');
}

boot();
