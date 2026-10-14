// The original art audit (js/content/audit.js) on synthetic files
// (original-fixtures.mjs): every file the sequence tables name, each frame
// a 4x2 picture that spells its own file and frame number, so the audit can
// check that every pose of every actor and special sprite shows OpenRA's
// frames in OpenRA's order, facings, rate, mode and offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTOR_ART, CURSOR_ART, EXPLOSIONS, EXPLOSION_ART, SPECIAL_ART } from '../js/content/tables.js';
import { MISSION_ACTORS, OPENRA_MADE_FILES, RENDER_FACTS, WEBRA_ACTORS } from '../js/content/render-facts.js';
import { auditOriginalArt, formatAudit, ROLES, FX_LIMITS, withMissionActors } from '../js/content/audit.js';
import { originalSlots, combineSlots, originalSlotInfo, specialSlot, muzzleSlot, explosionSlot, SPECIAL_MODULES, MODULE_SPECIAL_SLOTS, ORIGINAL_INFO } from '../js/content/atlas.js';
import { POSE, POSE_COUNT } from '../js/content/sequences.js';
import { SPECIALS } from '../js/content/packs.js';
import { spriteList, SPECIAL_SLOTS } from '../js/sprites.js';
import { NAVAL_SPECIALS } from '../js/art/naval.js';
import { PLANE_SPECIALS } from '../js/art/planes.js';
import { HELI_SPECIALS } from '../js/art/helis.js';
import { ABILITY_SPECIALS } from '../js/art/abilities.js';
import { VETERANCY_SPECIALS } from '../js/art/veterancy.js';
import { DECORATION_SPECIALS } from '../js/art/decorations.js';
import { EFFECT_SPECIALS } from '../js/art/effects.js';
import { LEFTOVER_SPECIALS } from '../js/art/leftovers.js';
import { INFANTRY_SPECIALS } from '../js/art/infantry.js';
import { syntheticFiles, identifier } from './original-fixtures.mjs';
import { buildShp } from './content-fixtures.mjs';
import init, { Game } from '../pkg/webra_sim.js';

await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const ACTORS = JSON.parse(new Game(7, 'england', 'russia', 64).rules_json()).actors;
// The rules actors and the campaign's characters and wrecks (mission actors are drawn as them).
const AUDITED = withMissionActors(ACTORS);

const SYNTH = syntheticFiles();
const getFile = (n) => SYNTH.files.get(n) ?? null;
const identify = identifier(SYNTH.names, SYNTH.pal);

// ---- The audit ------------------------------------------------------------------------

test('art audit: every actor and special sprite shows OpenRA frames or is a known gap', () => {
  for (const tileset of ['TEMPERAT', 'SNOW', 'DESERT']) {
    const result = auditOriginalArt(AUDITED, getFile, { tileset, identify });
    const bad = result.rows.filter((r) => r.status === 'wrong' || r.status === 'fallback');
    assert.deepEqual(bad, [], `${tileset}:\n${formatAudit({ ...result, rows: bad })}`);
    assert.deepEqual(result.problems, [], tileset);
    // The identifier really checked frames: some rows would fail without it.
    assert.ok(result.counts.ok > 300, `${tileset}: ${JSON.stringify(result.counts)}`);
  }
});

