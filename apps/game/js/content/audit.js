// The original art audit: walks every actor of the rules and every special
// sprite and checks, against what OpenRA draws (content/render-facts.js,
// generated from OpenRA's render traits and sequences), that WebRA shows
// OpenRA's sequence where it draws that part (content/tables.js ACTOR_ART
// and SPECIAL_ART, built into pose tables by content/atlas.js). Rows:
//
//   { actor, role, openra: 'image.sequence', webra: 'image.sequence' | null,
//     where: 'body.idle' | 'second.move' | 'cameo' | 'special naval.0' | ...,
//     status, note }
//
// Statuses:
//   ok         WebRA draws this part with OpenRA's sequence (and, given the
//              files, the pose table holds its frames in OpenRA's order)
//   fallback   WebRA should draw it from the original art but shows its own
//   wrong      WebRA maps it to another sequence, or the frames, facings,
//              mode or offset in the pose table differ from OpenRA's, or the
//              audit has no rule for the role yet
//   gap        OpenRA draws it, the engine has nothing that shows it (the
//              note says what is missing)
//   webra-only Red Alert has no art for it (OpenRA made the file itself,
//              data/source/bits.txt), so WebRA's own art stays
//
// tools/art-audit.mjs runs it on a player's own Red Alert files; the
// content tests run it on synthetic files, where `identify` names the file
// and frame every image came from, so every frame is checked too.

import { ACTOR_ART, RESOURCES, SEQUENCES, SPECIAL_ART, TERRAIN, TREES } from './tables.js';
import { RENDER_FACTS } from './render-facts.js';
import { originalSlots, specialSlot } from './atlas.js';
import { MODE, POSE, resolveSequence, sequenceFile } from './sequences.js';
import { decodeSprite } from './shp.js';

/**
 * Where WebRA draws each role of render-facts.js with the original art, or
 * why nothing shows it. `part` and `pose` name ACTOR_ART fields (pose
 * names) and the POSE the engine reports; `first` maps only the first
 * sequence of the role (OpenRA picks among the others at random).
 */
export const ROLES = Object.freeze({
  body: { part: 'body', pose: 'idle' },
  'body-damaged': { part: 'body', pose: 'damaged', kinds: ['building'] },
  level: { part: 'body', pose: 'idle' },
  'level-damaged': { part: 'body', pose: 'damaged' },
  make: { part: 'body', pose: 'make' },
  bib: { part: 'bib' },
  turret: { part: 'second', pose: 'idle' },
  'turret-damaged': { part: 'second', pose: 'damaged' },
  stand: { part: 'body', pose: 'idle', first: true },
  run: { part: 'body', pose: 'move' },
  shoot: { part: 'body', pose: 'attack' },
  'prone-stand': { part: 'second', pose: 'idle', first: true },
  'prone-run': { part: 'second', pose: 'move' },
  'prone-shoot': { part: 'second', pose: 'attack' },
  'rotor-ground': { part: 'second', pose: 'idle', aux: 'aux-idle' },
  'rotor-air': { part: 'second', pose: 'move', aux: 'aux-move' },
  overlay: { part: 'second', pose: 'idle' },
  door: { part: 'second', pose: 'idle' },
  'door-damaged': { part: 'second', pose: 'damaged' },
  harvest: { part: 'body', pose: 'harvest' },
  'dock-loop': { part: 'body', pose: 'dock' },
  icon: { part: 'cameo' },
  trail: { special: { aircraft: 'planes.3', helicopter: 'helis.2' } },
  parachute: { special: { infantry: 'planes.0' }, sequence: 'idle' },
  // Parts the engine does not draw at all (yet).
  'idle-anim': { gap: 'infantry idle animations (OpenRA IdleSequences) are not played' },
  'parachute-body': { gap: 'falling paratroopers show the standing frames, not the parachute sequence' },
  death: { gap: 'infantry death animations are not played (the engine shows an impact effect)' },
  dock: { gap: 'the harvester plays its dock-loop sequence at the refinery, not the dock lead-in' },
  muzzle: { gap: 'muzzle flashes (WithMuzzleOverlay) are not drawn' },
  'damage-smoke': { gap: 'smoke over damaged vehicles and ships (WithDamageOverlay) is not drawn' },
  active: { gap: 'the working animation (resupply, tesla charge, silo launch) is not played' },
  recoil: { gap: 'turret recoil frames are not played' },
  placed: { gap: 'the construction yard does not animate when a structure is placed' },
  landing: { gap: 'the transport ship does not open its ramp' },
  reloading: { gap: 'the V2 launcher does not switch to its empty sprite while reloading' },
  husk: { gap: 'destroyed vehicles leave no husk' },
});

