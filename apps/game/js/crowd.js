// Tick-rate instance records (engine/src/instances.rs) and the CPU reference
// of the GPU instance pass (shaders/instances.wgsl): the same interpolation,
// culling and stable compaction, in 32-bit floats (Math.fround after every
// operation, like the shader). Tests run it on records from
// Game.build_render_records and compare the result with Game.build_render;
// js/crowd-gpu.js runs the shader. No DOM, no WebGPU here.

export const SPRITE_REC_FLOATS = 13;
export const SPRITE_EXTRA_FLOATS = 12;
export const RECT_REC_FLOATS = 13;
export const INSTANCE_FLOATS = 8;
/** Invocations per workgroup of the compute pass (WG in the shader). */
export const WORKGROUP = 256;

const f = Math.fround;
const TAU = f(Math.PI * 2);

const lerp = (a, b, t) => f(a + f(f(b - a) * t));
const turnRadians = (a, turn, t) => f(f(f(a + f(turn * t)) * TAU) / 1024);

/** View::contains with a margin; a negative margin is never culled. */
function inView(view, x, y, margin) {
  if (margin < 0) return true;
  return x >= f(view[0] - margin) && x <= f(view[2] + margin) && y >= f(view[1] - margin) && y <= f(view[3] + margin);
}

export function spriteVisible(recs, i, alpha, view) {
  const b = i * SPRITE_REC_FLOATS;
  return inView(view, lerp(recs[b], recs[b + 2], alpha), lerp(recs[b + 1], recs[b + 3], alpha), recs[b + 4]);
}

export function rectVisible(recs, i, alpha, view) {
  const b = i * RECT_REC_FLOATS;
  return inView(view, lerp(recs[b], recs[b + 2], alpha), lerp(recs[b + 1], recs[b + 3], alpha), recs[b + 4]);
}

/** Whether sprite record `i` turns an arm with its body (sin and cos: the only inexact step across engines). */
export function spriteHasArm(recs, extras, i) {
  const e = recs[i * SPRITE_REC_FLOATS + 12];
  if (e < 0) return false;
  const k = e * SPRITE_EXTRA_FLOATS;
  return extras[k + 4] !== 0 || extras[k + 5] !== 0;
}

/** Sprite record `i` at `alpha`, written to `out` at instance `o` (write_sprite). */
export function writeSprite(recs, extras, i, alpha, out, o) {
  const b = i * SPRITE_REC_FLOATS;
  const t = alpha;
  let x = lerp(recs[b], recs[b + 2], t);
  let y = lerp(recs[b + 1], recs[b + 3], t);
  let angle = turnRadians(recs[b + 5], recs[b + 6], t);
  let scale = recs[b + 9];
  let a = recs[b + 10];
  const e = recs[b + 12];
  if (e >= 0) {
    const k = e * SPRITE_EXTRA_FLOATS;
    x = f(x + lerp(extras[k], extras[k + 2], t));
    y = f(y + lerp(extras[k + 1], extras[k + 3], t));
    const forward = extras[k + 4];
    const right = extras[k + 5];
    if (forward !== 0 || right !== 0) {
      // Forward is (sin, -cos) of the body angle, right is (cos, sin).
      const body = turnRadians(extras[k + 6], extras[k + 7], t);
      const s = f(Math.sin(body));
      const c = f(Math.cos(body));
      x = f(f(x + f(s * forward)) + f(c * right));
      y = f(f(y - f(c * forward)) + f(s * right));
    }
    angle = f(f(angle * extras[k + 8]) + extras[k + 9]);
    scale = lerp(scale, extras[k + 10], t);
    a = lerp(a, extras[k + 11], t);
  }
  const w = o * INSTANCE_FLOATS;
  out[w] = x;
  out[w + 1] = y;
  out[w + 2] = angle;
  out[w + 3] = recs[b + 7];
  out[w + 4] = recs[b + 8];
  out[w + 5] = scale;
  out[w + 6] = a;
  out[w + 7] = recs[b + 11];
}

/** Rect record `i` at `alpha`, written to `out` at instance `o` (write_rect). */
export function writeRect(recs, i, alpha, out, o) {
  const b = i * RECT_REC_FLOATS;
  const w = o * INSTANCE_FLOATS;
  out[w] = f(lerp(recs[b], recs[b + 2], alpha) + recs[b + 5]);
  out[w + 1] = f(lerp(recs[b + 1], recs[b + 3], alpha) + recs[b + 6]);
  for (let k = 2; k < 8; k++) out[w + k] = recs[b + 5 + k];
}

