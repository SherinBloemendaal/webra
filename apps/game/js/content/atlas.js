// Sprite slots from installed original graphics and texture packs, for
// js/sprites.js buildAtlas (`opts.slots`). Every actor type has two slots
// (engine/src/render.rs SpriteIds): the body (2t) and the second slot
// (2t + 1: turret, or the prone pose of infantry). A slot from here is a
// pose table (`{ images, poses }`, POSE_COUNT descriptors): which frames each
// pose the engine reports shows, facing by facing (js/content/sequences.js).
//
// Priority per slot: texture pack (first enabled pack in the player's order)
// > original content > WebRA's own art. When the body comes from the
// original graphics, the second slot does too (OpenRA draws no turret for
// most turreted structures: the turret is part of the body), so WebRA art is
// never mixed into an original actor.
//
// Structures made of several parts the way OpenRA draws them:
// - the bib (OpenRA WithBuildingBib: terrain tiles under the bottom two rows
//   of the footprint) is painted under every frame of the body;
// - a layer drawn over the body (OpenRA WithProductionDoorOverlay: the War
//   Factory's roof and door) takes the second slot and is listed in
//   `layers`: the engine draws it over the structure (engine/src/overlays.rs),
//   hides it while the structure is being built and otherwise names the door
//   frame (engine/src/doors.rs) in the age of the idle or damaged pose, so
//   those poses show frame `age` of the door sequence (MODE.INDEX) instead of
//   looping it.

import { ACTOR_ART, ACTOR_PALETTE, SEQUENCES, TERRAIN } from './tables.js';
import { decodeSprite, trimFrame } from './shp.js';
import { ACTOR_SHADOW, TERRAIN_SHADOW, decodePalette, paletteLookup } from './palette.js';
import { MODE, POSE, POSE_COUNT, resolveSequence, sequenceFile } from './sequences.js';

/** WebRA biome -> OpenRA tileset id. */
export const TILESET_OF_BIOME = Object.freeze({ temperate: 'TEMPERAT', snow: 'SNOW', desert: 'DESERT' });

const SHADOW_INDEX = ACTOR_SHADOW[0];
/** World pixels per cell. */
const CELL_PX = 24;
/** Rows of the footprint a bib covers (OpenRA WithBuildingBib without a mini bib). */
const BIB_ROWS = 2;

/** A cache of decoded sprite files over `getFile(name) -> Uint8Array | null`. */
export function spriteFiles(getFile) {
  const cache = new Map();
  return {
    get(name) {
      if (!cache.has(name)) {
        let sprite = null;
        let error = null;
        const bytes = getFile(name);
        if (bytes) {
          try {
            sprite = decodeSprite(bytes);
          } catch (err) {
            error = err.message;
          }
        } else {
          error = 'missing';
        }
        cache.set(name, { sprite, error });
      }
      return cache.get(name);
    },
  };
}

/** An 8-bit frame (with an optional shadow frame of the same size) as an atlas image. */
export function indexedImage(frame, shadow, lookup, offset) {
  let src = frame;
  if (shadow) {
    // ShadowStart: shadow pixels under the frame, drawn with the shadow index.
    const data = frame.data.slice();
    for (let i = 0; i < data.length; i++) if (data[i] === 0 && shadow.data[i] !== 0) data[i] = SHADOW_INDEX;
    src = { width: frame.width, height: frame.height, data };
  }
  const t = trimFrame(src);
  const color = new Uint8ClampedArray(t.width * t.height * 4);
  const mask = new Uint8Array(t.width * t.height);
  let team = false;
  for (let i = 0; i < t.data.length; i++) {
    const v = t.data[i];
    if (v === 0) continue;
    color.set(lookup.color.subarray(v * 4, v * 4 + 4), i * 4);
    mask[i] = lookup.mask[v];
    if (mask[i]) team = true;
  }
  return { width: t.width, height: t.height, color, mask: team ? mask : null, offset: [t.offset[0] + offset[0], t.offset[1] + offset[1]], scale: 1 };
}

/** Left and top edges of an atlas image (its offset is its centre). */
const edges = (img) => [img.offset[0] - img.width / 2, img.offset[1] - img.height / 2];

/**
 * An atlas image with `under` painted beneath `top` ("over" compositing).
 * Both keep their place: the result covers both rectangles, `top`'s pixels
 * stay where they were (`under` is rounded to whole pixels against it).
 */