/** Special sprites without original art although Red Alert has some: what the engine lacks. */
export const SPECIAL_GAPS = Object.freeze({
  tesla_bolt: { openra: 'litning.bright', note: "the engine draws tesla zaps as a chain of segments; OpenRA's TeslaZap draws litning.shp frames along the line" },
});
/** Why a special sprite keeps WebRA's art. */
const SPECIAL_NOTES = {
  at_mine: 'unused: mines are drawn with their actor slots (MINV)',
  ap_mine: 'unused: mines are drawn with their actor slots (MINP)',
  chrono: 'Red Alert has no chronoshift sprite (OpenRA flashes the screen)',
  'naval.3': "the submerged ripple is WebRA's (not drawn over an original hull)",
  'naval.4': "the sinking wreck is WebRA's",
  'planes.2': 'OpenRA draws contrails as lines, not sprites',
  'helis.0': "WebRA's rotor disc (the original rotor sequences replace it)",
  'helis.1': "WebRA's rotor wash (not drawn with the original rotors)",
  'veterancy.0': "OpenRA's rank.shp (Red Alert has no veterancy)",
  'veterancy.1': "OpenRA's rank.shp (Red Alert has no veterancy)",
  'veterancy.2': "OpenRA's rank.shp (Red Alert has no veterancy)",
  'veterancy.3': "OpenRA's rank.shp (Red Alert has no veterancy)",
};

const POSE_OF = {
  idle: POSE.IDLE,
  move: POSE.MOVE,
  attack: POSE.ATTACK,
  damaged: POSE.DAMAGED,
  make: POSE.MAKE,
  harvest: POSE.HARVEST,
  dock: POSE.DOCK,
  'aux-idle': POSE.AUX_IDLE,
  'aux-move': POSE.AUX_MOVE,
};

/** Rotor facts of an actor in order: [[ground, air], ...] pairs by trait order (render-facts keeps it). */
function rotorPairs(parts) {
  const ground = parts.filter((p) => p[0] === 'rotor-ground');
  const air = parts.filter((p) => p[0] === 'rotor-air');
  return air.map((a, k) => [ground[k], a]);
}

/** The mode a pose of a slot has (atlas.js poseTable). */
function expectedMode(entry, part, pose) {
  if (part === 'body' && pose === 'make') return MODE.ONCE;
  if (entry.wall || (part === 'body' && entry.level) || (part === 'second' && entry.overlay === 'door')) return MODE.INDEX;
  return MODE.LOOP;
}

/**
 * Check one pose of a built slot against OpenRA's sequence: facings,
 * frames per facing, rate, mode, offsets and (with `identify`) the file
 * frame of every image in draw order. Returns a problem or null.
 */
function checkPose(art, poseIndex, def, { files, tileset, identify, offset, mode }) {
  const desc = art?.poses?.[poseIndex];
  if (!desc) return 'no pose table';
  const file = sequenceFile(def, tileset);
  const { sprite } = files(file);
  if (!sprite) return `${file} is not installed`;
  let r;
  try {
    r = resolveSequence(def, sprite.frames.length);
  } catch (err) {
    return err.message;
  }
  if (desc.facings !== r.facings) return `${desc.facings} facings, OpenRA has ${r.facings}`;
  if (desc.length !== r.length) return `${desc.length} frames per facing, OpenRA has ${r.length}`;
  if (Math.abs(desc.fps - r.fps) > 1e-9) return `${desc.fps} frames per second, OpenRA has ${r.fps}`;
  if (desc.classic !== !!def.classic) return 'classic facings differ';
  if ((desc.interpolatedFacings ?? 0) !== (def.interpolatedFacings ?? 0)) return 'interpolated facings differ';
  if (mode !== undefined && desc.mode !== mode) return `mode ${desc.mode}, expected ${mode}`;
  if (desc.frames.length !== r.fileFrames.length) return `${desc.frames.length} frames, OpenRA draws ${r.fileFrames.length}`;
  const want = [(def.offset?.[0] ?? 0) + offset[0], (def.offset?.[1] ?? 0) + offset[1]];
  for (let k = 0; k < desc.frames.length; k++) {
    const img = art.images[desc.frames[k]];
    if (identify) {
      const got = identify(img);
      if (!got || got.file !== file || got.frame !== r.fileFrames[k]) {
        return `frame ${k} shows ${got ? `${got.file}#${got.frame}` : 'something else'}, OpenRA draws ${file}#${r.fileFrames[k]}`;
      }
      // Synthetic frames are not trimmed: the image sits exactly at the sequence offset.
      if (Math.abs(img.offset[0] - want[0]) > 1e-6 || Math.abs(img.offset[1] - want[1]) > 1e-6) {
        return `frame ${k} at offset ${img.offset}, OpenRA draws it at ${want}`;
      }
    }
  }
  return null;
}

