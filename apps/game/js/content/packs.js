// Texture packs (.webrapack or .zip): sprites, cameos, terrain tiles and
// sounds made by players, installed in this browser (content/store.js). The
// format is documented in docs/texture-packs.md; tools/make-pack.mjs builds
// one from a folder and checks it with the same validator.
//
// Packs are cosmetic only: the manifest has no place for rules, maps or
// anything the simulation reads, and unknown keys are refused, so a pack
// can never make one player's game differ from another's (safe in
// multiplayer). Every file is hostile: the archive goes through the hardened
// ZIP reader of the .oramap importer with pack limits, file names are
// checked, only PNG images and OGG, WAV or MP3 sounds are read (by their
// signatures, with size limits; PNG dimensions are checked from the header
// before anything is decoded), images are decoded by the browser
// (createImageBitmap), and nothing in a pack is ever run or shown as HTML.

import { openZip, ZipError } from '../oramap/zip.js';
import { MODE } from './sequences.js';
import { artProblem, poseTable } from './atlas.js';

export class PackError extends Error {}

export const PACK_FORMAT = 'webra-pack';
export const PACK_FORMAT_VERSION = 1;
export const MANIFEST = 'manifest.json';

export const PACK_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 1024,
  maxNameBytes: 200,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 1000,
  ratioFloorBytes: 64 * 1024,
  maxManifestBytes: 256 * 1024,
  /** Largest image side, and all images of a pack together, in pixels. */
  maxImageSide: 4096,
  maxImagePixels: 64 * 1024 * 1024,
  maxSoundBytes: 8 * 1024 * 1024,
  /** Longest decoded sound. */
  maxSoundSeconds: 600,
  maxSprites: 2048,
  maxSounds: 1024,
  maxCameos: 512,
});

/** Engine sprite slots after the actors that packs may replace (engine/src/render.rs SpriteIds). */
export const SPECIALS = Object.freeze([
  'bullet',
  'small_explosion',
  'large_explosion',
  'piff',
  'rally',
  'at_mine',
  'ap_mine',
  'tesla_bolt',
  'missile',
  'shell',
  'chrono',
  'nuke',
]);

/**
 * Special names that are actors: the engine draws mines with the bodies of
 * the mine actors, so a pack's "at_mine" and "ap_mine" sprites replace those
 * (their special slots stay reserved and empty, engine/src/render.rs SpriteIds).
 */
export const SPECIAL_ACTORS = Object.freeze({ at_mine: 'MINV', ap_mine: 'MINP' });

export const POSE_NAMES = Object.freeze([
  'idle',
  'move',
  'attack',
  'damaged',
  'make',
  'harvest',
  'dock',
  // Infantry (engine/src/infantry_render.rs): stand variant, idle animations, deaths, second attack.
  'stand2',
  'idle1',
  'idle2',
  'die1',
  'die2',
  'die3',
  'die4',
  'die5',
  'die6',
  'crushed',
  'attack2',
]);
export const TERRAIN_CLASSES = Object.freeze(['clear', 'rough', 'rock', 'water', 'tree', 'ford']);
export const PACK_BIOMES = Object.freeze(['temperate', 'snow', 'desert']);
const TOP_KEYS = new Set(['format', 'formatVersion', 'name', 'author', 'version', 'license', 'description', 'sprites', 'cameos', 'terrain', 'sounds']);
const SPRITE_KEYS = new Set(['actor', 'special', 'part', 'pose', 'image', 'teamMask', 'frameSize', 'facings', 'frames', 'fps', 'offset', 'scale', 'rotate', 'hidden']);
const TERRAIN_KEYS = new Set(['biomes', 'tileSize', ...TERRAIN_CLASSES, 'ore', 'gems']);
/** Files a pack may hold besides the manifest. */
const ALLOWED_EXT = /\.(png|ogg|wav|mp3|txt|md)$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\- ]*(\/[A-Za-z0-9_][A-Za-z0-9_.\- ]*)*$/;
const SOUND_KEY_RE = /^[a-z0-9_.-]{1,48}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/** Normalize a pack path; null when it is unsafe (absolute, "..", backslashes, odd characters). */
export function safePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > PACK_LIMITS.maxNameBytes) return null;
  if (p.includes('\\') || p.startsWith('/') || p.includes('//')) return null;
  if (!PATH_RE.test(p)) return null;
  if (p.split('/').some((s) => s === '.' || s === '..')) return null;
  return p;
}

