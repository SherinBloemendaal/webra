// Sprite sequences the OpenRA way (OpenRA.Mods.Common DefaultSpriteSequence
// and OpenRA.Mods.Cnc ClassicSpriteSequence, GPL-3.0), and the facing and
// pose math the sprite shader runs (shaders/sprite.wgsl): the JavaScript
// here mirrors it operation by operation, and tests compare both with
// OpenRA's integer reference.
//
// Facings: OpenRA angles (WAngle) turn counter-clockwise, 1024 per turn,
// 0 = north; WebRA's turn clockwise. Pre-rendered frames are stored facing
// by facing counter-clockwise from north, so a WebRA facing `a` shows frame
// IndexFacing((1024 - a) & 1023).

/**
 * @typedef {object} SequenceDef  one entry of content/tables.js SEQUENCES
 * @property {string} file  default file name
 * @property {Record<string, string>} [tilesets]  file name per OpenRA tileset id
 * @property {object[]} [parts]  OpenRA Combine: `{ file, tilesets?, frames?, offset?,
 *   flipX?, flipY?, scale? }` per part; their frames one after the other make the
 *   virtual file the other fields index (js/content/atlas.js sequenceFrames)
 * @property {number} start
 * @property {number} length  frames per facing, -1 for "*" (all frames from start)
 * @property {number} [stride]
 * @property {number} facings  negative: stored clockwise
 * @property {number} tick  milliseconds per frame
 * @property {boolean} [classic]  UseClassicFacings (32 facings, uneven steps)
 * @property {number} [interpolatedFacings]
 * @property {number[]} [frames]  explicit frame list (indexes refer to it)
 * @property {boolean} [reverses]
 * @property {boolean} [transpose]
 * @property {number} [shadowStart]
 * @property {number[]} [offset]  [x, y] pixels
 * @property {number} [zOffset]
 * @property {number} [scale]  OpenRA Scale: drawn this much smaller or larger
 */

/**
 * Poses the engine reports per sprite when sprite poses are on
 * (Game.set_sprite_poses, engine/src/render.rs `Pose`). Same numbers there.
 */
export const POSE = Object.freeze({
  IDLE: 0,
  MOVE: 1,
  ATTACK: 2,
  DAMAGED: 3,
  MAKE: 4,
  HARVEST: 5,
  DOCK: 6,
  STILL: 7,
  DAMAGED_STILL: 8,
  /** A second overlay of the slot (the Chinook's rear rotor): on the ground, and in the air. */
  AUX_IDLE: 9,
  AUX_MOVE: 10,
  /** Working (engine/src/fx.rs): resupplying, charging, launching, placing, recoiling, unloading, reloading. */
  ACTIVE: 11,
  DAMAGED_ACTIVE: 12,
  /** A paratrooper falling under its parachute. */
  PARACHUTE: 13,
  /** Done working: the landing craft closing, the harvester leaving the refinery. */
  ACTIVE_END: 14,
  // Standing infantry: the second stand sequence and the idle animations.
  STAND2: 15,
  IDLE1: 16,
  IDLE2: 17,
  // Dying infantry: die1..die6 and the crushed body (WithDeathAnimation).
  DIE1: 18,
  DIE2: 19,
  DIE3: 20,
  DIE4: 21,
  DIE5: 22,
  DIE6: 23,
  CRUSHED: 24,
  // A soldier's second attack sequence (AttackSequences: OpenRA picks one per shot).
  ATTACK2: 25,
});
export const POSE_COUNT = 26;
/** Sprite ids carry the pose: id = slot + POSE_STRIDE * (pose + POSE_CODES * age). */
export const POSE_STRIDE = 4096;
export const POSE_CODES = 32;
/** Largest age (ticks since the actor appeared, or a wall's connection mask) the engine reports. */
export const MAX_AGE = 127;
/** Simulation ticks per second (engine TICKS_PER_SECOND): ages are in ticks. */
export const TICKS_PER_SECOND = 25;

/** Ticks a pose descriptor takes to play once (a death, an idle animation). */
export const onceTicks = (desc) => (desc && desc.fps > 0 ? Math.ceil((desc.length * TICKS_PER_SECOND) / desc.fps) : 0);

/**
 * The poses whose lengths Game.set_death_art takes per actor type, in its
 * order: die1..die6, the crushed body, then the longer idle animation.
 */
export const INFANTRY_TIMED_POSES = Object.freeze(['DIE1', 'DIE2', 'DIE3', 'DIE4', 'DIE5', 'DIE6', 'CRUSHED', 'IDLE1', 'IDLE2']);

