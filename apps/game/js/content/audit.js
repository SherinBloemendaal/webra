// The original art audit: walks every actor of the rules, every special
// sprite, explosion, muzzle flash and cursor and checks, against what
// OpenRA draws (content/render-facts.js, generated from OpenRA's render
// traits and sequences; tables.js EXPLOSIONS, CURSOR_ART), that WebRA shows
// OpenRA's sequence where it draws that part (content/tables.js ACTOR_ART,
// SPECIAL_ART, EXPLOSION_ART, built into pose tables by content/atlas.js;
// js/cursors.js CURSOR_NAMES). Rows:
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
//              mode or offset in the pose table differ from OpenRA's, an
//              effect lasts longer than the engine draws it, or the audit
//              has no rule for the role yet
//   gap        OpenRA draws it, the engine has nothing that shows it (the
//              note says what is missing and who adds it)
//   webra-only Red Alert has no art for it (OpenRA made the file itself,
//              data/source/bits.txt), so WebRA's own art stays
//   n/a        OpenRA draws it in a situation WebRA never has (vehicles
//              dropped by parachute)
//
// tools/art-audit.mjs runs it on a player's own Red Alert files; the
// content tests run it on synthetic files, where `identify` names the file
// and frame every image came from, so every frame is checked too.

import { ACTOR_ART, CURSOR_ART, EXPLOSION_ART, EXPLOSIONS, RESOURCES, SEQUENCES, SPECIAL_ART, TERRAIN, TREES } from './tables.js';
import { RENDER_FACTS } from './render-facts.js';
import { explosionSlot, muzzleSlot, originalSlots, specialSlot } from './atlas.js';
import { originalCursorFrames } from './cursors.js';
import { CURSOR_NAMES, COMMAND_CURSOR_NAMES } from '../cursors.js';
import { MODE, POSE, TICKS_PER_SECOND, resolveSequence, sequenceFile } from './sequences.js';
import { decodeSprite } from './shp.js';

/**
 * Ticks the engine draws an effect (engine/src/fx.rs): an original sequence
 * played once must end within them.
 */
export const FX_LIMITS = Object.freeze({ explosion: 48, muzzle: 24, smoke: 120, activeOnce: 100 });

/** Who adds a part the engine does not draw yet. */
const INFANTRY_WORKER = 'drawn by the infantry work (deaths, idle and stand animations)';

/**
 * Where WebRA draws each role of render-facts.js with the original art, or
 * why nothing shows it. `part` and `pose` name ACTOR_ART fields (pose
 * names; a function picks it by sequence) and the POSE the engine reports;
 * `lead` checks a lead-in (ACTOR_ART lead) played before that pose's own
 * sequence; `first` maps only the first sequence of the role (OpenRA picks
 * among the others at random).
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
  // The dock lead-in before the dock loop, and backwards when leaving.
  dock: { part: 'body', lead: 'dock', reverse: 'active-end' },
  icon: { part: 'cameo' },
  // Working animations (the engine's active pose, fx.rs).
  active: { part: 'body', pose: (seq) => (seq.startsWith('damaged-') ? 'damaged-active' : 'active') },
  placed: { part: 'body', pose: (seq) => (seq.startsWith('damaged-') ? 'damaged-active' : 'active') },
  recoil: { part: 'second', pose: (seq) => (seq.startsWith('damaged-') ? 'damaged-active' : 'active') },
  reloading: { part: 'body', pose: 'active' },
  'reloading-damaged': { part: 'body', pose: 'damaged-active' },
  'landing-open': { part: 'body', lead: 'active' },
  'landing-unload': { part: 'body', pose: 'active' },
  'landing-close': { part: 'body', pose: 'active-end' },
  'parachute-body': { part: 'body', pose: 'parachute' },
  muzzle: { muzzle: true },
  trail: { special: { aircraft: 'planes.3', helicopter: 'helis.2' } },
  parachute: { special: { infantry: 'planes.0' } },
  'damage-smoke': { special: { vehicle: 'fx.0', ship: 'fx.0', building: 'fx.0', aircraft: 'fx.0', infantry: 'fx.0' } },
  // Parts other work adds.
  'idle-anim': { gap: INFANTRY_WORKER },
  death: { gap: INFANTRY_WORKER },
  husk: { gap: 'husks are added by the game options work' },
});

/** Why a special sprite keeps WebRA's art. */
const SPECIAL_NOTES = {
  at_mine: 'reserved: mines are their actors (MINV), a pack at_mine sprite replaces that body',
  ap_mine: 'reserved: mines are their actors (MINP), a pack ap_mine sprite replaces that body',
  tesla_bolt: "WebRA's zap segment; the original zap is drawn from fx.1 and fx.2 (OpenRA TeslaZap)",
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
  active: POSE.ACTIVE,
  'damaged-active': POSE.DAMAGED_ACTIVE,
  parachute: POSE.PARACHUTE,
  'active-end': POSE.ACTIVE_END,
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
  if (pose === 'active-end') return MODE.ONCE;
  if (part === 'body' && entry.lead?.[pose]) return MODE.LEAD;
  if (pose === 'active' || pose === 'damaged-active') {
    if (part === 'second' || entry.activeMode === 'once') return MODE.ONCE;
    return MODE.LOOP;
  }
  if (entry.wall || (part === 'body' && entry.level) || (part === 'second' && entry.overlay === 'door')) return MODE.INDEX;
  return MODE.LOOP;
}