/**
 * Check a parsed manifest. Returns `{ manifest, errors, warnings }`; the
 * manifest is normalized (defaults filled in) when there are no errors.
 * `known` lists what the game has: { actors: Set of actor ids, sounds: Set
 * of sound keys } (unknown ones are warnings: the pack may be for a newer
 * WebRA).
 */
export function validateManifest(raw, known = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  if (!isObject(raw)) return { manifest: null, errors: ['manifest.json must be a JSON object'], warnings };
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) err(`unknown key "${k}": packs only change how the game looks and sounds (no rules, maps or settings)`);
  }
  if (raw.format !== PACK_FORMAT) err(`"format" must be "${PACK_FORMAT}"`);
  if (raw.formatVersion !== PACK_FORMAT_VERSION) err(`"formatVersion" must be ${PACK_FORMAT_VERSION} (this WebRA reads version ${PACK_FORMAT_VERSION})`);
  const text = (key, max, required) => {
    const v = raw[key];
    if (v === undefined || v === '') {
      if (required) err(`"${key}" is required`);
      return '';
    }
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f<>]/.test(v)) {
      err(`"${key}" must be text of at most ${max} characters without < or >`);
      return '';
    }
    return v.trim();
  };
  const m = {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    name: text('name', 64, true),
    author: text('author', 64, true),
    version: text('version', 32, true),
    license: text('license', 64, true),
    description: text('description', 500, false),
    sprites: [],
    cameos: {},
    terrain: null,
    sounds: {},
  };
  const files = new Set();
  const usePath = (where, p) => {
    const s = safePath(p);
    if (!s) {
      err(`${where}: "${p}" is not a safe file name inside the pack`);
      return null;
    }
    if (!/\.png$/i.test(s)) err(`${where}: images must be PNG files`);
    files.add(s);
    return s;
  };

  // Sprites.
  if (raw.sprites !== undefined) {
    if (!Array.isArray(raw.sprites)) err('"sprites" must be a list');
    else if (raw.sprites.length > PACK_LIMITS.maxSprites) err(`at most ${PACK_LIMITS.maxSprites} sprites`);
    else {
      const seen = new Set();
      raw.sprites.forEach((s, i) => {
        const where = `sprites[${i}]`;
        if (!isObject(s)) return err(`${where} must be an object`);
        for (const k of Object.keys(s)) if (!SPRITE_KEYS.has(k)) err(`${where}: unknown key "${k}"`);
        const hasActor = s.actor !== undefined;
        const hasSpecial = s.special !== undefined;
        if (hasActor === hasSpecial) return err(`${where}: give either "actor" or "special"`);
        const out = { pose: 'idle', part: 'body' };
        if (hasActor) {
          if (typeof s.actor !== 'string' || !NAME_RE.test(s.actor) || s.actor.length > 32) return err(`${where}: bad actor id`);
          out.actor = s.actor.toUpperCase();
          if (known.actors && !known.actors.has(out.actor)) warnings.push(`${where}: WebRA has no actor ${out.actor}; it is ignored`);
          if (s.part !== undefined && s.part !== 'body' && s.part !== 'second') err(`${where}: "part" must be "body" or "second"`);
          out.part = s.part ?? 'body';
          if (s.pose !== undefined && !POSE_NAMES.includes(s.pose)) err(`${where}: "pose" must be one of ${POSE_NAMES.join(', ')}`);
          out.pose = s.pose ?? 'idle';
        } else {
          if (!SPECIALS.includes(s.special)) return err(`${where}: "special" must be one of ${SPECIALS.join(', ')}`);
          out.special = s.special;
          // The defaults are accepted: packs stored before 0.7 kept the checked manifest, which has them.
          if ((s.part !== undefined && s.part !== 'body') || (s.pose !== undefined && s.pose !== 'idle')) err(`${where}: specials have no part or pose`);
        }
        const key = `${out.actor ?? '*' + out.special}|${out.part}|${out.pose}`;
        if (seen.has(key)) err(`${where}: ${key.replaceAll('|', ' ')} is given twice`);
        seen.add(key);
        if (s.hidden !== undefined) {
          if (s.hidden !== true) err(`${where}: "hidden" can only be true`);
          if (!hasActor || out.pose !== 'idle') err(`${where}: only an actor part (pose idle) can be hidden`);
          if (Object.keys(s).some((k) => !['actor', 'part', 'pose', 'hidden'].includes(k))) err(`${where}: a hidden part has no image`);
          out.hidden = true;
          m.sprites.push(out);
          return;
        }
        out.image = usePath(`${where}.image`, s.image);
        if (s.teamMask !== undefined) out.teamMask = usePath(`${where}.teamMask`, s.teamMask);
        const fs = s.frameSize;
        if (!Array.isArray(fs) || fs.length !== 2 || !fs.every((n) => Number.isInteger(n) && n >= 1 && n <= 512)) {
          err(`${where}: "frameSize" must be [width, height], 1 to 512 pixels`);
        }
        out.frameSize = fs;
        out.facings = s.facings ?? 1;
        if (!isPow2(out.facings) || out.facings > 64) err(`${where}: "facings" must be 1, 2, 4, 8, 16, 32 or 64`);
        if (hasSpecial && out.facings !== 1) err(`${where}: specials have one facing (the game turns them)`);
        out.frames = s.frames ?? 1;
        if (!Number.isInteger(out.frames) || out.frames < 1 || out.frames > 256) err(`${where}: "frames" must be 1 to 256`);
        out.fps = s.fps ?? 0;
        if (typeof out.fps !== 'number' || !(out.fps >= 0 && out.fps <= 60)) err(`${where}: "fps" must be 0 to 60`);
        out.offset = s.offset ?? [0, 0];
        if (!Array.isArray(out.offset) || out.offset.length !== 2 || !out.offset.every((n) => Number.isFinite(n) && Math.abs(n) <= 256)) {
          err(`${where}: "offset" must be [x, y], at most 256 world pixels`);
        }
        out.scale = s.scale ?? 1;
        if (typeof out.scale !== 'number' || !(out.scale >= 0.25 && out.scale <= 4)) err(`${where}: "scale" must be 0.25 to 4`);
        out.rotate = hasSpecial ? true : (s.rotate ?? false);
        if (typeof out.rotate !== 'boolean') err(`${where}: "rotate" must be true or false`);
        if (out.rotate && out.facings !== 1) err(`${where}: only sprites with one facing can rotate`);
        m.sprites.push(out);
      });
    }
  }

  // Cameos.
  if (raw.cameos !== undefined) {
    if (!isObject(raw.cameos)) err('"cameos" must map actor ids to PNG files');
    else {
      const entries = Object.entries(raw.cameos);
      if (entries.length > PACK_LIMITS.maxCameos) err(`at most ${PACK_LIMITS.maxCameos} cameos`);
      for (const [id, p] of entries) {
        if (!NAME_RE.test(id) || id.length > 32) {
          err(`cameos: bad actor id "${id}"`);
          continue;
        }
        if (known.actors && !known.actors.has(id.toUpperCase())) warnings.push(`cameos: WebRA has no actor ${id.toUpperCase()}; it is ignored`);
        const s = usePath(`cameos.${id}`, p);
        if (s) m.cameos[id.toUpperCase()] = s;
      }
    }
  }

  // Terrain.
  if (raw.terrain !== undefined) {
    const t = raw.terrain;
    if (!isObject(t)) err('"terrain" must be an object');
    else {
      for (const k of Object.keys(t)) if (!TERRAIN_KEYS.has(k)) err(`terrain: unknown key "${k}"`);
      const out = { biomes: t.biomes ?? PACK_BIOMES.slice(), tileSize: t.tileSize ?? 24 };
      if (!Array.isArray(out.biomes) || !out.biomes.length || !out.biomes.every((b) => PACK_BIOMES.includes(b))) {
        err(`terrain.biomes must list some of ${PACK_BIOMES.join(', ')}`);
      }
      if (!Number.isInteger(out.tileSize) || out.tileSize < 8 || out.tileSize > 64) err('terrain.tileSize must be 8 to 64 pixels');
      for (const k of [...TERRAIN_CLASSES, 'ore', 'gems']) if (t[k] !== undefined) out[k] = usePath(`terrain.${k}`, t[k]);
      if (!out.clear || !out.water) err('terrain needs at least "clear" and "water" tiles');
      m.terrain = out;
    }
  }

  // Sounds.
  if (raw.sounds !== undefined) {
    if (!isObject(raw.sounds)) err('"sounds" must map sound names to OGG, WAV or MP3 files');
    else {
      const entries = Object.entries(raw.sounds);
      if (entries.length > PACK_LIMITS.maxSounds) err(`at most ${PACK_LIMITS.maxSounds} sounds`);
      for (const [k, p] of entries) {
        const key = String(k).toLowerCase();
        if (!SOUND_KEY_RE.test(key)) {
          err(`sounds: bad sound name "${k}"`);
          continue;
        }
        if (known.sounds && !known.sounds.has(key) && !known.sounds.has(`${key}.aud`)) warnings.push(`sounds: WebRA plays no sound "${k}"; it is ignored`);
        const s = safePath(p);
        if (!s || !/\.(ogg|wav|mp3)$/i.test(s)) {
          err(`sounds.${k}: "${p}" must be an OGG, WAV or MP3 file inside the pack`);
          continue;
        }
        files.add(s);
        m.sounds[key] = s;
      }
    }
  }
  if (!m.sprites.length && !Object.keys(m.cameos).length && !m.terrain && !Object.keys(m.sounds).length) err('the pack replaces nothing');
  return { manifest: errors.length ? null : m, errors, warnings, files: [...files] };
}