/** How a pose's frames advance. */
export const MODE = Object.freeze({
  /** Loop at the sequence's rate on the render clock. */
  LOOP: 0,
  /** Play once from the actor's age (make animations), then show the idle pose. */
  ONCE: 1,
  /** The first frame only (no power, remembered under fog). */
  STILL: 2,
  /** The frame the engine names in the age field (wall connections). */
  INDEX: 3,
  /** The first `lead` frames once from the age, then the others looping on the render clock. */
  LEAD: 4,
  /** Play once from the age, then show nothing (death animations). */
  VANISH: 5,
});

/** Split a sprite id into slot, pose and age (the shader does the same with u32 math). */
export function unpackSprite(id) {
  const code = Math.floor(id);
  const slot = code % POSE_STRIDE;
  const packed = Math.floor(code / POSE_STRIDE);
  return { slot, pose: packed % POSE_CODES, age: Math.floor(packed / POSE_CODES) };
}

export function packSprite(slot, pose = 0, age = 0) {
  return slot + POSE_STRIDE * (pose + POSE_CODES * Math.min(age, MAX_AGE));
}

// ---- Facings -----------------------------------------------------------------

/** OpenRA Util.IndexFacing. */
export function indexFacing(angle, facings) {
  const step = Math.floor(1024 / facings);
  const a = (angle + Math.floor(step / 2)) & 1023;
  return Math.floor(a / step);
}

/**
 * Exclusive upper angle of each frame of 32-facing classic sprites (OpenRA
 * OpenRA.Mods.Cnc.Util.SpriteRanges). Also in shaders/sprite.wgsl CLASSIC_RANGES.
 */
export const CLASSIC_RANGES = Object.freeze([
  20, 56, 88, 132, 156, 184, 212, 240, 268, 296, 324, 352, 384, 416, 452, 488, 532, 568, 604, 644, 668, 696, 724, 752, 780, 808, 836, 864,
  896, 928, 964, 1000,
]);

/** OpenRA ClassicIndexFacing: uneven steps for 32 facings, IndexFacing otherwise. */
export function classicIndexFacing(angle, facings) {
  if (facings === 32) {
    for (let i = 0; i < CLASSIC_RANGES.length; i++) if (angle < CLASSIC_RANGES[i]) return i;
    return 0;
  }
  return indexFacing(angle, facings);
}

/** OpenRA AngleDiffToStep: what is left after rounding to the nearest facing (signed, may wrap). */
export function angleDiffToStep(angle, facings) {
  const step = Math.floor(1024 / facings);
  const a = (angle + Math.floor(step / 2)) & 1023;
  return (a % step) - Math.floor(step / 2);
}

/**
 * OpenRA GetInterpolatedFacingRotation as a WAngle (0..1023, counter-clockwise):
 * what is left after the nearest frame, rounded to the nearest interpolated
 * step. OpenRA truncates the wrapped rest instead, so a facing one unit short
 * of a frame's angle shows that frame turned a whole step (11.25 degrees for
 * the submarines' 16 frames and 32 interpolated facings). OpenRA's units
 * hold exact headings on a straight run; WebRA's free movement leaves ships a
 * unit or two off, and the submarines looked skewed while sailing straight.
 * Facings on a whole step turn exactly as in OpenRA.
 */
export function interpolatedRotation(angle, facings, interpolated) {
  const step = Math.floor(1024 / interpolated);
  const diff = angleDiffToStep(angle, facings);
  // floor((diff + step / 2) / step) * step without negative division (1024 is a multiple of step).
  return ((Math.floor((diff + Math.floor(step / 2) + 1024) / step) * step) - 1024) & 1023;
}

const f32 = Math.fround;
// WGSL folds constant expressions at full precision, then rounds once to f32.
const UNITS_PER_RADIAN = f32(1024 / (Math.PI * 2));
const RADIANS_PER_UNIT = f32((Math.PI * 2) / 1024);

/**
 * The OpenRA angle of an instance angle (radians, WebRA's clockwise facing
 * as the sprite shader gets it), rounded to whole angle units in f32 like
 * shaders/sprite.wgsl `openra_angle`.
 */
export function openraAngle(radians) {
  const raw = Math.floor(f32(f32(f32(radians) * UNITS_PER_RADIAN) + 0.5));
  return (((1024 - raw) % 1024) + 1024) % 1024;
}

/** shaders/sprite.wgsl `interpolated_rotation`: the sprite's clockwise rotation in radians. */
export function interpolatedRadians(angle, facings, interpolated) {
  const r = interpolatedRotation(angle, facings, interpolated);
  const signed = r >= 512 ? r - 1024 : r;
  // Counter-clockwise OpenRA angle units to WebRA's clockwise radians.
  return f32(f32(-signed) * RADIANS_PER_UNIT);
}

/**
 * What the sprite shader draws for a pose descriptor: the facing frame for
 * an instance angle and the rotation (radians, clockwise) left on the sprite.
 * `desc` is { facings, classic, interpolatedFacings, rotate }.
 */
