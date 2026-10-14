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
//
// Other parts:
// - helicopter rotors (OpenRA WithIdleOverlay@ROTOR*) take the second slot:
//   the ground sequence as the idle pose, the airborne one as the move pose,
//   a second rotor (the Chinook's) as the aux poses; the engine picks the
//   pose by altitude and draws each rotor at its offset (helicopter.rs);
// - an overlay spinning on a unit without a turret (OpenRA
//   WithIdleOverlay@SPINNER: the Radar Jammer's and the Mobile Gap
//   Generator's dishes) takes the second slot and is listed in
//   `unitOverlays` with its offset; on a turreted unit (the Tesla Tank) it
//   is drawn as the turret;
// - heights of turrets and overlays (the Z of OpenRA's offsets) are drawn
//   into their frames (ACTOR_ART `lift`);
// - the storage silo shows its fill level (OpenRA WithResourceLevelSpriteBody):
//   the engine names the stage in the age, MODE.INDEX;
// - special sprites (projectiles, explosions, the rally flag, mines; SPECIAL_ART)
//   after the actor slots: "effect" ones play once from the age the engine
//   gives with the make pose and then show nothing, the rest loop.

import { ACTOR_ART, ACTOR_PALETTE, EXPLOSION_ART, EXPLOSIONS, SEQUENCES, SPECIAL_ART, TERRAIN } from './tables.js';
import { SPECIALS } from './packs.js';
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

/**
 * A bridge template (OpenRA LegacyBridgeLayer: bridges are terrain tiles) as
 * an atlas image over the bridge's box: tile i of the template lies in
 * column i % width and row i / width of the template, which starts at the
 * box's top-left cell; `box` is the actor's footprint size in cells. Drawn
 * with the theater's terrain palette. Null when the template is empty.
 */
export function templateImage(tiles, lookup, [width, height], [boxW, boxH]) {
  const w = width * CELL_PX;
  const h = height * CELL_PX;
  const color = new Uint8ClampedArray(w * h * 4);
  let any = false;
  for (let i = 0; i < width * height && i < tiles.length; i++) {
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
  // Centre of the template relative to the centre of the actor's box.
  const offset = [w / 2 - (boxW * CELL_PX) / 2, h / 2 - (boxH * CELL_PX) / 2];
  return { width: w, height: h, color, mask: null, offset, scale: 1 };
}

/** A pose table of single still images (bridge states, art/pixel.js): `images[k]` for pose name `names[k]`. */
export function stillPoses(images, names) {
  const have = {};
  names.forEach((name, k) => {
    // Every way a pose can be played (deaths vanish too), like a loaded sequence.
    if (images[k]) have[name] = modes({ length: 1, facings: 1, fps: 1 }, [k], {});
  });
  const poses = poseTable(have);
  return poses ? { images: images.map((img) => img ?? images.find(Boolean)), poses } : null;
}

/**
 * Why a slot's art cannot go into the atlas, or null when it can: every
 * pose of POSE_COUNT needs frames that name images of the art (js/sprites.js
 * buildAtlas reads them all). Art that fails is left out, so only its own
 * slot keeps WebRA's art.
 */
export function artProblem(art) {
  if (!art) return null;
  const poses = art.poses ?? [];
  if (poses.length !== POSE_COUNT) return `${poses.length} poses instead of ${POSE_COUNT}`;
  for (let p = 0; p < POSE_COUNT; p++) {
    const d = poses[p];
    if (!d || !Array.isArray(d.frames) || !d.frames.length) return `pose ${p} is missing`;
    if (d.frames.some((f) => !Number.isInteger(f) || f < 0 || f >= art.images.length)) return `pose ${p} names an image the art does not have`;
  }
  return null;
}

/** `art` when it can go into the atlas (artProblem), else null with the reason in `problems`. */
function checked(name, art, problems) {
  const problem = artProblem(art);
  if (!problem) return art;
  problems.push(`${name}: ${problem}`);
  return null;
}

/** The descriptor fields of a pose (buildAtlas reads them) from a resolved sequence. */
function descriptor(resolved, frames, mode, def, lead = 0) {
  return {
    frames,
    length: resolved.length,
    facings: resolved.facings,
    fps: resolved.fps,
    mode,
    classic: !!def.classic,
    interpolatedFacings: def.interpolatedFacings ?? 0,
    rotate: false,
    lead,
  };
}

/** A frame mirrored left to right and/or top to bottom (OpenRA FlipX, FlipY). */
export function flipFrame(frame, flipX, flipY) {
  if (!frame || (!flipX && !flipY)) return frame;
  const { width: w, height: h } = frame;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = frame.data[(flipY ? h - 1 - y : y) * w + (flipX ? w - 1 - x : x)];
  }
  return { ...frame, data };
}