/** Width and height from a PNG header, without decoding it. Throws PackError. */
export function pngSize(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) throw new PackError('not a PNG image');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new PackError('corrupt PNG image (no header)');
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  if (width === 0 || height === 0) throw new PackError('corrupt PNG image (empty)');
  return { width, height };
}

/** The type of a sound file from its signature: 'ogg', 'wav', 'mp3' or null. */
export function soundType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const s = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/**
 * Read a pack archive (Uint8Array): checks the archive, the manifest, every
 * file the manifest names and every image size. Returns `{ manifest, files:
 * Map(path -> Uint8Array), warnings, size }`; throws PackError with every
 * problem found.
 */
export async function readPack(bytes, known = {}) {
  const lim = PACK_LIMITS;
  let zip;
  try {
    zip = openZip(bytes, lim);
  } catch (err) {
    throw new PackError(err instanceof ZipError ? `not a usable pack archive: ${err.message}` : String(err));
  }
  const names = zip.names();
  // The manifest at the root, or in the archive's only folder.
  let prefix = '';
  if (!zip.has(MANIFEST)) {
    const roots = new Set(names.map((n) => n.split('/')[0]));
    const only = roots.size === 1 ? [...roots][0] : null;
    if (only && zip.has(`${only}/${MANIFEST}`)) prefix = `${only}/`;
    else throw new PackError('the archive has no manifest.json');
  }
  const problems = [];
  for (const n of names) {
    const rel = n.slice(prefix.length);
    if (!n.startsWith(prefix) || !safePath(rel)) problems.push(`unsafe file name in the archive: ${JSON.stringify(n)}`);
    else if (rel !== MANIFEST && !ALLOWED_EXT.test(rel)) problems.push(`${rel}: packs hold only PNG images, OGG, WAV or MP3 sounds and text files`);
  }
  if (zip.duplicateNames().length) problems.push(`files appear twice: ${zip.duplicateNames().join(', ')}`);
  if (problems.length) throw new PackError(problems.join('; '));
  const entry = zip.entries.find((e) => e.name === prefix + MANIFEST);
  if (entry.size > lim.maxManifestBytes) throw new PackError(`manifest.json is larger than ${lim.maxManifestBytes} bytes`);
  let raw;
  try {
    raw = JSON.parse(await zip.readText(prefix + MANIFEST));
  } catch (err) {
    throw new PackError(`manifest.json is not valid JSON: ${err.message}`);
  }
  const { manifest, errors, warnings, files: wanted } = validateManifest(raw, known);
  if (errors.length) throw new PackError(errors.join('; '));
  const files = new Map();
  let pixels = 0;
  let size = 0;
  for (const p of wanted) {
    if (!zip.has(prefix + p)) {
      problems.push(`${p} is named in the manifest but missing from the archive`);
      continue;
    }
    let data;
    try {
      data = await zip.read(prefix + p);
    } catch (err) {
      problems.push(`${p}: ${err.message}`);
      continue;
    }
    size += data.length;
    if (/\.png$/i.test(p)) {
      try {
        const { width, height } = pngSize(data);
        if (width > lim.maxImageSide || height > lim.maxImageSide) problems.push(`${p} is ${width} x ${height}; at most ${lim.maxImageSide} pixels a side`);
        pixels += width * height;
      } catch (err) {
        problems.push(`${p}: ${err.message}`);
      }
    } else {
      if (data.length > lim.maxSoundBytes) problems.push(`${p} is larger than ${lim.maxSoundBytes} bytes`);
      else if (!soundType(data)) problems.push(`${p} is not an OGG, WAV or MP3 sound`);
    }
    files.set(p, data);
  }
  if (pixels > lim.maxImagePixels) problems.push(`the images hold ${pixels} pixels; at most ${lim.maxImagePixels}`);
  // Sheets must have exactly the frames the manifest describes.
  for (const s of manifest.sprites) {
    if (s.hidden) continue;
    for (const p of [s.image, s.teamMask].filter(Boolean)) {
      const data = files.get(p);
      if (!data) continue;
      try {
        const { width, height } = pngSize(data);
        if (width !== s.frameSize[0] * s.frames || height !== s.frameSize[1] * s.facings) {
          problems.push(`${p} is ${width} x ${height}; ${s.frames} frames of ${s.frameSize[0]} wide by ${s.facings} facings of ${s.frameSize[1]} high need ${s.frameSize[0] * s.frames} x ${s.frameSize[1] * s.facings}`);
        }
      } catch {
        // reported above
      }
    }
  }
  if (manifest.terrain) {
    const t = manifest.terrain;
    for (const k of TERRAIN_CLASSES) {
      const data = t[k] && files.get(t[k]);
      if (!data) continue;
      try {
        const { width, height } = pngSize(data);
        if (height !== t.tileSize || width % t.tileSize !== 0 || width / t.tileSize > 16) problems.push(`${t[k]} must be a row of 1 to 16 tiles of ${t.tileSize} x ${t.tileSize}`);
      } catch {
        // reported above
      }
    }
    for (const [k, levels] of [['ore', 12], ['gems', 4]]) {
      const data = t[k] && files.get(t[k]);
      if (!data) continue;
      try {
        const { width, height } = pngSize(data);
        if (width % t.tileSize || height % t.tileSize || width / t.tileSize > levels || height / t.tileSize > 4) {
          problems.push(`${t[k]} must be up to ${levels} density levels wide and up to 4 variants high, in tiles of ${t.tileSize}`);
        }
      } catch {
        // reported above
      }
    }
  }
  if (problems.length) throw new PackError(problems.join('; '));
  // `source` is the manifest as written: stored with the pack, it is checked again on every load.
  return { manifest, source: raw, files, warnings, size };
}