test('art audit: complete, every rules actor and every OpenRA render sequence has a row with a reason', () => {
  const { rows } = auditOriginalArt(AUDITED, getFile, { identify });
  assert.ok(AUDITED.length > ACTORS.length, 'the campaign characters are audited too');
  for (const a of AUDITED) {
    if (WEBRA_ACTORS.includes(a.id)) {
      // WebRA's own actors: not OpenRA's, no facts; a webra-only row per pose of their own art.
      assert.equal(RENDER_FACTS[a.id], undefined, a.id);
      const mine = rows.filter((r) => r.actor === a.id);
      assert.ok(mine.length > 0, `${a.id}: rows`);
      for (const r of mine) assert.ok(r.status === 'webra-only' && r.note, `${a.id} ${r.role}`);
      continue;
    }
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
    else if (WEBRA_ACTORS.includes(r.actor)) assert.equal(r.openra, null, r.actor);
    else if (!/OpenRA's own art/.test(r.note)) assert.equal(RENDER_FACTS[r.actor].parts.find((p) => `${p[1]}.${p[2]}` === r.openra)[3], false, `${r.actor} ${r.openra}`);
  }
  // What is left: vehicles that leave no husk; n/a: vehicles by parachute. Infantry
  // deaths, idle animations, stand variants and attack variants all have poses.
  for (const r of rows.filter((x) => x.status === 'gap')) assert.equal(r.role, 'husk', `${r.actor} ${r.role}: ${r.note}`);
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
  for (const key of ['fx.0', 'fx.1', 'fx.2', 'fx.3', 'missile', 'planes.0']) assert.equal(rows.find((r) => r.actor === '(special)' && r.role === key).status, 'ok', key);
  // OpenRA's own units have no Red Alert art at all.
  for (const id of ['MH60', 'FTRK']) assert.equal(status(id, `${id.toLowerCase()}.idle`), 'webra-only');
  for (const key of ['bullet', 'small_explosion', 'large_explosion', 'piff', 'rally', 'missile', 'nuke', 'naval.0', 'naval.2', 'planes.0', 'helis.2', 'decorations.1']) {
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

test('art audit: an actor OpenRA draws from Red Alert files without an original mapping fails', () => {
  // The campaign's characters are checked like the rules actors: Einstein and
  // Chan are Red Alert's (hires.mix), their whole body is the original's.
  const { rows } = auditOriginalArt(AUDITED, getFile, { identify });
  const status = (actor, openra) => rows.find((r) => r.actor === actor && r.openra === openra)?.status;
  for (const id of Object.keys(MISSION_ACTORS)) assert.ok(rows.some((r) => r.actor === id), `${id} has rows`);
  for (const id of ['EINSTEIN', 'CHAN']) {
    for (const seq of ['stand', 'run', 'idle1', 'die1', 'die5']) assert.equal(status(id, `${id.toLowerCase()}.${seq}`), 'ok', `${id} ${seq}`);
  }
  // The ants die with their one death sequence (WithDeathAnimation UseDeathTypeSuffix: false).
  for (const id of ['ANT', 'FIREANT', 'SCOUTANT']) assert.equal(status(id, `${id.toLowerCase()}.die`), 'ok', `${id} die`);
  assert.deepEqual(new Set(['die1', 'die2', 'die3', 'die4', 'die5', 'die6'].map((p) => ACTOR_ART.ANT.body[p])), new Set(['die']));
  assert.equal(status('(special)', 'crate-effects.heal'), 'ok', 'the crate heal animation is Red Alert\'s invun.shp');
  assert.equal(rows.find((r) => r.actor === '(explosion)' && r.role === 'small_napalm').status, 'ok', "Red Alert's napalm1.shp");
  assert.ok(!rows.some((r) => r.actor === '(files)'), 'no OpenRA-made file among the synthetic originals');

  // An actor whose OpenRA sequences are on original files but has no mapping: every such row fails.
  const without = { ...ACTOR_ART };
  delete without.EINSTEIN;
  delete without.POWR;
  const r1 = auditOriginalArt(AUDITED, getFile, { identify, actorArt: without });
  for (const id of ['EINSTEIN', 'POWR']) {
    // (Parachutes and damage smoke are special sprites, the power plant's ruin is OpenRA's own art.)
    const mine = r1.rows.filter((r) => r.actor === id && !r.where.startsWith('special') && r.status !== 'webra-only');
    assert.ok(mine.length > 1 && mine.every((r) => r.status === 'fallback' && r.note === 'no ACTOR_ART entry'), `${id}: ${formatAudit({ ...r1, rows: mine })}`);
  }

  // OpenRA's own files are left out (webra-only) only while Red Alert has
  // none: a player's copy with an "OpenRA-made" file means the tables miss
  // its original art (as they once missed Einstein's and Chan's).
  assert.ok(OPENRA_MADE_FILES['oilb.shp'].includes('oilb.idle'), 'the oil derrick is OpenRA\'s own art');
  assert.equal(OPENRA_MADE_FILES['einstein.shp'], undefined, 'Einstein is not OpenRA-made');
  assert.equal(status('OILB', 'oilb.idle'), 'webra-only');
  // Red Alert has no derrick: WebRA draws its own pixel art (art/pixel.js), idle and damaged.
  for (const [seq, pose] of [['oilb.idle', 'idle'], ['oilb.damaged-idle', 'damaged']]) {
    const r = rows.find((x) => x.actor === 'OILB' && x.openra === seq);
    assert.equal(r.status, 'webra-only', seq);
    assert.equal(r.webra, `pixel oilb.${pose}`, seq);
    assert.equal(r.where, `body.${pose}`, seq);
    assert.match(r.note, /WebRA's own pixel art in Red Alert's style/);
  }
  // The Black Hawk and the Mobile Flak: every sequence OpenRA draws from its own files is WebRA's pixel art.
  for (const [actor, seq, webra, where] of [
    ['MH60', 'mh60.idle', 'pixel mh60.idle', 'body.idle'],
    ['MH60', 'mh60.slow-rotor', 'pixel mh60.second.idle', 'second.idle'],
    ['MH60', 'mh60.rotor', 'pixel mh60.second.move', 'second.move'],
    ['MH60', 'mh60.icon', 'pixel mh60.cameo', 'cameo'],
    ['FTRK', 'ftrk.idle', 'pixel ftrk.idle', 'body.idle'],
    ['FTRK', 'ftrk.turret', 'pixel ftrk.second.idle', 'second.idle'],
    ['FTRK', 'ftrk.icon', 'pixel ftrk.cameo', 'cameo'],
  ]) {
    const r = rows.find((x) => x.actor === actor && x.openra === seq && x.role !== 'husk');
    assert.deepEqual([r.status, r.webra, r.where], ['webra-only', webra, where], `${actor} ${seq}`);
    assert.match(r.note, /WebRA's own pixel art in Red Alert's style/);
  }
  // The Black Hawk's husk is its body falling (the idle sequence).
  const husk = rows.find((x) => x.actor === 'MH60' && x.role === 'husk');
  assert.deepEqual([husk.status, husk.webra, husk.where], ['webra-only', 'pixel mh60.idle', 'body.idle']);
  // Their muzzle flashes are Red Alert's (minigun, gunfire) when installed.
  for (const [actor, seq] of [['MH60', 'mh60.muzzle'], ['FTRK', 'ftrk.muzzle']]) {
    const r = rows.find((x) => x.actor === actor && x.openra === seq);
    assert.equal(r.where, 'muzzle', seq);
    assert.equal(r.status, 'ok', seq);
  }
  // WebRA's own Lightning Rod (data/webra/rules.yaml): no OpenRA or Red Alert art, its pixel art throughout.
  assert.ok(WEBRA_ACTORS.includes('LROD'));
  assert.ok(ACTORS.some((a) => a.id === 'LROD'), 'the Lightning Rod is in the rules');
  const lrod = rows.filter((r) => r.actor === 'LROD');
  assert.deepEqual(
    lrod.map((r) => [r.role, r.webra, r.where, r.status, r.openra]),
    [
      ['body-damaged', 'pixel lrod.damaged', 'body.damaged', 'webra-only', null],
      ['body', 'pixel lrod.idle', 'body.idle', 'webra-only', null],
      ['make', 'pixel lrod.make', 'body.make', 'webra-only', null],
      ['icon', 'pixel lrod.cameo', 'cameo', 'webra-only', null],
    ],
  );
  for (const r of lrod) assert.match(r.note, /WebRA's own actor .*pixel art in Red Alert's style/);
  // Without pixel art (the hut) the note says only that Red Alert has none.
  const hut = rows.find((r) => r.actor === 'ASIANHUT' && r.openra === 'asianhut.idle');
  assert.deepEqual([hut.status, hut.webra, hut.note], ['webra-only', null, 'OpenRA made this art (bits.txt); Red Alert has none']);
  const fake = buildShp(4, 2, [new Uint8Array(8).fill(1), new Uint8Array(8).fill(2)]);
  const withOilb = (n) => (n === 'oilb.shp' ? fake : getFile(n));
  const r2 = auditOriginalArt(AUDITED, withOilb, { identify });
  for (const seq of ['oilb.idle', 'oilb.damaged-idle']) {
    assert.equal(r2.rows.find((r) => r.actor === 'OILB' && r.openra === seq).status, 'wrong', seq);
  }
  const file = r2.rows.find((r) => r.actor === '(files)' && r.role === 'oilb.shp');
  assert.equal(file?.status, 'wrong');
  assert.match(file.note, /IN_RED_ALERT_TOO; used by .*oilb\.idle/);
  assert.match(formatAudit(r2, { only: ['wrong'] }), /OILB\s+body\s+oilb\.idle/);
});

// ---- Slots, specials and what the engine is told -------------------------------------

test('art audit: crates, husks, their fire and the smudges come from the original art', () => {
  // The audit's leftover limits are the engine's effect lifetimes.
  const husks = readFileSync(fileURLToPath(new URL('../../../engine/src/husks.rs', import.meta.url)), 'utf8');
  const ticks = husks.match(/LEFTOVER_EFFECT_TICKS: \[i32; 8\] = \[([^\]]*)\]/)[1].split(',').map(Number);
  assert.deepEqual(ticks, [...FX_LIMITS.leftovers]);
  const { rows } = auditOriginalArt(ACTORS, getFile, { identify });
  const status = (actor, role) => rows.filter((r) => r.actor === actor && r.role === role).map((r) => `${r.status} ${r.where}`);
  for (const id of ['CRATE', 'MONEYCRATE', 'HEALCRATE', 'WCRATE', 'SCRATE']) {
    if (!ACTORS.some((a) => a.id === id)) continue;
    assert.deepEqual(status(id, 'crate-land'), ['ok body.idle'], id);
    assert.deepEqual(status(id, 'crate-water'), ['ok second.idle'], id);
  }
  for (const a of ACTORS.filter((x) => x.kind === 'husk')) {
    assert.deepEqual(status(a.id, 'body'), ['ok body.idle'], a.id);
    assert.deepEqual(status(a.id, 'burns'), ['ok special leftovers.0'], `${a.id}: the fire`);
  }
  // The vehicles' husk rows point at the husk actors.
  assert.deepEqual(status('2TNK', 'husk'), ['ok actor 2TNK.Husk']);
  assert.deepEqual(status('HARV', 'husk'), ['ok actor HARV.EmptyHusk']);
  for (const key of ['leftovers.0', 'leftovers.1', 'leftovers.2', 'leftovers.4', 'leftovers.5', 'leftovers.6', 'leftovers.7']) {
    assert.deepEqual(status('(special)', key), [`ok special ${key}`], key);
  }
  assert.equal(rows.filter((r) => r.actor === '(terrain)' && (r.role === 'scorch' || r.role === 'crater') && r.status === 'ok').length, 12);
});

test('special slots: the audit, the atlas and the engine agree on where each special sprite is', () => {
  const lists = [NAVAL_SPECIALS, PLANE_SPECIALS, HELI_SPECIALS, ABILITY_SPECIALS, VETERANCY_SPECIALS, DECORATION_SPECIALS, EFFECT_SPECIALS, LEFTOVER_SPECIALS, INFANTRY_SPECIALS];
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
  // engine/src/render.rs SpriteIds: naval, planes, helis, abilities, veterancy, decorations, leftovers in this order.
  const render = readFileSync(fileURLToPath(new URL('../../../engine/src/render.rs', import.meta.url)), 'utf8');
  const bases = SPECIAL_MODULES.map((m) => Number(render.match(new RegExp(`${m}_base: b \\+ (\\d+)\\.0`))[1]));
  assert.deepEqual(bases, SPECIAL_MODULES.map((_, i) => SPECIALS.length + i * SPECIAL_SLOTS));
  assert.equal(Number(render.match(/muzzle_base: b \+ (\d+)\.0/)[1]), SPECIALS.length + SPECIAL_MODULES.length * SPECIAL_SLOTS);
  // The engine draws effects as long as the audit allows their original sequences.
  const fx = readFileSync(fileURLToPath(new URL('../../../engine/src/fx.rs', import.meta.url)), 'utf8');
  const constant = (name) => Number(fx.match(new RegExp(`pub const ${name}: \\w+ = (\\d+);`))[1]);
  assert.deepEqual(
    [constant('EXPLOSION_LIFE'), constant('MUZZLE_LIFE'), constant('ACTIVE_ONCE_LIFE')],
    [FX_LIMITS.explosion, FX_LIMITS.muzzle, FX_LIMITS.activeOnce],
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
  // The damage smoke names its frame: the start frames, then the loop frames.
  const smoke = out.slots.get(specialSlot('fx.0', ACTORS.length));
  assert.equal(smoke.poses[POSE.IDLE].mode, 3);
  assert.equal(out.smoke[0], 40);
  assert.equal(smoke.poses[POSE.IDLE].length, out.smoke[1] + out.smoke[2]);
  // Effects play once at the make pose and show nothing otherwise.
  const boom = out.slots.get(specialSlot('small_explosion', ACTORS.length));
  assert.equal(boom.poses[POSE.MAKE].mode, 1);
  assert.equal(boom.images[boom.poses[POSE.IDLE].frames[0]].width, 0);
  // The silo indexes its stages.
  const silo = out.slots.get(2 * t('SILO'));
  assert.equal(silo.poses[POSE.IDLE].mode, 3);
  assert.deepEqual(out.levels, [[t('SILO'), silo.poses[POSE.IDLE].length]]);
  assert.deepEqual(out.unitOverlays.sort((a, b) => a[0] - b[0]), [[t('MRJ'), -256, 0], [t('MGG'), -299, 0]].sort((a, b) => a[0] - b[0]));
  // The tree fires name their frames too: burn-s, burn-m and burn-l, start, loop and end in a row.
  assert.deepEqual(out.fires.map((f) => f[0]), [0, 1, 2]);
  for (const [size, , start, loop, end] of out.fires) {
    const fire = out.slots.get(specialSlot(['decorations.2', 'decorations.4', 'decorations.5'][size], ACTORS.length));
    assert.equal(fire.poses[POSE.IDLE].length, start + loop + end);
  }

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
      // The damage smoke: 40 ms frames, then the start and loop frame counts.
      [ORIGINAL_INFO.SMOKE, ...out.smoke],
      // The tree fires (small, medium, large): 40 ms frames, start frames; loop and end frames.
      ...out.fires.flatMap(([size, ms, start, loop, end]) => [
        [ORIGINAL_INFO.FIRE, size, ms, start],
        [ORIGINAL_INFO.FIRE_TAIL, size, loop, end],
      ]),
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

test("art audit: infantry stands, idles, deaths and Tanya's composed shooting are OpenRA's", () => {
  const { rows } = auditOriginalArt(ACTORS, getFile, { identify });
  const row = (actor, openra) => rows.find((r) => r.actor === actor && r.openra === openra);
  // Tanya's shoot-left and shoot-right are OpenRA Combine sequences of e7.shp frames.
  for (const [seq, where] of [['e7.shoot-left', 'body.attack'], ['e7.shoot-right', 'body.attack2'], ['e7.prone-shoot-right', 'second.attack2']]) {
    assert.equal(row('E7', seq)?.status, 'ok', `${seq}: ${row('E7', seq)?.note}`);
    assert.equal(row('E7', seq).where, where);
  }
  for (const [seq, where] of [['e1.stand2', 'body.stand2'], ['e1.idle2', 'body.idle2'], ['e1.prone-stand2', 'second.stand2'], ['e1.die4', 'body.die4'], ['e1.die-crushed', 'body.crushed']]) {
    assert.equal(row('E1', seq)?.status, 'ok', `${seq}: ${row('E1', seq)?.note}`);
    assert.equal(row('E1', seq).where, where);
  }
  // The spy's WithDisguisingInfantryBody, the dog's own sequences.
  assert.equal(row('SPY', 'spy.stand')?.status, 'ok');
  assert.equal(row('DOG', 'dog.eat')?.status, 'ok');
  // Every infantry sequence OpenRA draws is shown.
  const infantry = new Set(ACTORS.filter((a) => a.kind === 'infantry').map((a) => a.id));
  const left = rows.filter((r) => infantry.has(r.actor) && !['ok', 'webra-only'].includes(r.status) && r.role !== 'parachute');
  assert.deepEqual(left, []);
});