/**
 * The frames a sequence indexes, as `{ frames: [{ frame, offset, scale, key }] }`
 * or `{ error }`: the frames of its file, or for an OpenRA Combine the frames
 * of every part one after the other (each part a file's listed frames, or
 * all of them), with the part's offset, flips and scale applied. The
 * sequence's Start, Length, Facings and Frames then index this list
 * (OpenRA DefaultSpriteSequence: a virtual sprite file).
 */
export function sequenceFrames(def, files, tileset) {
  const parts = def.parts ?? [{ file: def.file, tilesets: def.tilesets, scale: def.scale }];
  const frames = [];
  for (const part of parts) {
    const file = sequenceFile(part, tileset);
    // No original on this tileset (OpenRA drew it, tools/gen_content_tables.py): WebRA art.
    if (!file) return { none: true };
    const { sprite, error } = files.get(file);
    if (!sprite) return { error: `${file} ${error}` };
    const list = part.frames ?? sprite.frames.map((_, i) => i);
    for (const f of list) {
      if (f < 0 || f >= sprite.frames.length) return { error: `${file} has no frame ${f}` };
      frames.push({
        frame: flipFrame(sprite.frames[f], part.flipX, part.flipY),
        offset: part.offset ?? [0, 0],
        scale: part.scale ?? 1,
        key: `${file}#${f}#${part.flipX ? 1 : 0}${part.flipY ? 1 : 0}#${part.scale ?? 1}`,
      });
    }
  }
  return { frames };
}

/** The ways a loaded sequence can be played (vanish: once, then nothing, for deaths); art/pixel.js too. */
export function modes(resolved, frames, def, lead = 0) {
  return {
    loop: descriptor(resolved, frames, lead ? MODE.LEAD : MODE.LOOP, def, lead),
    once: descriptor(resolved, frames, MODE.ONCE, def),
    still: descriptor(resolved, frames, MODE.STILL, def),
    index: descriptor(resolved, frames, MODE.INDEX, def),
    vanish: descriptor(resolved, frames, MODE.VANISH, def),
  };
}

/**
 * Two sequences one after the other, facing by facing (OpenRA plays the
 * first, then the second): `{ resolved, frames }` with the frames of
 * facing f the first's then the second's. Null when their facings differ.
 */
function joined(a, b) {
  if (a.resolved.facings !== b.resolved.facings) return null;
  const facings = a.resolved.facings;
  const la = a.resolved.length;
  const lb = b.resolved.length;
  const frames = [];
  for (let f = 0; f < facings; f++) frames.push(...a.frames.slice(f * la, (f + 1) * la), ...b.frames.slice(f * lb, (f + 1) * lb));
  return { resolved: { ...b.resolved, length: la + lb }, frames, def: b.def };
}

/** A sequence played backwards, facing by facing (OpenRA PlayBackwards). */
function reversed(a) {
  const l = a.resolved.length;
  const frames = [];
  for (let f = 0; f < a.resolved.facings; f++) frames.push(...a.frames.slice(f * l, (f + 1) * l).reverse());
  return { ...a, frames };
}