/** A stable id for a pack: its name and author, lower case. */
export function packId(manifest) {
  return `${manifest.name}|${manifest.author}`.toLowerCase();
}

/**
 * What a pack replaces, for the install preview: { sprites: [{ target, part,
 * poses }], cameos, terrain: biomes or null, sounds: [names], specials }.
 */
export function packSummary(manifest, actorNames = new Map()) {
  const byTarget = new Map();
  for (const s of manifest.sprites) {
    const target = s.actor ? (actorNames.get(s.actor) ?? s.actor) : `${s.special.replaceAll('_', ' ')} (effect)`;
    const key = `${target}|${s.part}`;
    if (!byTarget.has(key)) byTarget.set(key, { target, actor: s.actor ?? null, part: s.actor ? s.part : null, poses: [], hidden: false });
    const e = byTarget.get(key);
    if (s.hidden) e.hidden = true;
    else e.poses.push(s.pose ?? 'idle');
  }
  return {
    sprites: [...byTarget.values()],
    cameos: Object.keys(manifest.cameos).map((id) => actorNames.get(id) ?? id),
    terrain: manifest.terrain ? manifest.terrain.biomes : null,
    sounds: Object.keys(manifest.sounds),
  };
}

// ---- From decoded images to the renderer's slots ----------------------------------------