/**
 * Check one pose of a built slot against OpenRA's sequences (played one
 * after the other, facing by facing; `reverse` backwards): facings, frames
 * per facing, rate, mode, lead-in, offsets and (with `identify`) the file
 * frame of every image in draw order. `limit` is the ticks the engine draws
 * a pose played once. Returns a problem or null.
 */
function checkPose(art, poseIndex, defs, { files, tileset, identify, offset, mode, lead = 0, reverse = false, limit = 0 }) {
  const desc = art?.poses?.[poseIndex];
  if (!desc) return 'no pose table';
  const parts = [];
  for (const def of defs) {
    const file = sequenceFile(def, tileset);
    const { sprite } = files(file);
    if (!sprite) return `${file} is not installed`;
    try {
      parts.push({ file, def, r: resolveSequence(def, sprite.frames.length) });
    } catch (err) {
      return err.message;
    }
  }
  const main = parts[parts.length - 1];
  const length = parts.reduce((n, p) => n + p.r.length, 0);
  if (parts.some((p) => p.r.facings !== main.r.facings)) return 'the sequences have different facings';
  if (desc.facings !== main.r.facings) return `${desc.facings} facings, OpenRA has ${main.r.facings}`;
  if (desc.length !== length) return `${desc.length} frames per facing, OpenRA has ${length}`;
  if (Math.abs(desc.fps - main.r.fps) > 1e-9) return `${desc.fps} frames per second, OpenRA has ${main.r.fps}`;
  if (desc.classic !== !!main.def.classic) return 'classic facings differ';
  if ((desc.interpolatedFacings ?? 0) !== (main.def.interpolatedFacings ?? 0)) return 'interpolated facings differ';
  if (mode !== undefined && desc.mode !== mode) return `mode ${desc.mode}, expected ${mode}`;
  if ((desc.lead ?? 0) !== lead) return `lead-in of ${desc.lead ?? 0} frames, expected ${lead}`;
  if (limit && mode === MODE.ONCE && (length * TICKS_PER_SECOND) / main.r.fps > limit + 1e-9) {
    return `plays ${((length * TICKS_PER_SECOND) / main.r.fps).toFixed(1)} ticks, the engine draws it ${limit}`;
  }
  // OpenRA's frames in draw order: per facing each sequence's frames, the whole facing reversed if asked.
  const want = [];
  for (let f = 0; f < main.r.facings; f++) {
    const facing = [];
    for (const p of parts) {
      const at = [(p.def.offset?.[0] ?? 0) + offset[0], (p.def.offset?.[1] ?? 0) + offset[1]];
      for (let k = 0; k < p.r.length; k++) facing.push({ file: p.file, frame: p.r.fileFrames[f * p.r.length + k], at });
    }
    if (reverse) facing.reverse();
    want.push(...facing);
  }
  if (desc.frames.length !== want.length) return `${desc.frames.length} frames, OpenRA draws ${want.length}`;
  if (identify) {
    for (let k = 0; k < want.length; k++) {
      const img = art.images[desc.frames[k]];
      const got = identify(img);
      const w = want[k];
      if (!got || got.file !== w.file || got.frame !== w.frame) {
        return `frame ${k} shows ${got ? `${got.file}#${got.frame}` : 'something else'}, OpenRA draws ${w.file}#${w.frame}`;
      }
      // Synthetic frames are not trimmed: the image sits exactly at the sequence offset.
      if (Math.abs(img.offset[0] - w.at[0]) > 1e-6 || Math.abs(img.offset[1] - w.at[1]) > 1e-6) {
        return `frame ${k} at offset ${img.offset}, OpenRA draws it at ${w.at}`;
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

/** SEQUENCES definitions of a special sprite's sequences, or null. */
const specialDefs = (spec) => spec.sequences.map((n) => SEQUENCES[spec.image]?.[n]).filter(Boolean);

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
  const check = (art, pose, defs, o) => checkPose(art, pose, defs, { files, tileset, identify, ...o });

  // A special sprite (SPECIAL_ART key) built from the files, checked as its mode plays.
  const specialRow = (base, key) => {
    const spec = SPECIAL_ART[key];
    const where = `special ${key}`;
    if (!spec) {
      row({ ...base, where, status: 'webra-only', note: SPECIAL_NOTES[key] ?? 'Red Alert has no sprite for it (WebRA art)' });
      return;
    }
    const webra = `${spec.image}.${spec.sequences.join('+')}`;
    const art = built.slots.get(specialSlot(key, actors.length));
    if (!art) {
      row({ ...base, webra: null, where, status: 'fallback', note: 'not built from the files' });
      return;
    }
    const defs = specialDefs(spec);
    let problem;
    if (spec.mode === 'effect') problem = check(art, POSE.MAKE, defs, { offset: [0, 0], mode: MODE.ONCE, limit: key === 'fx.0' ? FX_LIMITS.smoke : FX_LIMITS.explosion });
    else if (spec.mode === 'lead') problem = check(art, POSE.IDLE, defs, { offset: [0, 0], mode: MODE.LEAD, lead: defs[0] ? resolvedLength(defs[0]) : 0 });
    else problem = check(art, POSE.IDLE, defs, { offset: [0, 0], mode: spec.mode === 'index' ? MODE.INDEX : MODE.LOOP });
    row({ ...base, webra, where, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
  };
  const resolvedLength = (def) => {
    const { sprite } = files(sequenceFile(def, tileset));
    try {
      return sprite ? resolveSequence(def, sprite.frames.length).length : 0;
    } catch {
      return 0;
    }
  };

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
        row({ ...base, status: 'gap', note: `a random ${role} variant (OpenRA picks one of several; ${INFANTRY_WORKER})` });
        continue;
      }
      seenRole.add(role);
      if (spec.kinds && !spec.kinds.includes(a.kind)) {
        row({ ...base, status: 'gap', note: `the engine has no ${role} pose for ${a.kind} units` });
        continue;
      }
      if (spec.special) {
        const key = spec.special[kind];
        if (!key) {
          row({ ...base, status: 'n/a', note: `WebRA never drops ${kind} actors by parachute (only paratroopers)` });
          continue;
        }
        const s = SPECIAL_ART[key];
        if (s && !(s.image === image && s.sequences.includes(seq))) {
          row({ ...base, webra: `${s.image}.${s.sequences.join('+')}`, where: `special ${key}`, status: 'wrong' });
          continue;
        }
        specialRow(base, key);
        continue;
      }
      if (!entry) {
        // An actor whose body is OpenRA's own art keeps all of WebRA's (no mixed look).
        const own = facts.parts.some((p) => (p[0] === 'body' || p[0] === 'stand') && !p[3]);
        row({ ...base, status: own ? 'webra-only' : 'fallback', note: own ? "the actor's body is OpenRA's own art: WebRA draws all of it" : 'no ACTOR_ART entry' });
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
      if (spec.muzzle) {
        const where = 'muzzle';
        if (entry.muzzle !== seq) {
          row({ ...base, webra: entry.muzzle ? `${image}.${entry.muzzle}` : null, where, status: entry.muzzle ? 'wrong' : 'fallback' });
          continue;
        }
        const art = built.slots.get(muzzleSlot(t, actors.length));
        if (!art) {
          row({ ...base, where, status: 'fallback', note: 'not built from the files' });
          continue;
        }
        const problem = check(art, POSE.MAKE, [SEQUENCES[image][seq]], { offset: [0, 0], mode: MODE.ONCE, limit: FX_LIMITS.muzzle });
        row({ ...base, webra: openra, where, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
        continue;
      }
      const slot = 2 * t + (spec.part === 'second' ? 1 : 0);
      const center = a.kind === 'building' ? (a.centerOffset ?? [0, 0]) : [0, 0];
      if (spec.lead) {
        // A lead-in: played once before the pose's own sequence, which then loops.
        const pose = spec.lead;
        const where = `body.${pose} lead-in`;
        if (entry.lead?.[pose] !== seq) {
          row({ ...base, webra: entry.lead?.[pose] ? `${image}.${entry.lead[pose]}` : null, where, status: entry.lead?.[pose] ? 'wrong' : 'fallback' });
          continue;
        }
        const art = built.slots.get(slot);
        const defs = [SEQUENCES[image][seq], SEQUENCES[image][entry.body[pose]]];
        let problem = art ? check(art, POSE_OF[pose], defs, { offset: center, mode: MODE.LEAD, lead: resolvedLength(defs[0]) }) : 'not built from the files';
        if (!problem && spec.reverse) {
          // Leaving: the lead-in backwards (OpenRA PlayCustomAnimationBackwards).
          problem = entry.body[spec.reverse] !== seq || !entry.reverseEnd
            ? `the ${spec.reverse} pose is not ${seq} backwards`
            : check(art, POSE_OF[spec.reverse], [defs[0]], { offset: center, mode: MODE.ONCE, reverse: true, limit: FX_LIMITS.activeOnce });
        }
        row({ ...base, webra: openra, where, status: problem ? (art ? 'wrong' : 'fallback') : 'ok', note: problem ?? '' });
        continue;
      }
      let pose = typeof spec.pose === 'function' ? spec.pose(seq) : spec.pose;
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
      const art = built.slots.get(slot);
      if (!art) {
        row({ ...base, webra: openra, where, status: 'fallback', note: 'not built from the files' });
        continue;
      }
      const defs = [SEQUENCES[image][seq]];
      const lift = spec.part === 'second' ? (entry.lift?.[pose] ?? 0) : 0;
      const mode = expectedMode(entry, spec.part, pose);
      const lead = spec.part === 'body' && entry.lead?.[pose] ? SEQUENCES[image][entry.lead[pose]] : null;
      if (lead) defs.unshift(lead);
      const problem = check(art, POSE_OF[pose], defs, {
        offset: [center[0], center[1] + lift],
        mode,
        lead: lead ? resolvedLength(lead) : 0,
        reverse: pose === 'active-end' && !!entry.reverseEnd,
        limit: FX_LIMITS.activeOnce,
      });
      row({ ...base, webra: openra, where, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
    }
  }

  // Special sprites: what the engine draws besides the actors.
  for (const key of Object.keys(SPECIAL_ART)) {
    const spec = SPECIAL_ART[key];
    specialRow({ actor: '(special)', role: key, openra: spec ? `${spec.image}.${spec.sequences.join('+')}` : null }, key);
  }

  // Explosions of OpenRA's CreateEffect warheads, one slot each.
  EXPLOSIONS.forEach((name, k) => {
    const spec = EXPLOSION_ART[name];
    const base = { actor: '(explosion)', role: name, openra: `explosion.${name}`, where: 'explosion' };
    if (!spec) {
      row({ ...base, status: 'webra-only', note: 'OpenRA made this art (bits.txt); Red Alert has none' });
      return;
    }
    const art = built.slots.get(explosionSlot(k, actors.length));
    if (!art) {
      row({ ...base, status: 'fallback', note: 'not built from the files' });
      return;
    }
    const problem = check(art, POSE.MAKE, specialDefs(spec), { offset: [0, 0], mode: MODE.ONCE, limit: FX_LIMITS.explosion });
    row({ ...base, webra: base.openra, status: problem ? 'wrong' : 'ok', note: problem ?? '' });
  });

  // Mouse cursors: every cursor kind by its OpenRA cursor name.
  const cursors = originalCursorFrames(getFile);
  const kinds = [...Object.entries(CURSOR_NAMES), ...Object.entries(COMMAND_CURSOR_NAMES)];
  for (const [kind, name] of kinds) {
    const c = CURSOR_ART[name];
    const base = { actor: '(cursor)', role: kind, openra: name, where: 'cursor' };
    if (!c) {
      row({ ...base, status: 'webra-only', note: 'OpenRA made this cursor (nopower.shp, attackmove.shp); Red Alert has none' });
      continue;
    }
    const got = cursors.get(name);
    const ok = got && got.frames.length === c.length;
    row({ ...base, webra: ok ? name : null, status: ok ? 'ok' : 'fallback', note: ok ? '' : `${c.file} frames ${c.start}..${c.start + c.length - 1} not installed` });
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
    lines.push([r.status.padEnd(10), r.actor.padEnd(13), r.role.padEnd(18), (r.openra ?? '-').padEnd(30), (r.where || '-').padEnd(20), r.note].join(' ').trimEnd());
  }
  if (problems.length) lines.push('', 'Problems loading the files:', ...problems.map((p) => `  ${p}`));
  lines.push('', Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  return lines.join('\n');
}