/**
 * The three dispatches of the shader on the CPU: visible flags and a total
 * per block of WORKGROUP records, the exclusive scan of the block totals
 * (the indirect draw count), then each visible record written at its block
 * offset plus its rank within the block. Returns `{ instances, count, args }`
 * where `args` are the drawIndirect arguments.
 */
export function runPass(kind, recs, extras, count, alpha, view) {
  const visible = kind === 'sprite' ? spriteVisible : rectVisible;
  const t = Math.min(Math.max(f(alpha), 0), 1);
  // The shader gets the view as f32 (Params.view), like the engine's View.
  view = Array.from(view, f);
  const blocks = Math.ceil(count / WORKGROUP);
  const blockSums = new Uint32Array(blocks);
  // *_count: inclusive scan within the block; its last element is the block total.
  for (let wg = 0; wg < blocks; wg++) {
    let sum = 0;
    for (let lid = 0; lid < WORKGROUP; lid++) {
      const i = wg * WORKGROUP + lid;
      if (i < count && visible(recs, i, t, view)) sum++;
    }
    blockSums[wg] = sum;
  }
  // scan: block totals to exclusive offsets, with a carry per chunk of WORKGROUP.
  let carry = 0;
  for (let i = 0; i < blocks; i++) {
    const v = blockSums[i];
    blockSums[i] = carry;
    carry += v;
  }
  const args = [6, carry, 0, 0];
  // *_write: rank within the block (inclusive scan of the flags) plus the block offset.
  const instances = new Float32Array(carry * INSTANCE_FLOATS);
  for (let wg = 0; wg < blocks; wg++) {
    let rank = 0;
    for (let lid = 0; lid < WORKGROUP; lid++) {
      const i = wg * WORKGROUP + lid;
      if (i >= count || !visible(recs, i, t, view)) continue;
      rank++;
      const o = blockSums[wg] + rank - 1;
      if (kind === 'sprite') writeSprite(recs, extras, i, t, instances, o);
      else writeRect(recs, i, t, instances, o);
    }
  }
  return { instances, count: carry, args };
}

/**
 * Both passes for one frame of records (`{ sprites, extras, rects }` as
 * Float32Arrays, see Game.build_render_records) at `alpha` and `view`
 * ([x0, y0, x1, y1] world pixels): what the renderer draws.
 */
export function evalFrame(records, alpha, view) {
  const s = runPass('sprite', records.sprites, records.extras, records.sprites.length / SPRITE_REC_FLOATS, alpha, view);
  const r = runPass('rect', records.rects, null, records.rects.length / RECT_REC_FLOATS, alpha, view);
  return { sprites: s.instances, spriteCount: s.count, rects: r.instances, rectCount: r.count };
}

/** Bytes of a records frame (what crosses to the main thread and the GPU when it changes). */
export function recordBytes(records) {
  if (!records) return 0;
  return (records.sprites.length + records.extras.length + records.rects.length) * 4;
}

/**
 * Which instance path to use this frame: the CPU path by default; the GPU pass
 * when asked for with `?instances=gpu` and available, unless the debug menu's
 * "CPU instance path" toggle is on.
 * @param {{ gpuReady: boolean, gpuReason?: string | null, requested?: string | null, forceCpu?: boolean }} o
 * @returns {{ path: 'cpu' | 'gpu', reason: string }}
 */
export function chooseInstancePath({ gpuReady, gpuReason = null, requested = null, forceCpu = false }) {
  if (requested === 'cpu') return { path: 'cpu', reason: 'asked for with ?instances=cpu' };
  if (forceCpu) return { path: 'cpu', reason: 'chosen in the debug menu' };
  // The GPU pass is opt-in until it has been seen working in browsers: ?instances=gpu.
  if (requested !== 'gpu') return { path: 'cpu', reason: 'default (the GPU pass is opt-in with ?instances=gpu)' };
  if (!gpuReady) return { path: 'cpu', reason: gpuReason ? `the GPU pass is unavailable: ${gpuReason}` : 'the GPU pass is unavailable' };
  return { path: 'gpu', reason: 'asked for with ?instances=gpu' };
}

/** Debug panel lines for the instance path (js/debug.js formatStats). */
export function instanceLines(info) {
  if (!info) return [];
  const label = info.path === 'gpu' ? 'GPU pass (records per tick, interpolated and culled per frame)' : 'CPU (built in the simulation every frame)';
  const lines = [`instances: ${label}, ${info.reason}`];
  if (info.buildMs !== undefined && info.buildMs !== null) {
    lines.push(`instance build ${info.buildMs.toFixed(2)} ms/frame  render data ${(info.bytes / 1024).toFixed(1)} KB/frame`);
  }
  return lines;
}
