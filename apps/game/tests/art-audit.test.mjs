// The original art audit (js/content/audit.js) on synthetic files: every
// file the sequence tables name is made up here, each frame a 4x2 picture
// that spells its own file and frame number, so the audit can check that
// every pose of every actor and special sprite shows OpenRA's frames in
// OpenRA's order, facings, rate, mode and offset. No Electronic Arts file,
// and nothing made from one, is in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTOR_ART, ACTOR_PALETTE, CURSOR_ART, EXPLOSIONS, EXPLOSION_ART, RESOURCES, SEQUENCES, SPECIAL_ART, TERRAIN, TREES } from '../js/content/tables.js';
import { RENDER_FACTS } from '../js/content/render-facts.js';
import { auditOriginalArt, formatAudit, ROLES, FX_LIMITS } from '../js/content/audit.js';
import { originalSlots, combineSlots, originalSlotInfo, specialSlot, muzzleSlot, explosionSlot, SPECIAL_MODULES, MODULE_SPECIAL_SLOTS, ORIGINAL_INFO } from '../js/content/atlas.js';
import { resolveSequence, POSE, POSE_COUNT } from '../js/content/sequences.js';
import { decodePalette, paletteLookup, ACTOR_SHADOW } from '../js/content/palette.js';
import { SPECIALS } from '../js/content/packs.js';
import { spriteList, SPECIAL_SLOTS } from '../js/sprites.js';
import { NAVAL_SPECIALS } from '../js/art/naval.js';
import { PLANE_SPECIALS } from '../js/art/planes.js';
import { HELI_SPECIALS } from '../js/art/helis.js';
import { ABILITY_SPECIALS } from '../js/art/abilities.js';
import { VETERANCY_SPECIALS } from '../js/art/veterancy.js';
import { DECORATION_SPECIALS } from '../js/art/decorations.js';
import { EFFECT_SPECIALS } from '../js/art/effects.js';
import { buildShp, buildPal } from './content-fixtures.mjs';
import init, { Game } from '../pkg/webra_sim.js';

await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const ACTORS = JSON.parse(new Game(7, 'england', 'russia', 64).rules_json()).actors;

// ---- Synthetic files ----------------------------------------------------------------

/** Every file a sequence, tree, resource or theater names, and how many frames each needs. */
function neededFrames() {
  const need = new Map();
  const want = (file, n) => need.set(file, Math.max(need.get(file) ?? 1, n));
  const defs = [...Object.values(SEQUENCES).flatMap((seqs) => Object.values(seqs)), ...Object.values(TREES), ...RESOURCES.ore, ...RESOURCES.gems];
  for (const def of defs) {
    for (const file of [def.file, ...Object.values(def.tilesets ?? {})]) {
      if (def.length === -1) {
        want(file, (def.start ?? 0) + 3);
        continue;
      }
      const r = resolveSequence(def, 4096);
      want(file, Math.max(...r.fileFrames, ...(r.shadowFrames ?? [])) + 1);
    }
  }
  for (const t of Object.values(TERRAIN)) for (const f of t.images) want(f, 1);
  for (const c of Object.values(CURSOR_ART)) want(c.file, c.start + c.length);
  return need;
}

/** Palette indices that spell numbers: clear of 0 (transparent), the shadow and the 80..95 remap range. */
const DIGIT = 100;
const digit = (v) => DIGIT + v;

/** Synthetic files: frame k of file f is [k % 100, k / 100, f % 100, f / 100] in two rows. */
function syntheticFiles() {
  const need = neededFrames();
  const names = [...need.keys()].sort();
  const files = new Map();
  names.forEach((name, f) => {
    const frames = [];
    for (let k = 0; k < need.get(name); k++) {
      const row = [digit(k % 100), digit(Math.floor(k / 100)), digit(f % 100), digit(Math.floor(f / 100))];
      frames.push(Uint8Array.from([...row, ...row]));
    }
    files.set(name, buildShp(4, 2, frames));
  });
  // Indices 100..199 as unique colours (6-bit: low six bits, then the rest).
  const pal = buildPal((i) => [i & 63, i >> 6, 7]);
  files.set(ACTOR_PALETTE, pal);
  for (const t of Object.values(TERRAIN)) files.set(t.palette, pal);
  return { files, names, pal };
}

