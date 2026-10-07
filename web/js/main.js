// Boot: load the simulation (WebAssembly), the WebGPU renderer and the UI, then
// run the fixed-step game loop with interpolated rendering.

import init, { Game } from '../pkg/webra_sim.js';
import { Renderer } from './renderer.js';
import { buildAtlas } from './sprites.js';
import { Input } from './input.js';
import { Sidebar } from './sidebar.js';

const PLAYER = 0;
const MAX_TICKS_PER_FRAME = 8;

const $ = (id) => document.getElementById(id);

const SOVIET = ['soviet', 'russia', 'ukraine'];
const ALLIES = ['england', 'france', 'germany'];

let wasm;
let renderer;

async function boot() {
  try {
    wasm = await init();
    renderer = await Renderer.create($('view'));
  } catch (err) {
    $('menu-error').textContent = `${err.message} WebRA needs a browser with WebGPU (Chrome or Edge 113+, Safari 26+).`;
    $('menu-error').hidden = false;
    $('start').disabled = true;
    $('start-stress').disabled = true;
    return;
  }
  $('seed').value = String(Math.floor(Math.random() * 1e6));
  $('start').addEventListener('click', () => {
    const faction = $('faction').value;
    const pool = SOVIET.includes(faction) ? ALLIES : SOVIET.slice(1);
    const seed = Number($('seed').value) >>> 0;
    const ai = pool[seed % pool.length];
    start(new Game(seed, faction, ai, Number($('map-size').value)));
  });
  $('start-stress').addEventListener('click', () => {
    const units = Math.max(100, Math.min(200000, Number($('stress-units').value) || 10000));
    const size = Math.max(96, Math.ceil(Math.sqrt(units) * 2.2));
    start(Game.new_stress(Number($('seed').value) >>> 0, units, size), true);
  });
  $('again').addEventListener('click', () => location.reload());
}

function start(game, stress = false) {
  $('menu').hidden = true;
  $('app').hidden = false;
  const rules = JSON.parse(game.rules_json());
  renderer.setAtlas(buildAtlas(rules.actors));
  renderer.setMapSize(game.map_width(), game.map_height());

  let sidebar = null;
  const input = new Input($('view'), game, rules, PLAYER, {
    onSelectionChanged: (ids) => sidebar?.setSelection(selectionInfo(game, ids)),
    onPlaced: () => sidebar?.setPlacing(null),
    onCancelPlace: () => sidebar?.setPlacing(null),
    onNumpad: (slot, opts) => sidebar?.activateSlot(slot, opts),
    onTab: (dir) => sidebar?.cycleTab(dir),
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
  });

  // Handle for debugging from the browser console.
  window.webra = { game, input, sidebar, renderer, wasm, rules };
  const [sx, sy] = game.start_position(PLAYER);
  input.centerOn(sx, sy);
  if (stress) input.camera.zoom = 1;

  const tickMs = 1000 / Game.ticks_per_second();
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
    const spriteCount = game.build_render(PLAYER, acc / tickMs, v.x0, v.y0, v.x1, v.y1);
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
      updateHud(game, state, fps, simMs, stress);
      if (!over && !stress && state.winner !== null && state.winner !== undefined) {
        over = true;
        $('gameover-title').textContent = state.winner === PLAYER ? 'Mission accomplished' : 'Mission failed';
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

function updateHud(game, state, fps, simMs, stress) {
  const secs = Math.floor(state.tick / Game.ticks_per_second());
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const parts = [time, `${fps.toFixed(0)} fps`, `sim ${simMs.toFixed(2)} ms/tick`];
  if (stress) parts.push(`${game.actor_count()} units`, `${state.flowFields} flow fields`);
  $('hud').textContent = parts.join('  |  ');
}

boot();