/**
 * Fill a pose table from the poses a slot has: every POSE gets a descriptor,
 * falling back to the idle pose (damaged still falls back to still).
 * `have` maps pose names (idle, move, attack, damaged, make, harvest, dock,
 * aux-idle, aux-move, active, damaged-active, parachute, active-end, and
 * the infantry's stand2, idle1, idle2, die1..die6, crushed, attack2) to { loop,
 * once, still, index, vanish } descriptors. Walls and production doors
 * index their frames: the engine names the frame in the age (a wall's
 * connections, the door frame of OpenRA WithProductionDoorOverlay).
 * `activeMode` "once" plays the working poses once from the age the engine
 * gives (a Tesla charge, a launch), "loop" repeats them; a working pose
 * with a lead-in loops after it either way. The active-end pose plays
 * once and then shows idle.
 */
export function poseTable(have, { wall = false, door = false, level = false, activeMode = 'loop' } = {}) {
  const idle = have.idle;
  if (!idle) return null;
  const pick = (name) => have[name] ?? idle;
  const poses = new Array(POSE_COUNT);
  const main = (p) => (wall || door || level ? p.index : p.loop);
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
  // A second attack sequence (Tanya shoots left or right), else the first.
  poses[POSE.ATTACK2] = have.attack2 ? main(have.attack2) : poses[POSE.ATTACK];
  // A second overlay (a second rotor) falls back to the first one's poses.
  poses[POSE.AUX_IDLE] = main(have['aux-idle'] ?? idle);
  poses[POSE.AUX_MOVE] = main(have['aux-move'] ?? pick('move'));
  const working = (p) => (activeMode === 'once' && p.loop.mode !== MODE.LEAD ? p.once : p.loop);
  poses[POSE.ACTIVE] = have.active ? working(have.active) : poses[POSE.IDLE];
  poses[POSE.DAMAGED_ACTIVE] = have['damaged-active'] ? working(have['damaged-active']) : have.active ? poses[POSE.ACTIVE] : poses[POSE.DAMAGED];
  poses[POSE.PARACHUTE] = have.parachute ? have.parachute.loop : poses[POSE.IDLE];
  poses[POSE.ACTIVE_END] = have['active-end'] ? have['active-end'].once : poses[POSE.IDLE];
  // A structure being sold or a Construction Yard packing up plays its make
  // animation backwards (OpenRA WithMakeAnimation.Reverse), once from the age.
  poses[POSE.UNMAKE] = have.make ? backwards(have.make.once) : main(idle);
  return poses;
}

/** A pose descriptor with the frames of each facing in reverse order. */
function backwards(d) {
  const frames = [];
  for (let f = 0; f < d.facings; f++) frames.push(...d.frames.slice(f * d.length, (f + 1) * d.length).reverse());
  return { ...d, frames };
}

/** Module order of the special slots after SPECIALS (js/sprites.js spriteList, engine/src/render.rs SpriteIds). */
export const SPECIAL_MODULES = Object.freeze(['naval', 'planes', 'helis', 'abilities', 'veterancy', 'decorations', 'fx', 'leftovers', 'infantry']);
/** Special slots per art module (js/sprites.js SPECIAL_SLOTS). */
export const MODULE_SPECIAL_SLOTS = 8;

/** The slot of a SPECIAL_ART key ("missile", "naval.0") for `actorCount` actors, or -1. */
export function specialSlot(key, actorCount) {
  const base = actorCount * 2;
  const core = SPECIALS.indexOf(key);
  if (core >= 0) return base + core;
  const [mod, index] = key.split('.');
  const m = SPECIAL_MODULES.indexOf(mod);
  const k = Number(index);
  if (m < 0 || !Number.isInteger(k) || k < 0 || k >= MODULE_SPECIAL_SLOTS) return -1;
  return base + SPECIALS.length + m * MODULE_SPECIAL_SLOTS + k;
}