/** Names the file and frame an atlas image was cut from (`null` for anything else). */
function identifier(names, pal) {
  const lookup = paletteLookup(decodePalette(pal), { remap: true, shadow: ACTOR_SHADOW });
  const index = new Map();
  for (let i = DIGIT; i < DIGIT + 100; i++) index.set(Array.from(lookup.color.subarray(i * 4, i * 4 + 3)).join(','), i - DIGIT);
  return (img) => {
    if (!img || img.width !== 4 || img.height !== 2) return null;
    const d = [0, 1, 2, 3].map((x) => index.get(Array.from(img.color.subarray(x * 4, x * 4 + 3)).join(',')));
    if (d.some((v) => v === undefined)) return null;
    return { file: names[d[2] + d[3] * 100], frame: d[0] + d[1] * 100 };
  };
}

const SYNTH = syntheticFiles();
const getFile = (n) => SYNTH.files.get(n) ?? null;
const identify = identifier(SYNTH.names, SYNTH.pal);

// ---- The audit ------------------------------------------------------------------------

test('art audit: every actor and special sprite shows OpenRA frames or is a known gap', () => {
  for (const tileset of ['TEMPERAT', 'SNOW', 'DESERT']) {
    const result = auditOriginalArt(ACTORS, getFile, { tileset, identify });
    const bad = result.rows.filter((r) => r.status === 'wrong' || r.status === 'fallback');
    assert.deepEqual(bad, [], `${tileset}:\n${formatAudit({ ...result, rows: bad })}`);
    assert.deepEqual(result.problems, [], tileset);
    // The identifier really checked frames: some rows would fail without it.
    assert.ok(result.counts.ok > 300, `${tileset}: ${JSON.stringify(result.counts)}`);
  }
});