/** A cache of decoded files over `getFile`. */
function fileCache(getFile) {
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) {
      const bytes = getFile(name);
      let sprite = null;
      if (bytes) {
        try {
          sprite = decodeSprite(bytes);
        } catch {
          sprite = null;
        }
      }
      cache.set(name, { sprite });
    }
    return cache.get(name);
  };
}

/**
 * Audit the original art for `actors` (rules_json actors, as the game hands
 * them to originalSlots) with the files `getFile` has. `identify(image)`
 * (optional) names the `{ file, frame }` an atlas image was cut from.
 * Returns `{ rows, problems, counts }`.
 */
export function auditOriginalArt(actors, getFile, { tileset = 'TEMPERAT', identify = null } = {}) {
  const built = originalSlots(actors, getFile, tileset);
  const files = fileCache(getFile);
  const rows = [];
  const index = new Map(actors.map((a, t) => [a.id, t]));
  const row = (r) => rows.push({ note: '', webra: null, where: '', ...r });

  for (const a of actors) {
    const t = index.get(a.id);
    const facts = RENDER_FACTS[a.id];
    const entry = ACTOR_ART[a.id];
    if (!facts) {
      row({ actor: a.id, role: 'body', openra: null, status: 'webra-only', note: 'not an OpenRA actor' });
      continue;
    }
    const rotors = rotorPairs(facts.parts);
    const kind = a.kind === 'aircraft' && rotors.length ? 'helicopter' : a.kind;
    const seenRole = new Set();
    for (const [role, image, seq, original] of facts.parts) {
      const openra = `${image}.${seq}`;
      const base = { actor: a.id, role, openra };
      if (!original) {
        row({ ...base, status: 'webra-only', note: 'OpenRA made this art (bits.txt); Red Alert has none' });
        continue;
      }
      const spec = ROLES[role];
      if (!spec) {
        // A render trait the audit does not know yet: decide where WebRA draws it (ROLES).
        row({ ...base, status: 'wrong', note: `no audit rule for role ${role}` });
        continue;
      }
      if (spec.gap) {
        row({ ...base, status: 'gap', note: spec.gap });
        continue;
      }
      if (spec.first && seenRole.has(role)) {
        row({ ...base, status: 'gap', note: `a random ${role} variant (OpenRA picks one of several; WebRA shows the first)` });
        continue;
      }
      seenRole.add(role);
      if (spec.kinds && !spec.kinds.includes(a.kind)) {
        row({ ...base, status: 'gap', note: `the engine has no ${role} pose for ${a.kind} units` });
        continue;
      }
      if (spec.special) {
        const key = spec.special[kind];
        if (!key || (spec.sequence && seq !== spec.sequence)) {
          row({ ...base, status: 'gap', note: key ? `the ${seq} sequence is not played` : `WebRA does not draw this for ${kind} actors` });
          continue;
        }
        const s = SPECIAL_ART[key];
        const webra = s ? `${s.image}.${s.sequence}` : null;
        const status = !s ? 'fallback' : webra === openra ? (built.specials.includes(key) ? 'ok' : 'fallback') : 'wrong';
        row({ ...base, webra, where: `special ${key}`, status, note: status === 'fallback' && s ? 'not built from the files' : '' });
        continue;
      }
      if (!entry) {
        row({ ...base, status: 'fallback', note: 'no ACTOR_ART entry' });
        continue;
      }
      if (entry.image !== image) {
        row({ ...base, webra: `${entry.image}.?`, status: 'wrong', note: `WebRA uses image ${entry.image}` });
        continue;
      }
      if (spec.part === 'cameo') {
        const ok = entry.cameo === seq || entry.cameo === 'fake-icon';
        row({ ...base, webra: entry.cameo ? `${image}.${entry.cameo}` : null, where: 'cameo', status: ok ? 'ok' : 'fallback' });
        continue;
      }
      if (spec.part === 'bib') {
        const ok = entry.bib === seq;
        row({ ...base, webra: entry.bib ? `${image}.${entry.bib}` : null, where: 'bib', status: ok ? 'ok' : 'fallback' });
        continue;
      }
      let pose = spec.pose;
      if (spec.aux) {
        // The second rotor uses the aux poses.
        const k = rotors.findIndex(([g, air]) => (role === 'rotor-ground' ? g : air)?.[2] === seq);
        if (k > 1) {
          row({ ...base, status: 'gap', note: 'more than two rotors' });
          continue;
        }
        if (k === 1) pose = spec.aux;
      }
      const mapped = entry[spec.part]?.[pose];
      const where = `${spec.part}.${pose}`;
      if (!mapped) {
        row({ ...base, where, status: 'fallback', note: 'not mapped' });
        continue;
      }
      if (mapped !== seq) {
        row({ ...base, webra: `${image}.${mapped}`, where, status: 'wrong' });
        continue;
      }
      // The pose table built from the files.
      const slot = 2 * t + (spec.part === 'second' ? 1 : 0);
      const art = built.slots.get(slot);
      if (!art) {
        row({ ...base, webra: openra, where, status: 'fallback', note: 'not built from the files' });
        continue;
      }
      const def = SEQUENCES[image][seq];
      const center = a.kind === 'building' ? (a.centerOffset ?? [0, 0]) : [0, 0];
      const lift = spec.part === 'second' ? (entry.lift?.[pose] ?? 0) : 0;
      const problem = checkPose(art, POSE_OF[pose], def, {
        files,
        tileset,
        identify,
        offset: [center[0], center[1] + lift],
        mode: expectedMode(entry, spec.part, pose),
      });
      row({ ...base, webra: openra, where, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
    }
  }

  // Special sprites: what the engine draws besides the actors.
  for (const [key, spec] of Object.entries(SPECIAL_ART)) {
    const base = { actor: '(special)', role: key, where: `special ${key}` };
    if (!spec) {
      const gap = SPECIAL_GAPS[key];
      row({ ...base, openra: gap?.openra ?? null, status: gap ? 'gap' : 'webra-only', note: gap?.note ?? SPECIAL_NOTES[key] ?? 'Red Alert has no sprite for it (WebRA art)' });
      continue;
    }
    const openra = `${spec.image}.${spec.sequence}`;
    const art = built.slots.get(specialSlot(key, actors.length));
    if (!art) {
      row({ ...base, openra, webra: null, status: 'fallback', note: 'not built from the files' });
      continue;
    }
    const def = SEQUENCES[spec.image][spec.sequence];
    const effect = spec.mode === 'effect';
    const problem = checkPose(art, effect ? POSE.MAKE : POSE.IDLE, def, { files, tileset, identify, offset: [0, 0], mode: effect ? MODE.ONCE : MODE.LOOP });
    row({ ...base, openra, webra: openra, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
  }

  // Terrain the tile terrain draws (content/terrain.js): trees, ore and gems
  // (whose frames are the density levels), the theater's templates.
  const terrainRow = (role, openra, def) => {
    const file = sequenceFile(def, tileset);
    const { sprite } = files(file);
    let note = '';
    if (!sprite) note = `${file} is not installed`;
    else {
      try {
        resolveSequence(def, sprite.frames.length);
      } catch (err) {
        note = err.message;
      }
    }
    row({ actor: '(terrain)', role, openra, webra: note ? null : openra, where: 'terrain', status: note ? 'fallback' : 'ok', note });
  };
  for (const [name, def] of Object.entries(TREES)) terrainRow('tree', `${name}.idle`, def);
  RESOURCES.ore.forEach((def, k) => terrainRow('ore', `resources.gold0${k + 1}`, def));
  RESOURCES.gems.forEach((def, k) => terrainRow('gems', `resources.gem0${k + 1}`, def));
  const theater = TERRAIN[tileset];
  if (theater) {
    const absent = theater.images.filter((f) => !files(f).sprite);
    row({
      actor: '(terrain)',
      role: 'templates',
      openra: `${tileset} (${theater.images.length} templates)`,
      webra: absent.length ? null : tileset,
      where: 'terrain',
      status: absent.length ? 'fallback' : 'ok',
      note: absent.length ? `missing ${absent.join(' ')}` : '',
    });
  }

  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { rows, problems: built.problems, counts };
}

/** The audit as text, one row per line (for tools/art-audit.mjs). */
export function formatAudit({ rows, problems, counts }, { only = null } = {}) {
  const lines = [];
  for (const r of rows) {
    if (only && !only.includes(r.status)) continue;
    lines.push([r.status.padEnd(10), r.actor.padEnd(13), r.role.padEnd(15), (r.openra ?? '-').padEnd(28), (r.where || '-').padEnd(18), r.note].join(' ').trimEnd());
  }
  if (problems.length) lines.push('', 'Problems loading the files:', ...problems.map((p) => `  ${p}`));
  lines.push('', Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  return lines.join('\n');
}