export function facingFrame(radians, desc) {
  if (desc.facings <= 1) return { facing: 0, rotation: desc.rotate ? radians : 0 };
  const a = openraAngle(radians);
  const facing = desc.classic ? classicIndexFacing(a, desc.facings) : indexFacing(a, desc.facings);
  const rotation = desc.interpolatedFacings ? interpolatedRadians(a, desc.facings, desc.interpolatedFacings) : 0;
  return { facing, rotation };
}

/** Animation frame on the render clock, as anim_frame in shaders/sprite.wgsl and js/anim.js. */
export function loopFrame(time, enabled, fps, count, phase) {
  if (!enabled || count <= 1) return 0;
  return Math.floor(Math.max(time, 0) * fps + phase * count) % count;
}

/** Frame of a ONCE pose at an age in ticks; `count` or more means it has finished. */
export function onceFrame(age, fps) {
  return Math.floor((age * fps) / TICKS_PER_SECOND);
}

/** Frame of a LEAD pose (shaders/sprite.wgsl MODE_LEAD): the lead-in by age, then the loop on the render clock. */
export function leadFrame(age, time, enabled, fps, count, lead, phase) {
  const l = Math.min(lead, count);
  const f = onceFrame(age, fps);
  if (f < l) return f;
  if (count > l) return l + loopFrame(time, enabled, fps, count - l, phase);
  return count - 1;
}

// ---- Sequences -------------------------------------------------------------------

/** OpenRA DefaultSpriteSequence.CalculateFrameIndices (shadow frames left out). */
export function calculateFrameIndices(start, length, stride, facings, frames, transpose, reverseFacings) {
  const used = [];
  for (let facing = 0; facing < facings; facing++) {
    const inner = reverseFacings ? (facings - facing) % facings : facing;
    for (let frame = 0; frame < length; frame++) {
      const i = transpose ? frame * facings + inner : inner * stride + frame;
      used.push(frames ? frames[i] : start + i);
    }
  }
  return used;
}

/**
 * The frames of a sequence in draw order, given how many frames its file
 * has: `{ facings, length, fileFrames, shadowFrames, fps }` where
 * `fileFrames[f * length + k]` is the file frame of facing f (counter-
 * clockwise from north) and animation frame k, and `shadowFrames` the same
 * for ShadowStart (or null). Throws when the sequence needs frames the file
 * does not have (OpenRA refuses such a sequence too).
 */
export function resolveSequence(def, fileFrameCount) {
  let facings = def.facings ?? 1;
  const reverseFacings = facings < 0;
  facings = Math.abs(facings);
  const start = def.start ?? 0;
  // With a Frames list, sequence indexes refer to positions in that list.
  const all = def.frames ? def.frames.length : fileFrameCount;
  const fileFrame = (i) => (def.frames ? def.frames[i] : i);
  let length = def.length === -1 || def.length === undefined ? null : def.length;
  if (length === null) {
    if (facings > 1) throw new Error('Length * cannot have facings');
    length = all - start;
  }
  if (length <= 0) throw new Error('the sequence has no frames');
  const stride = def.stride ?? length;
  let index = calculateFrameIndices(start, length, stride, facings, null, !!def.transpose, reverseFacings);
  if (def.reverses) {
    index = index.concat(index.slice(1, length - 1).reverse());
    length = 2 * length - 2;
  }
  for (const i of index) {
    if (i < 0 || i >= all) throw new Error(`the sequence uses frame ${i}, the file has ${all}`);
  }
  for (const i of index) {
    const f = fileFrame(i);
    if (!Number.isInteger(f) || f < 0 || f >= fileFrameCount) throw new Error(`the sequence uses file frame ${f}, the file has ${fileFrameCount}`);
  }
  let shadowFrames = null;
  if (def.shadowStart !== undefined && def.shadowStart >= 0) {
    shadowFrames = index.map((i) => i - start + def.shadowStart).map((i) => {
      if (i < 0 || i >= all) throw new Error(`the sequence's shadow uses frame ${i}, the file has ${all}`);
      return fileFrame(i);
    });
  }
  const tick = def.tick ?? 40;
  return { facings, length, fileFrames: index.map(fileFrame), shadowFrames, fps: tick > 0 ? 1000 / tick : 0 };
}

/**
 * The file of a sequence on an OpenRA tileset (TilesetFilenames, else
 * Filename); '' when the original has none there (OpenRA drew that tileset's
 * art itself, tools/gen_content_tables.py): WebRA art is drawn instead.
 */
export function sequenceFile(def, tileset) {
  const own = def.tilesets?.[tileset];
  return own === undefined ? def.file : own;
}