/** Cut frame (col, row) of a sheet: { width, height, color, mask }. */
function cut(sheet, mask, fw, fh, col, row) {
  const color = new Uint8ClampedArray(fw * fh * 4);
  let team = null;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const s = ((row * fh + y) * sheet.width + col * fw + x) * 4;
      const o = (y * fw + x) * 4;
      color[o] = sheet.rgba[s];
      color[o + 1] = sheet.rgba[s + 1];
      color[o + 2] = sheet.rgba[s + 2];
      color[o + 3] = sheet.rgba[s + 3];
      if (mask && mask.rgba[s] > 127 && color[o + 3] > 0) {
        // Team colour: the shader tints the grey level (shaders/sprite.wgsl).
        team ??= new Uint8Array(fw * fh);
        team[y * fw + x] = 255;
        const g = Math.round(0.299 * color[o] + 0.587 * color[o + 1] + 0.114 * color[o + 2]);
        color[o] = color[o + 1] = color[o + 2] = g;
      }
    }
  }
  return { width: fw, height: fh, color, mask: team };
}

/**
 * Sprite slots of a pack for js/sprites.js buildAtlas: `{ slots, problems }`.
 * `images` maps paths to decoded `{ width, height, rgba }`; `actors` are the
 * rules actors (slot 2t body, 2t + 1 second part; specials after them).
 */