export function compositeUnder(top, under) {
  if (!under || !under.width) return top;
  const [tl, tt] = edges(top);
  const [ul, ut] = edges(under);
  const dx = Math.round(ul - tl);
  const dy = Math.round(ut - tt);
  const x0 = Math.min(0, dx);
  const y0 = Math.min(0, dy);
  const width = Math.max(top.width, dx + under.width) - x0;
  const height = Math.max(top.height, dy + under.height) - y0;
  const color = new Uint8ClampedArray(width * height * 4);
  const mask = top.mask ? new Uint8Array(width * height) : null;
  for (let y = 0; y < under.height; y++) {
    color.set(under.color.subarray(y * under.width * 4, (y + 1) * under.width * 4), ((y + dy - y0) * width + dx - x0) * 4);
  }
  for (let y = 0; y < top.height; y++) {
    for (let x = 0; x < top.width; x++) {
      const s = y * top.width + x;
      const ta = top.color[s * 4 + 3];
      if (!ta) continue;
      const d = (y - y0) * width + x - x0;
      const ua = color[d * 4 + 3];
      if (ta === 255 || !ua) {
        color.set(top.color.subarray(s * 4, s * 4 + 4), d * 4);
      } else {
        const t = ta / 255;
        const u = (ua / 255) * (1 - t);
        const a = t + u;
        for (let k = 0; k < 3; k++) color[d * 4 + k] = Math.round((top.color[s * 4 + k] * t + color[d * 4 + k] * u) / a);
        color[d * 4 + 3] = Math.round(a * 255);
      }
      if (mask) mask[d] = top.mask[s];
    }
  }
  return { width, height, color, mask, offset: [tl + x0 + width / 2, tt + y0 + height / 2], scale: top.scale ?? 1 };
}

/**
 * The bib of a structure (OpenRA WithBuildingBib) as an atlas image centred
 * on the footprint: tile i of the bib template lies in footprint column
 * i % width and row i / width + height - 2, drawn with the theater's
 * terrain palette. Null when the template is missing or empty.
 * @param {{ data: Uint8Array, width: number, height: number } | null)[]} tiles the template's tiles
 */
export function bibImage(tiles, lookup, width, height) {
  const rows = Math.min(BIB_ROWS, height);
  const w = width * CELL_PX;
  const h = rows * CELL_PX;
  const color = new Uint8ClampedArray(w * h * 4);
  let any = false;
  for (let i = 0; i < width * rows && i < tiles.length; i++) {
    const t = tiles[i];
    if (!t || t.width !== CELL_PX || t.height !== CELL_PX) continue;
    const ox = (i % width) * CELL_PX;
    const oy = Math.floor(i / width) * CELL_PX;
    for (let y = 0; y < CELL_PX; y++) {
      for (let x = 0; x < CELL_PX; x++) {
        const v = t.data[y * CELL_PX + x];
        if (v === 0) continue;
        color.set(lookup.color.subarray(v * 4, v * 4 + 4), ((oy + y) * w + ox + x) * 4);
        any = true;
      }
    }
  }
  if (!any) return null;
  // Centre of the bottom `rows` rows relative to the footprint's centre.
  const offset = [0, (height - rows) * CELL_PX + h / 2 - (height * CELL_PX) / 2];
  return { width: w, height: h, color, mask: null, offset, scale: 1 };
}

/** The descriptor fields of a pose (buildAtlas reads them) from a resolved sequence. */
function descriptor(resolved, frames, mode, def) {
  return {
    frames,
    length: resolved.length,
    facings: resolved.facings,
    fps: resolved.fps,
    mode,
    classic: !!def.classic,
    interpolatedFacings: def.interpolatedFacings ?? 0,
    rotate: false,
  };
}

/**
 * Fill a pose table from the poses a slot has: every POSE gets a descriptor,
 * falling back to the idle pose (damaged still falls back to still).
 * `have` maps pose names (idle, move, attack, damaged, make, harvest, dock)
 * to { loop, once, still, index } descriptors. Walls and production doors
 * index their frames: the engine names the frame in the age (a wall's
 * connections, the door frame of OpenRA WithProductionDoorOverlay).
 */
export function poseTable(have, { wall = false, door = false } = {}) {
  const idle = have.idle;
  if (!idle) return null;
  const pick = (name) => have[name] ?? idle;
  const poses = new Array(POSE_COUNT);
  const main = (p) => (wall || door ? p.index : p.loop);
  poses[POSE.IDLE] = main(idle);
  poses[POSE.MOVE] = main(pick('move'));
  poses[POSE.ATTACK] = main(pick('attack'));
  poses[POSE.DAMAGED] = main(pick('damaged'));
  poses[POSE.MAKE] = have.make ? have.make.once : main(idle);
  poses[POSE.HARVEST] = main(pick('harvest'));
  poses[POSE.DOCK] = main(pick('dock'));
  poses[POSE.STILL] = idle.still;
  poses[POSE.DAMAGED_STILL] = (have.damaged ?? idle).still;
  // Standing infantry: stand2 loops, idle animations play once (then the idle pose).
  poses[POSE.STAND2] = main(pick('stand2'));
  poses[POSE.IDLE1] = have.idle1 ? have.idle1.once : main(idle);
  poses[POSE.IDLE2] = have.idle2 ? have.idle2.once : poses[POSE.IDLE1];
  // Deaths play once and vanish; a missing one falls back to die1 (the engine
  // only asks for them when the art has die1, see `deathArt`).
  const die1 = have.die1?.vanish ?? idle.vanish;
  for (let n = 1; n <= 6; n++) poses[POSE.DIE1 + n - 1] = have[`die${n}`]?.vanish ?? die1;
  poses[POSE.CRUSHED] = have.crushed?.vanish ?? die1;
  return poses;
}