test('art audit: complete, every rules actor and every OpenRA render sequence has a row with a reason', () => {
  const { rows } = auditOriginalArt(ACTORS, getFile, { identify });
  for (const a of ACTORS) {
    assert.ok(RENDER_FACTS[a.id], `${a.id}: OpenRA facts (python3 tools/gen_content_tables.py)`);
    const mine = rows.filter((r) => r.actor === a.id);
    assert.equal(mine.length, RENDER_FACTS[a.id].parts.length, `${a.id}: a row per OpenRA sequence`);
    for (const r of mine) {
      if (r.status === 'gap') assert.ok(r.note, `${a.id} ${r.role}: a gap says what is missing`);
      if (r.status === 'webra-only') assert.ok(r.note, `${a.id} ${r.role}: says why`);
    }
  }
  // Every role OpenRA uses has a rule.
  for (const f of Object.values(RENDER_FACTS)) for (const [role] of f.parts) assert.ok(ROLES[role], `audit rule for ${role}`);
  // Every special slot is listed.
  const specials = rows.filter((r) => r.actor === '(special)').map((r) => r.role);
  assert.deepEqual(specials.sort(), Object.keys(SPECIAL_ART).sort());
  // Every explosion and every cursor kind is listed.
  assert.deepEqual(rows.filter((r) => r.actor === '(explosion)').map((r) => r.role), EXPLOSIONS);
  assert.ok(rows.filter((r) => r.actor === '(cursor)').length >= 30);
  // Only OpenRA's own art and specials Red Alert has nothing for keep WebRA art.
  for (const r of rows.filter((x) => x.status === 'webra-only')) {
    if (r.actor === '(special)') assert.equal(SPECIAL_ART[r.role], null, r.role);
    else if (r.actor === '(explosion)') assert.equal(EXPLOSION_ART[r.role], null, r.role);
    else if (r.actor === '(cursor)') assert.equal(CURSOR_ART[r.openra], undefined, r.role);
    else if (!/OpenRA's own art/.test(r.note)) assert.equal(RENDER_FACTS[r.actor].parts.find((p) => `${p[1]}.${p[2]}` === r.openra)[3], false, `${r.actor} ${r.openra}`);
  }
  // What is left for other work: infantry deaths, idles and stand variants, husks; n/a: vehicles by parachute.
  for (const r of rows.filter((x) => x.status === 'gap')) assert.ok(['death', 'idle-anim', 'stand', 'prone-stand', 'husk'].includes(r.role), `${r.actor} ${r.role}: ${r.note}`);
  for (const r of rows.filter((x) => x.status === 'n/a')) assert.equal(r.role, 'parachute', `${r.actor} ${r.role}`);
});

test('art audit: helicopters, spinners, the silo and specials come from the original art', () => {
  const { rows } = auditOriginalArt(ACTORS, getFile, { identify });
  const status = (actor, openra) => rows.find((r) => r.actor === actor && r.openra === openra)?.status;
  for (const id of ['HELI', 'HIND', 'TRAN']) {
    assert.equal(status(id, `${id.toLowerCase()}.idle`), 'ok', `${id} body`);
    assert.equal(status(id, `${id.toLowerCase()}.rotor`), 'ok', `${id} rotor in the air`);
    assert.equal(status(id, `${id.toLowerCase()}.slow-rotor`), 'ok', `${id} rotor on the ground`);
  }
  assert.equal(status('TRAN', 'tran.rotor2'), 'ok', 'the Chinook rear rotor');
  assert.equal(status('TRAN', 'tran.slow-rotor2'), 'ok');
  assert.equal(rows.find((r) => r.openra === 'tran.rotor2').where, 'second.aux-move');
  for (const [id, seq] of [['MRJ', 'mrj.spinner'], ['MGG', 'mgg.spinner'], ['TTNK', 'ttnk.spinner'], ['SILO', 'silo.stages'], ['SILO', 'silo.damaged-stages'], ['MINV', 'minv.idle'], ['JEEP', 'jeep.turret']]) {
    assert.equal(status(id, seq), 'ok', `${id} ${seq}`);
  }
  // Working animations, recoil, doors, docking, reloading, falling, muzzle flashes, smoke.
  for (const [id, seq] of [
    ['FIX', 'fix.active'], ['HPAD', 'hpad.damaged-active'], ['AFLD', 'afld.active'], ['TSLA', 'tsla.active'], ['MSLO', 'mslo.active'],
    ['FACT', 'fact.build'], ['GUN', 'gun.recoil'], ['LST', 'lst.open'], ['LST', 'lst.unload'], ['LST', 'lst.close'],
    ['HARV', 'harv.dock'], ['HARV', 'harv.dock-loop'], ['V2RL', 'v2rl.empty-idle'], ['E1', 'e1.parachute'], ['E1', 'parach.open'],
    ['2TNK', '2tnk.muzzle'], ['HIND', 'hind.muzzle'], ['SAM', 'sam.muzzle'], ['2TNK', 'smoke_m.start'], ['CA', 'smoke_m.loop'],
  ]) {
    assert.equal(status(id, seq), 'ok', `${id} ${seq}`);
  }
  for (const name of ['piff', 'small_explosion', 'self_destruct', 'building', 'napalm', 'large_splash', 'small_explosion_air']) {
    assert.equal(rows.find((r) => r.actor === '(explosion)' && r.role === name).status, 'ok', name);
  }
  for (const kind of ['select', 'move', 'attack', 'sell', 'repairMode', 'deploy', 'nuke', 'guard', 'scrollNW', 'blocked']) {
    assert.equal(rows.find((r) => r.actor === '(cursor)' && r.role === kind).status, 'ok', kind);
  }
  for (const key of ['fx.0', 'fx.1', 'fx.2', 'planes.0']) assert.equal(rows.find((r) => r.actor === '(special)' && r.role === key).status, 'ok', key);
  // OpenRA's own units have no Red Alert art at all.
  for (const id of ['MH60', 'FTRK']) assert.equal(status(id, `${id.toLowerCase()}.idle`), 'webra-only');
  for (const key of ['bullet', 'small_explosion', 'large_explosion', 'piff', 'rally', 'missile', 'nuke', 'naval.0', 'naval.2', 'planes.0', 'helis.2', 'decorations.0']) {
    assert.equal(rows.find((r) => r.actor === '(special)' && r.role === key).status, 'ok', key);
  }
});

test('art audit: a wrong mapping, missing files and shifted frames are caught', () => {
  // A file whose frames come from another file: every pose using it is wrong.
  const swapped = (n) => (n === 'heli.shp' ? SYNTH.files.get('hind.shp') : getFile(n));
  const r1 = auditOriginalArt(ACTORS, swapped, { identify });
  assert.equal(r1.rows.find((r) => r.actor === 'HELI' && r.openra === 'heli.idle').status, 'wrong');
  // A missing file: the actor falls back to WebRA art.
  const missing = (n) => (n === 'lrotor.shp' ? null : getFile(n));
  const r2 = auditOriginalArt(ACTORS, missing, { identify });
  assert.equal(r2.rows.find((r) => r.actor === 'HELI' && r.openra === 'heli.rotor').status, 'fallback');
  assert.match(formatAudit(r2, { only: ['fallback'] }), /HELI\s+rotor-air/);
});

// ---- Slots, specials and what the engine is told -------------------------------------

test('special slots: the audit, the atlas and the engine agree on where each special sprite is', () => {
  const lists = [NAVAL_SPECIALS, PLANE_SPECIALS, HELI_SPECIALS, ABILITY_SPECIALS, VETERANCY_SPECIALS, DECORATION_SPECIALS, EFFECT_SPECIALS];
  assert.equal(SPECIAL_SLOTS, MODULE_SPECIAL_SLOTS);
  assert.equal(SPECIAL_MODULES.length, lists.length);
  const list = spriteList(ACTORS);
  assert.equal(list.length, ACTORS.length * 2 + SPECIALS.length + SPECIAL_MODULES.length * SPECIAL_SLOTS + ACTORS.length + EXPLOSIONS.length);
  // Muzzle flashes per actor, then the explosions, after the specials (engine/src/render.rs muzzle_base, explosion_base).
  assert.equal(muzzleSlot(0, ACTORS.length), ACTORS.length * 2 + SPECIALS.length + SPECIAL_MODULES.length * SPECIAL_SLOTS);
  assert.equal(explosionSlot(0, ACTORS.length), muzzleSlot(ACTORS.length, ACTORS.length));
  assert.ok(list[explosionSlot(EXPLOSIONS.indexOf('piff'), ACTORS.length)], 'WebRA draws every explosion');
  for (const key of Object.keys(SPECIAL_ART)) {
    const slot = specialSlot(key, ACTORS.length);
    assert.ok(slot >= ACTORS.length * 2 && slot < list.length, key);
    const [mod, k] = key.split('.');
    if (k !== undefined) assert.ok(Number(k) < lists[SPECIAL_MODULES.indexOf(mod)].length, `${key} is one of the module's specials`);
  }
  assert.equal(specialSlot('missile', ACTORS.length), ACTORS.length * 2 + SPECIALS.indexOf('missile'));
  assert.equal(specialSlot('helis.2', ACTORS.length), ACTORS.length * 2 + SPECIALS.length + 2 * SPECIAL_SLOTS + 2);
  assert.equal(specialSlot('helis.9', ACTORS.length), -1);
  assert.equal(specialSlot('nothing', ACTORS.length), -1);
  // engine/src/render.rs SpriteIds: naval, planes, helis, abilities, veterancy, decorations in this order.
  const render = readFileSync(fileURLToPath(new URL('../../../engine/src/render.rs', import.meta.url)), 'utf8');
  const bases = SPECIAL_MODULES.map((m) => Number(render.match(new RegExp(`${m}_base: b \\+ (\\d+)\\.0`))[1]));
  assert.deepEqual(bases, SPECIAL_MODULES.map((_, i) => SPECIALS.length + i * SPECIAL_SLOTS));
  assert.equal(Number(render.match(/muzzle_base: b \+ (\d+)\.0/)[1]), SPECIALS.length + SPECIAL_MODULES.length * SPECIAL_SLOTS);
  // The engine draws effects as long as the audit allows their original sequences.
  const fx = readFileSync(fileURLToPath(new URL('../../../engine/src/fx.rs', import.meta.url)), 'utf8');
  const constant = (name) => Number(fx.match(new RegExp(`pub const ${name}: \\w+ = (\\d+);`))[1]);
  assert.deepEqual(
    [constant('EXPLOSION_LIFE'), constant('MUZZLE_LIFE'), constant('SMOKE_LIFE'), constant('ACTIVE_ONCE_LIFE')],
    [FX_LIMITS.explosion, FX_LIMITS.muzzle, FX_LIMITS.smoke, FX_LIMITS.activeOnce],
  );
});

test('original slots: rotors, effects and levels as pose tables; what the engine is told', () => {
  const out = originalSlots(ACTORS, getFile, 'TEMPERAT');
  const t = (id) => ACTORS.findIndex((a) => a.id === id);
  // The Chinook's rotors: ground and air, front and rear; heights drawn into the frames.
  const tran = out.slots.get(2 * t('TRAN') + 1);
  assert.equal(tran.poses.length, POSE_COUNT);
  const first = (pose) => identify(tran.images[tran.poses[pose].frames[0]]);
  assert.deepEqual(first(POSE.IDLE), { file: 'lrotor.shp', frame: 4 }, 'slow front rotor');
  assert.deepEqual(first(POSE.MOVE), { file: 'lrotor.shp', frame: 0 });
  assert.deepEqual(first(POSE.AUX_IDLE), { file: 'rrotor.shp', frame: 4 }, 'slow rear rotor');
  assert.deepEqual(first(POSE.AUX_MOVE), { file: 'rrotor.shp', frame: 0 });
  const offsetY = (pose) => tran.images[tran.poses[pose].frames[0]].offset[1];
  assert.equal(offsetY(POSE.MOVE), ACTOR_ART.TRAN.lift.move);
  assert.ok(offsetY(POSE.AUX_MOVE) < offsetY(POSE.MOVE), 'the rear rotor sits higher (OpenRA offset Z 341 against 213)');
  // A helicopter without a second rotor falls back to its only one.
  const heli = out.slots.get(2 * t('HELI') + 1);
  assert.equal(heli.poses[POSE.AUX_MOVE], heli.poses[POSE.MOVE]);
  // Effects play once at the make pose and show nothing otherwise.
  const boom = out.slots.get(specialSlot('small_explosion', ACTORS.length));
  assert.equal(boom.poses[POSE.MAKE].mode, 1);
  assert.equal(boom.images[boom.poses[POSE.IDLE].frames[0]].width, 0);
  // The silo indexes its stages.
  const silo = out.slots.get(2 * t('SILO'));
  assert.equal(silo.poses[POSE.IDLE].mode, 3);
  assert.deepEqual(out.levels, [[t('SILO'), silo.poses[POSE.IDLE].length]]);
  assert.deepEqual(out.unitOverlays.sort((a, b) => a[0] - b[0]), [[t('MRJ'), -256, 0], [t('MGG'), -299, 0]].sort((a, b) => a[0] - b[0]));

  // What Game.set_original_slots gets: original slots only, records for original parts only.
  const { source } = combineSlots(ACTORS.length, { original: out });
  const info = originalSlotInfo(source, out);
  assert.ok(info.slots.includes(2 * t('TRAN') + 1) && info.slots.includes(specialSlot('missile', ACTORS.length)));
  assert.ok(!info.slots.includes(specialSlot('chrono', ACTORS.length)), 'WebRA art stays WebRA');
  const records = [];
  for (let k = 0; k < info.info.length; k += 4) records.push(Array.from(info.info.slice(k, k + 4)));
  assert.deepEqual(
    records.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [
      [ORIGINAL_INFO.OVERLAY, t('MRJ'), -256, 0],
      [ORIGINAL_INFO.OVERLAY, t('MGG'), -299, 0],
      [ORIGINAL_INFO.LEVEL, t('SILO'), silo.poses[POSE.IDLE].length, 0],
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  );
  // A pack's second slot wins over the original: no overlay record for it then.
  const pack = { name: 'p', slots: new Map([[2 * t('MRJ') + 1, out.slots.get(2 * t('MRJ') + 1)]]) };
  const packed = combineSlots(ACTORS.length, { packs: [pack], original: out });
  const without = originalSlotInfo(packed.source, out).info;
  assert.ok(!Array.from(without).some((v, k) => k % 4 === 1 && v === t('MRJ')));
  // The engine takes it and draws nothing differently in the simulation.
  const game = new Game(7, 'england', 'russia', 64);
  const before = game.state_hash();
  game.set_original_slots(info.slots, info.info);
  assert.equal(game.state_hash(), before);
});
