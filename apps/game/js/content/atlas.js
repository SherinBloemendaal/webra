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

import { ACTOR_ART, ACTOR_PALETTE, SEQUENCES } from './tables.js';
import { decodeSprite, trimFrame } from './shp.js';
import { ACTOR_SHADOW, decodePalette, paletteLookup } from './palette.js';
import { MODE, POSE, POSE_COUNT, resolveSequence, sequenceFile } from './sequences.js';

/** WebRA biome -> OpenRA tileset id. */
export const TILESET_OF_BIOME = Object.freeze({ temperate: 'TEMPERAT', snow: 'SNOW', desert: 'DESERT' });

const SHADOW_INDEX = ACTOR_SHADOW[0];

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
 * to { looping, still } descriptor pairs; walls index their frames.
 */
export function poseTable(have, { wall = false } = {}) {
  const idle = have.idle;
  if (!idle) return null;
  const pick = (name) => have[name] ?? idle;
  const poses = new Array(POSE_COUNT);
  const main = (p) => (wall ? p.index : p.loop);
  poses[POSE.IDLE] = main(idle);
  poses[POSE.MOVE] = main(pick('move'));
  poses[POSE.ATTACK] = main(pick('attack'));
  poses[POSE.DAMAGED] = main(pick('damaged'));
  poses[POSE.MAKE] = have.make ? have.make.once : main(idle);
  poses[POSE.HARVEST] = main(pick('harvest'));
  poses[POSE.DOCK] = main(pick('dock'));
  poses[POSE.STILL] = idle.still;
  poses[POSE.DAMAGED_STILL] = (have.damaged ?? idle).still;
  return poses;
}

/**
 * Pose tables of one OpenRA image's slot. `mapping` is pose name ->
 * sequence name (content/tables.js ACTOR_ART). Returns `{ art, problems }`
 * with `art` null when the idle pose cannot be made.
 */
function slotArt(image, mapping, { files, tileset, lookup, offset, wall }) {
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
        images.push(frame ? indexedImage(frame, shadow, lookup, at) : { width: 0, height: 0, color: new Uint8ClampedArray(0), mask: null, offset: at, scale: 1 });
      }
      return imageIndex.get(key);
    });
    have[pose] = {
      loop: descriptor(resolved, frames, MODE.LOOP, def),
      once: descriptor(resolved, frames, MODE.ONCE, def),
      still: descriptor(resolved, frames, MODE.STILL, def),
      index: descriptor(resolved, frames, MODE.INDEX, def),
    };
  }
  const poses = poseTable(have, { wall });
  return { art: poses ? { images, poses } : null, problems };
}

/**
 * Sprite slots from the original graphics: `{ slots, actors, missing,
 * problems }` where `slots` maps slot index -> pose table or null (empty),
 * `actors` lists the actor ids drawn with original art and `missing` those
 * without (they keep WebRA's art).
 * @param {Array<{ id: string, kind: string, centerOffset?: number[] }>} actors rules_json actors
 * @param {(name: string) => Uint8Array | null} getFile installed file bytes
 * @param {string} tileset OpenRA tileset id (TILESET_OF_BIOME)
 */
export function originalSlots(actors, getFile, tileset = 'TEMPERAT') {
  const out = { slots: new Map(), actors: [], missing: [], problems: [] };
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
  const shared = new Map(); // image + slot kind + offset -> art (aliases share one copy)
  actors.forEach((a, t) => {
    const entry = ACTOR_ART[a.id];
    if (!entry) {
      if (a.kind !== 'mine') out.missing.push(a.id);
      return;
    }
    const offset = a.kind === 'building' ? (a.centerOffset ?? [0, 0]) : [0, 0];
    const ctx = { files, tileset, lookup, offset, wall: !!entry.wall };
    const make = (part, mapping) => {
      const key = `${entry.image}|${part}|${offset.join(',')}|${JSON.stringify(mapping)}`;
      if (!shared.has(key)) {
        const r = slotArt(entry.image, mapping, ctx);
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
    out.actors.push(a.id);
  });
  return out;
}

/**
 * Combine slot sources by priority: `packs` (each `{ slots: Map }`, first
 * wins; a pack may map a slot to null to hide it), then `original`
 * (originalSlots), then WebRA's own art (slot left out). See the file
 * comment for the second-slot rule.
 * @returns {{ slots: Map<number, object | null>, source: Map<number, string> }}
 */
export function combineSlots(actorCount, { packs = [], original = null } = {}) {
  const slots = new Map();
  const source = new Map();
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
  return { slots, source };
}