/**
 * Pose tables of one OpenRA image's slot. `mapping` is pose name ->
 * sequence name (content/tables.js ACTOR_ART). Returns `{ art, problems }`
 * with `art` null when the idle pose cannot be made.
 */
function slotArt(image, mapping, { files, tileset, lookup, offset, wall, under = null, door = false }) {
  const seqs = SEQUENCES[image] ?? {};
  const images = [];
  const imageIndex = new Map();
  const problems = [];
  const have = {};
  for (const [pose, seqName] of Object.entries(mapping)) {
    const def = seqs[seqName];
    if (!def) continue;
    const file = sequenceFile(def, tileset);
    const { sprite, error } = files.get(file);
    if (!sprite) {
      problems.push(`${image}.${seqName}: ${file} ${error}`);
      continue;
    }
    let resolved;
    try {
      resolved = resolveSequence(def, sprite.frames.length);
    } catch (err) {
      problems.push(`${image}.${seqName}: ${err.message}`);
      continue;
    }
    const seqOffset = def.offset ?? [0, 0];
    const at = [seqOffset[0] + offset[0], seqOffset[1] + offset[1]];
    const frames = resolved.fileFrames.map((f, k) => {
      const shadowFrame = resolved.shadowFrames ? resolved.shadowFrames[k] : -1;
      const key = `${file}#${f}#${shadowFrame}#${at[0]},${at[1]}`;
      if (!imageIndex.has(key)) {
        const frame = sprite.frames[f];
        const shadow = shadowFrame >= 0 ? sprite.frames[shadowFrame] : null;
        imageIndex.set(key, images.length);
        const img = frame ? indexedImage(frame, shadow, lookup, at) : { width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: at, scale: 1 };
        images.push(under ? compositeUnder(img, under) : img);
      }
      return imageIndex.get(key);
    });
    have[pose] = {
      loop: descriptor(resolved, frames, MODE.LOOP, def),
      once: descriptor(resolved, frames, MODE.ONCE, def),
      still: descriptor(resolved, frames, MODE.STILL, def),
      index: descriptor(resolved, frames, MODE.INDEX, def),
      vanish: descriptor(resolved, frames, MODE.VANISH, def),
    };
  }
  const poses = poseTable(have, { wall, door });
  // `deaths`: the art has death sequences (js/sprites.js buildAtlas `deaths`).
  return { art: poses ? { images, poses, deaths: !!have.die1 } : null, problems };
}

/**
 * Sprite slots from the original graphics: `{ slots, layers, actors,
 * missing, problems }` where `slots` maps slot index -> pose table or null
 * (empty), `layers` holds the second slots drawn over a structure (see the
 * file comment),
 * `actors` lists the actor ids drawn with original art and `missing` those
 * without (they keep WebRA's art).
 * @param {Array<{ id: string, kind: string, centerOffset?: number[] }>} actors rules_json actors
 * @param {(name: string) => Uint8Array | null} getFile installed file bytes
 * @param {string} tileset OpenRA tileset id (TILESET_OF_BIOME)
 */