export function packSlots(manifest, images, actors) {
  const slots = new Map();
  const problems = [];
  const index = new Map(actors.map((a, t) => [a.id.toUpperCase(), t]));
  const groups = new Map(); // slot -> sprites
  for (const s of manifest.sprites) {
    let slot;
    if (s.actor) {
      const t = index.get(s.actor);
      if (t === undefined) continue;
      slot = 2 * t + (s.part === 'second' ? 1 : 0);
    } else if (SPECIAL_ACTORS[s.special]) {
      // The mines are actors (MINV, MINP): their special names address the actor's body.
      const t = index.get(SPECIAL_ACTORS[s.special]);
      if (t === undefined) continue;
      slot = 2 * t;
    } else {
      slot = actors.length * 2 + SPECIALS.indexOf(s.special);
    }
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(s);
  }
  for (const [slot, sprites] of groups) {
    if (sprites.some((s) => s.hidden)) {
      slots.set(slot, null);
      continue;
    }
    const all = [];
    const have = {};
    for (const s of sprites) {
      const sheet = images.get(s.image);
      if (!sheet) {
        problems.push(`${s.image} could not be decoded`);
        continue;
      }
      const mask = s.teamMask ? images.get(s.teamMask) : null;
      const [fw, fh] = s.frameSize;
      const frames = [];
      // Internal facing i turns counter-clockwise (OpenRA order); sheet row r turns clockwise.
      for (let i = 0; i < s.facings; i++) {
        const row = (s.facings - i) % s.facings;
        for (let k = 0; k < s.frames; k++) {
          const img = cut(sheet, mask, fw, fh, k, row);
          frames.push(all.length);
          all.push({ ...img, offset: s.offset, scale: s.scale });
        }
      }
      const desc = (mode) => ({ frames, length: s.frames, facings: s.facings, fps: s.fps, mode, classic: false, interpolatedFacings: 0, rotate: s.rotate });
      have[s.pose ?? 'idle'] = { loop: desc(MODE.LOOP), once: desc(MODE.ONCE), still: desc(MODE.STILL), index: desc(MODE.INDEX), vanish: desc(MODE.VANISH) };
    }
    if (!have.idle) {
      if (Object.keys(have).length) problems.push(`slot ${slot}: a pack sprite needs an idle pose`);
      continue;
    }
    const poses = poseTable(have);
    const art = poses ? { images: all, poses, deaths: !!have.die1 } : null;
    const problem = artProblem(art);
    if (problem) problems.push(`slot ${slot}: ${problem}`);
    else if (art) slots.set(slot, art);
  }
  return { slots, problems };
}

/** Cameo pictures of a pack: (typeName) => { width, height, rgba } | null. */
export function packCameos(manifest, images) {
  return (typeName) => {
    const p = manifest.cameos[String(typeName).toUpperCase()];
    return p ? (images.get(p) ?? null) : null;
  };
}

/**
 * Decode a pack's images in the browser (createImageBitmap, never as
 * markup): Map(path -> { width, height, rgba }). `decode` is replaceable
 * for tests: (bytes) => Promise<{ width, height, rgba }>.
 */
export async function decodePackImages(files, decode = decodePng) {
  const out = new Map();
  for (const [p, bytes] of files) {
    if (!/\.png$/i.test(p)) continue;
    const { width, height } = pngSize(bytes);
    if (width > PACK_LIMITS.maxImageSide || height > PACK_LIMITS.maxImageSide) throw new PackError(`${p} is too large`);
    const img = await decode(bytes);
    if (img.width !== width || img.height !== height) throw new PackError(`${p} decoded to a different size than its header says`);
    out.set(p, img);
  }
  return out;
}

/** PNG bytes to RGBA through the browser's image decoder. */
export async function decodePng(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8ClampedArray(data.buffer.slice(0)) };
  } finally {
    bitmap.close?.();
  }
}