/** The first slot after the special sprites: actor `t`'s muzzle flash (engine/src/render.rs SpriteIds `muzzle_base`). */
export function muzzleSlot(t, actorCount) {
  return actorCount * 2 + SPECIALS.length + SPECIAL_MODULES.length * MODULE_SPECIAL_SLOTS + t;
}

/** Explosion `k` of EXPLOSIONS (engine/render.json), after the muzzle slots. */
export function explosionSlot(k, actorCount) {
  return muzzleSlot(actorCount, actorCount) + k;
}

/**
 * Pose tables of one OpenRA image's slot. `mapping` is pose name ->
 * sequence name (content/tables.js ACTOR_ART); `lead` names a sequence
 * played once before a pose's own (which then loops), `reverseEnd` plays
 * the active-end pose backwards. `effect` makes an effect slot: the make
 * pose plays the idle sequence once, every other pose shows nothing.
 * `index` makes every pose name its frame in the age. Returns `{ art,
 * problems }` with `art` null when the idle pose cannot be made.
 */
function slotArt(image, mapping, opts) {
  const r = buildSlotArt(image, mapping, opts);
  return { art: checked(image, r.art, r.problems), problems: r.problems };
}

/** slotArt before the art is checked. */
function buildSlotArt(image, mapping, opts) {
  const { files, tileset, lookup, offset, wall, under = null, door = false, level = false, lift = {}, effect = false, index = false } = opts;
  const { lead = {}, reverseEnd = false, activeMode = 'loop' } = opts;
  const seqs = SEQUENCES[image] ?? {};
  const images = [];
  const imageIndex = new Map();
  const problems = [];
  const have = {};
  const load = (seqName, pose) => {
    const def = seqs[seqName];
    if (!def) return null;
    // The frames the sequence indexes: one file's, or a Combine's parts one after the other.
    const source = sequenceFrames(def, files, tileset);
    if (source.none) return null; // no original on this tileset: WebRA art
    if (source.error) {
      problems.push(`${image}.${seqName}: ${source.error}`);
      return null;
    }
    let resolved;
    try {
      resolved = resolveSequence(def, source.frames.length);
    } catch (err) {
      problems.push(`${image}.${seqName}: ${err.message}`);
      return null;
    }
    const seqOffset = def.offset ?? [0, 0];
    const frames = resolved.fileFrames.map((f, k) => {
      const shadowFrame = resolved.shadowFrames ? resolved.shadowFrames[k] : -1;
      const src = source.frames[f];
      const at = [seqOffset[0] + offset[0] + src.offset[0], seqOffset[1] + offset[1] + src.offset[1] + (lift[pose] ?? 0)];
      const key = `${src.key}#${shadowFrame}#${at[0]},${at[1]}`;
      if (!imageIndex.has(key)) {
        const frame = src.frame;
        const shadow = shadowFrame >= 0 ? source.frames[shadowFrame]?.frame : null;
        imageIndex.set(key, images.length);
        const img = frame ? indexedImage(frame, shadow, lookup, at) : { width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: at, scale: 1 };
        if (src.scale !== 1) img.scale = src.scale;
        // OpenRA sequence Scale (the snow hut): drawn smaller, around its offset.
        if (def.scale && !def.parts) img.offset = [img.offset[0] * def.scale, img.offset[1] * def.scale];
        images.push(under ? compositeUnder(img, under) : img);
      }
      return imageIndex.get(key);
    });
    return { resolved, frames, def };
  };
  for (const [pose, seqName] of Object.entries(mapping)) {
    const names = Array.isArray(seqName) ? seqName : [seqName];
    let seq = null;
    for (const name of names) {
      const next = load(name, pose);
      if (!next) {
        seq = null;
        break;
      }
      seq = seq ? joined(seq, next) : next;
      if (!seq) {
        problems.push(`${image}.${names.join('+')}: the sequences have different facings`);
        break;
      }
    }
    if (!seq) continue;
    let leadLength = 0;
    if (lead[pose]) {
      const first = load(lead[pose], pose);
      const both = first && joined(first, seq);
      if (both) {
        leadLength = first.resolved.length;
        seq = both;
      } else if (first) problems.push(`${image}.${lead[pose]}: facings differ from ${seqName}`);
    }
    if (pose === 'active-end' && reverseEnd) seq = reversed(seq);
    have[pose] = modes(seq.resolved, seq.frames, seq.def, leadLength);
  }
  if (effect && have.idle) {
    // Plays once from the age the engine gives with the make pose, then nothing.
    const blank = images.length;
    images.push({ width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: [0, 0], scale: 1 });
    const once = have.idle.once;
    const empty = { ...have.idle.still, frames: [blank], length: 1, facings: 1, mode: MODE.STILL };
    const poses = new Array(POSE_COUNT).fill(empty);
    poses[POSE.MAKE] = once;
    return { art: { images, poses }, problems };
  }
  if (index && have.idle) return { art: { images, poses: new Array(POSE_COUNT).fill(have.idle.index) }, problems };
  const poses = poseTable(have, { wall, door, level, activeMode });
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
  const out = { slots: new Map(), layers: new Set(), unitOverlays: [], levels: [], smoke: null, fires: [], specials: [], explosions: [], actors: [], missing: [], problems: [] };
  const palBytes = getFile(ACTOR_PALETTE);
  if (!palBytes) {
    out.problems.push(`${ACTOR_PALETTE} is not installed`);
    out.missing = actors.map((a) => a.id);
    return out;
  }
  out.actorCount = actors.length;
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
        const { sprite, error } = file ? files.get(file) : { sprite: null, error: null };
        if (sprite) img = bibImage(sprite.frames, terrainLookup, a.width ?? 1, a.height ?? 1);
        else if (file) out.problems.push(`${image}.${seqName}: ${file} ${error}`);
      }
      bibs.set(key, img);
    }
    return bibs.get(key);
  };
  const shared = new Map(); // image + slot kind + offset -> art (aliases share one copy)
  // Bridges: the body shows the healthy and damaged templates (poses idle and
  // damaged), the second slot the destroyed ones (engine bridges.rs
  // bridge_sprite: idle destroyed, move with the north span, attack with
  // the south span, harvest both).
  const bridgeArt = (a, entry) => {
    const rec = entry.bridge?.[tileset];
    if (!rec || !terrainLookup) return null;
    const image = (state) => {
      const file = rec[state];
      if (!file) return null;
      const { sprite, error } = files.get(file);
      if (!sprite) {
        out.problems.push(`${a.id}: ${file} ${error}`);
        return null;
      }
      return templateImage(sprite.frames, terrainLookup, rec.size, [a.width ?? 1, a.height ?? 1]);
    };
    const body = checked(a.id, stillPoses([image('healthy'), image('damaged')], ['idle', 'damaged']), out.problems);
    const second = checked(
      `${a.id} destroyed`,
      stillPoses([image('destroyed'), image('destroyed_north'), image('destroyed_south'), image('destroyed_both')], ['idle', 'move', 'attack', 'harvest']),
      out.problems,
    );
    return body ? { body, second } : null;
  };
  actors.forEach((a, t) => {
    const entry = ACTOR_ART[a.id];
    // No entry, or only a muzzle flash (no original body: WebRA's own art, the flash below).
    if (!entry || (!entry.body && !entry.bridge)) {
      if (a.kind !== 'proxy') out.missing.push(a.id);
      return;
    }
    if (entry.bridge) {
      const art = bridgeArt(a, entry);
      if (!art) {
        out.missing.push(a.id);
        return;
      }
      out.slots.set(2 * t, art.body);
      out.slots.set(2 * t + 1, art.second);
      out.actors.push(a.id);
      return;
    }
    const offset = a.kind === 'building' ? (a.centerOffset ?? [0, 0]) : [0, 0];
    const bib = a.kind === 'building' && entry.bib ? bibOf(entry.image, entry.bib, a) : null;
    const ctx = { files, tileset, lookup, offset, wall: !!entry.wall };
    const make = (part, mapping) => {
      const lift = part === 'second' ? (entry.lift ?? {}) : {};
      const key = `${entry.image}|${part}|${offset.join(',')}|${JSON.stringify(mapping)}|${JSON.stringify(lift)}|${bib ? entry.bib : ''}|${a.width}x${a.height}`;
      if (!shared.has(key)) {
        const partCtx = {
          ...ctx,
          under: part === 'body' ? bib : null,
          door: part === 'second' && entry.overlay === 'door',
          level: part === 'body' && !!entry.level,
          lift,
          lead: part === 'body' ? (entry.lead ?? {}) : {},
          reverseEnd: part === 'body' && !!entry.reverseEnd,
          // Turret recoil plays once per shot.
          activeMode: part === 'body' ? (entry.activeMode ?? 'loop') : 'once',
        };
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
    if (second && entry.unitOverlay) out.unitOverlays.push([t, entry.unitOverlay[0], entry.unitOverlay[1]]);
    if (entry.level) out.levels.push([t, body.poses[POSE.IDLE].length]);
    out.actors.push(a.id);
  });
  // Special sprites (SPECIAL_ART): null keeps WebRA's art.
  for (const [key, spec] of Object.entries(SPECIAL_ART)) {
    if (!spec) continue;
    const slot = specialSlot(key, actors.length);
    if (slot < 0) {
      out.problems.push(`special ${key}: no such slot`);
      continue;
    }
    const r = specialArt(spec, { files, tileset, lookup });
    out.problems.push(...r.problems);
    if (r.art) {
      out.slots.set(slot, r.art);
      out.specials.push(key);
      if (key === SMOKE_KEY) out.smoke = smokeFrames(spec, files, tileset);
      const fire = FIRE_KEYS.indexOf(key);
      if (fire >= 0) {
        const frames = sequenceLengths(spec, files, tileset, 3);
        if (frames) out.fires.push([fire, ...frames]);
      }
    }
  }
  // Muzzle flashes (ACTOR_ART muzzle, OpenRA WithMuzzleOverlay): once per shot.
  actors.forEach((a, t) => {
    const entry = ACTOR_ART[a.id];
    if (!entry?.muzzle) return;
    const r = specialArt({ image: entry.image, sequences: [entry.muzzle], mode: 'effect' }, { files, tileset, lookup });
    out.problems.push(...r.problems);
    if (r.art) out.slots.set(muzzleSlot(t, actors.length), r.art);
  });
  // Explosions per name (EXPLOSIONS, OpenRA CreateEffect warheads): once each.
  EXPLOSIONS.forEach((name, k) => {
    const spec = EXPLOSION_ART[name];
    if (!spec) return;
    const r = specialArt(spec, { files, tileset, lookup });
    out.problems.push(...r.problems);
    if (r.art) {
      out.slots.set(explosionSlot(k, actors.length), r.art);
      out.explosions.push(name);
    }
  });
  return out;
}

/** The damage smoke's special (start and loop frames in a row, the engine names the frame). */
const SMOKE_KEY = 'fx.0';

/**
 * The tree fires' specials (engine neutral.rs: small, medium and large, by
 * damage state): start, loop and end frames in a row, the engine names the frame.
 */
const FIRE_KEYS = ['decorations.2', 'decorations.4', 'decorations.5'];

/** [milliseconds per frame, frames of each sequence...] of a special with `n` sequences, or null. */
function sequenceLengths(spec, files, tileset, n) {
  const lengths = spec.sequences.map((name) => {
    const def = SEQUENCES[spec.image]?.[name];
    const file = def ? sequenceFile(def, tileset) : '';
    const { sprite } = file ? files.get(file) : {};
    try {
      return sprite ? resolveSequence(def, sprite.frames.length) : null;
    } catch {
      return null;
    }
  });
  if (lengths.length !== n || lengths.some((r) => !r)) return null;
  return [Math.round(1000 / lengths[1].fps), ...lengths.map((r) => r.length)];
}

/** [milliseconds per frame, start frames, loop frames] of the original damage smoke, or null. */
function smokeFrames(spec, files, tileset) {
  return sequenceLengths(spec, files, tileset, 2);
}

/** A special sprite's pose table from its SPECIAL_ART entry (see the table for the modes). */
function specialArt(spec, { files, tileset, lookup }) {
  const ctx = { files, tileset, lookup, offset: [0, 0], wall: false };
  if (spec.mode === 'lead') {
    return slotArt(spec.image, { idle: spec.sequences[1] }, { ...ctx, lead: { idle: spec.sequences[0] } });
  }
  return slotArt(spec.image, { idle: spec.sequences }, { ...ctx, effect: spec.mode === 'effect', index: spec.mode === 'index' });
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
  // Specials (projectiles, effects, decorations) after the actor slots: packs, then the original graphics.
  for (const p of packs) {
    for (const [k, art] of p.slots) {
      if (k >= actorCount * 2 && !slots.has(k)) {
        slots.set(k, art);
        source.set(k, p.name ?? 'pack');
      }
    }
  }
  if (original) {
    for (const [k, art] of original.slots) {
      if (k >= actorCount * 2 && !slots.has(k) && art) {
        slots.set(k, art);
        source.set(k, 'original');
      }
    }
  }
  return { slots, source, layers };
}

/** Kinds of the records of originalSlotInfo `info` (engine/src/overlays.rs ORIGINAL_INFO_*). */
export const ORIGINAL_INFO = Object.freeze({ OVERLAY: 0, LEVEL: 1, SMOKE: 2, FIRE: 3, FIRE_TAIL: 4 });

/**
 * What the engine needs to know about the original art in use
 * (Game.set_original_slots): `slots`, the slots drawn from the original
 * graphics (the engine then draws them the OpenRA way: rotor sequences
 * instead of WebRA's spinning blades, explosions that animate themselves,
 * projectiles with their own facings), and `info`, flat records [kind,
 * actor type, a, b]: an overlay drawn over a unit without a turret
 * (ORIGINAL_INFO.OVERLAY, forward and side offset in world units) for
 * those whose second slot is original, a structure whose original
 * body shows the storage level (ORIGINAL_INFO.LEVEL, the stage count) and
 * the original damage smoke (ORIGINAL_INFO.SMOKE: milliseconds per frame,
 * start frames, loop frames) and the tree fires (ORIGINAL_INFO.FIRE: size,
 * milliseconds per frame, start frames; FIRE_TAIL: size, loop and end frames).
 * `original` is originalSlots' result (or null).
 */
export function originalSlotInfo(source, original = null) {
  const slots = [...source].filter(([, from]) => from === 'original').map(([k]) => k).sort((a, b) => a - b);
  const info = [];
  for (const [t, fwd, side] of original?.unitOverlays ?? []) {
    if (source.get(2 * t + 1) === 'original') info.push(ORIGINAL_INFO.OVERLAY, t, fwd, side);
  }
  for (const [t, stages] of original?.levels ?? []) {
    if (source.get(2 * t) === 'original') info.push(ORIGINAL_INFO.LEVEL, t, stages, 0);
  }
  const smokeSlot = original ? specialSlot(SMOKE_KEY, (original.actorCount ?? 0)) : -1;
  if (original?.smoke && source.get(smokeSlot) === 'original') info.push(ORIGINAL_INFO.SMOKE, ...original.smoke);
  for (const [size, ms, start, loop, end] of original?.fires ?? []) {
    if (source.get(specialSlot(FIRE_KEYS[size], original.actorCount ?? 0)) !== 'original') continue;
    info.push(ORIGINAL_INFO.FIRE, size, ms, start, ORIGINAL_INFO.FIRE_TAIL, size, loop, end);
  }
  return { slots: Uint32Array.from(slots), info: Int32Array.from(info) };
}