export function originalSlots(actors, getFile, tileset = 'TEMPERAT') {
  const out = { slots: new Map(), layers: new Set(), actors: [], missing: [], problems: [] };
  const palBytes = getFile(ACTOR_PALETTE);
  if (!palBytes) {
    out.problems.push(`${ACTOR_PALETTE} is not installed`);
    out.missing = actors.map((a) => a.id);
    return out;
  }
  let lookup;
  try {
    lookup = paletteLookup(decodePalette(palBytes), { remap: true, shadow: ACTOR_SHADOW });
  } catch (err) {
    out.problems.push(`${ACTOR_PALETTE}: ${err.message}`);
    out.missing = actors.map((a) => a.id);
    return out;
  }
  const files = spriteFiles(getFile);
  // Bibs are terrain: the theater's palette with its shadow indices.
  let terrainLookup = null;
  const terrainPalette = TERRAIN[tileset]?.palette;
  const terrainPal = terrainPalette ? getFile(terrainPalette) : null;
  if (terrainPal) {
    try {
      terrainLookup = paletteLookup(decodePalette(terrainPal), { remap: false, shadow: TERRAIN_SHADOW });
    } catch (err) {
      out.problems.push(`${terrainPalette}: ${err.message}`);
    }
  }
  const bibs = new Map();
  const bibOf = (image, seqName, a) => {
    const key = `${image}|${seqName}|${a.width}x${a.height}`;
    if (!bibs.has(key)) {
      let img = null;
      const def = SEQUENCES[image]?.[seqName];
      if (def && terrainLookup) {
        const file = sequenceFile(def, tileset);
        const { sprite, error } = files.get(file);
        if (sprite) img = bibImage(sprite.frames, terrainLookup, a.width ?? 1, a.height ?? 1);
        else out.problems.push(`${image}.${seqName}: ${file} ${error}`);
      }
      bibs.set(key, img);
    }
    return bibs.get(key);
  };
  const shared = new Map(); // image + slot kind + offset -> art (aliases share one copy)
  actors.forEach((a, t) => {
    const entry = ACTOR_ART[a.id];
    if (!entry) {
      if (a.kind !== 'mine' && a.kind !== 'proxy') out.missing.push(a.id);
      return;
    }
    const offset = a.kind === 'building' ? (a.centerOffset ?? [0, 0]) : [0, 0];
    const bib = a.kind === 'building' && entry.bib ? bibOf(entry.image, entry.bib, a) : null;
    const ctx = { files, tileset, lookup, offset, wall: !!entry.wall };
    const make = (part, mapping) => {
      const key = `${entry.image}|${part}|${offset.join(',')}|${JSON.stringify(mapping)}|${bib ? entry.bib : ''}|${a.width}x${a.height}`;
      if (!shared.has(key)) {
        const partCtx = { ...ctx, under: part === 'body' ? bib : null, door: part === 'second' && entry.overlay === 'door' };
        const r = slotArt(entry.image, mapping, partCtx);
        out.problems.push(...r.problems);
        shared.set(key, r.art);
      }
      return shared.get(key);
    };
    const body = make('body', entry.body);
    if (!body) {
      out.missing.push(a.id);
      return;
    }
    let second = Object.keys(entry.second ?? {}).length ? make('second', entry.second) : null;
    // Infantry without prone frames lie down as they stand.
    if (!second && a.kind === 'infantry') second = body;
    out.slots.set(2 * t, body);
    out.slots.set(2 * t + 1, second);
    if (second && entry.overlay) out.layers.add(2 * t + 1);
    out.actors.push(a.id);
  });
  return out;
}

/**
 * Combine slot sources by priority: `packs` (each `{ slots: Map }`, first
 * wins; a pack may map a slot to null to hide it), then `original`
 * (originalSlots), then WebRA's own art (slot left out). See the file
 * comment for the second-slot rule.
 * `layers` lists the second slots that are layers over a structure
 * (originalSlots `layers`) and came from the original graphics.
 * @returns {{ slots: Map<number, object | null>, source: Map<number, string>, layers: Set<number> }}
 */
export function combineSlots(actorCount, { packs = [], original = null } = {}) {
  const slots = new Map();
  const source = new Map();
  const layers = new Set();
  const fromPacks = (k) => {
    for (const p of packs) if (p.slots.has(k)) return { art: p.slots.get(k), name: p.name ?? 'pack' };
    return null;
  };
  for (let t = 0; t < actorCount; t++) {
    const bodyK = 2 * t;
    const secondK = bodyK + 1;
    const packBody = fromPacks(bodyK);
    let bodyFrom = 'webra';
    if (packBody) {
      slots.set(bodyK, packBody.art);
      source.set(bodyK, packBody.name);
      bodyFrom = 'pack';
    } else if (original?.slots.has(bodyK)) {
      slots.set(bodyK, original.slots.get(bodyK));
      source.set(bodyK, 'original');
      bodyFrom = 'original';
    }
    const packSecond = fromPacks(secondK);
    if (packSecond) {
      slots.set(secondK, packSecond.art);
      source.set(secondK, packSecond.name);
    } else if (original?.slots.has(secondK)) {
      const art = original.slots.get(secondK);
      if (art || bodyFrom === 'original') {
        slots.set(secondK, art);
        source.set(secondK, 'original');
        if (art && original.layers?.has(secondK)) layers.add(secondK);
      }
    }
  }
  // Specials (projectiles, effects, decorations) after the actor slots: packs only.
  for (const p of packs) {
    for (const [k, art] of p.slots) {
      if (k >= actorCount * 2 && !slots.has(k)) {
        slots.set(k, art);
        source.set(k, p.name ?? 'pack');
      }
    }
  }
  return { slots, source, layers };
}
