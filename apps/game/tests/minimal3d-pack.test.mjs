// The built-in 3D minimal texture pack (tools/gen_minimal3d, apps/game/packs/*.webrapack) and the Graphics setting
// that chooses it (webra2d | webra3d | original): coverage of every actor, sheet sizes, facings, team masks, cameos,
// terrain per biome, the migration of the old 'webra' value and how the content system layers the built-in pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_LIMITS, PACK_LIMITS, readPack, pngSize, SPECIAL_ACTORS } from '../js/content/packs.js';
import { BUILTIN_PACKS, ContentSystem, GRAPHICS } from '../js/content/index.js';
import { MemoryStore } from '../js/content/store.js';
import { checkDocument, createRegistry, normalizeValues } from '../js/registry.js';
import { ORIGINAL_INFO } from '../js/content/atlas.js';
import { ORIGINAL_BOUNDS } from '../js/content/render-facts.js';
import { createSettings } from '../js/settings.js';
import { validateSettingsDocument } from '../../../packages/protocol/src/accounts.js';
import { buildPng, decodeTestPng } from './content-fixtures.mjs';
import { buildZip } from './oramap-fixtures.mjs';

const read = (rel) => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../../engine/rules.json', import.meta.url)), 'utf8'));

let packs = null;
async function builtin() {
  packs ??= await Promise.all(BUILTIN_PACKS.map(async (name) => readPack(read(`../packs/${name}`), {}, BUILTIN_LIMITS)));
  return packs;
}

// ---- The generated pack ---------------------------------------------------------------------------

test('the built-in archives are valid packs, one per biome set', async () => {
  const [main, snow, desert] = await builtin();
  assert.equal(main.manifest.name, '3D minimal');
  assert.deepEqual(main.manifest.terrain.biomes, ['temperate']);
  assert.deepEqual(snow.manifest.terrain.biomes, ['snow']);
  assert.deepEqual(desert.manifest.terrain.biomes, ['desert']);
  assert.equal(snow.manifest.sprites.length, 0);
  // A player's pack may not be this big: the limits for the built-in pack are separate.
  assert.ok(main.manifest.sprites.length > PACK_LIMITS.maxSprites / 4);
  assert.equal(new Set(['3D minimal', snow.manifest.name, desert.manifest.name]).size, 3, 'the packs have distinct names');
});

test('every actor of the rules has art: a sprite, an alias or a mine special', async () => {
  const [main] = await builtin();
  const have = new Set(main.manifest.sprites.filter((s) => s.actor).map((s) => s.actor));
  for (const s of main.manifest.sprites.filter((x) => x.special)) if (SPECIAL_ACTORS[s.special]) have.add(SPECIAL_ACTORS[s.special]);
  const missing = rules.actors.filter((a) => a.kind !== 'proxy' && !have.has(a.id.toUpperCase())).map((a) => a.id);
  assert.deepEqual(missing, [], 'actors without 3D minimal art');
  const known = new Set(rules.actors.map((a) => a.id.toUpperCase()));
  assert.deepEqual([...have].filter((id) => !known.has(id) && !Object.values(SPECIAL_ACTORS).includes(id)), [], 'art for actors the rules do not have');
});

test('every special effect of the format has art', async () => {
  const [main] = await builtin();
  const have = new Set(main.manifest.sprites.filter((s) => s.special).map((s) => s.special));
  for (const s of ['bullet', 'small_explosion', 'large_explosion', 'piff', 'rally', 'at_mine', 'ap_mine', 'tesla_bolt', 'missile', 'shell', 'chrono', 'nuke']) {
    assert.ok(have.has(s), `special ${s}`);
  }
});

test('units turn in 32 facings, soldiers in 8, and every sheet has the size its frames describe', async () => {
  const [main] = await builtin();
  const kind = new Map(rules.actors.map((a) => [a.id.toUpperCase(), a.kind]));
  const body = (id, pose = 'idle') => main.manifest.sprites.find((s) => s.actor === id && s.part === 'body' && s.pose === pose);
  for (const a of rules.actors) {
    const id = a.id.toUpperCase();
    const s = body(id);
    if (!s || s.hidden) continue;
    if (['vehicle', 'ship', 'aircraft'].includes(a.kind) && !/Husk|CRATE/i.test(id)) assert.equal(s.facings, 32, `${id} facings`);
    if (a.kind === 'infantry') assert.equal(s.facings, 8, `${id} facings`);
    const data = main.files.get(s.image);
    const { width, height } = pngSize(data);
    assert.equal(width, s.frameSize[0] * (s.frames ?? 1), `${id} sheet width`);
    assert.equal(height, s.frameSize[1] * s.facings, `${id} sheet height`);
    assert.ok(s.frameSize[0] <= 512 && s.frameSize[1] <= 512);
  }
  assert.equal(kind.get('1TNK'), 'vehicle');
});

test('footprints: a structure sprite is as wide as its footprint, plus the lean of its back', async () => {
  const [main] = await builtin();
  for (const a of rules.actors) {
    if (a.kind !== 'building' || !a.building) continue;
    const s = main.manifest.sprites.find((x) => x.actor === a.id.toUpperCase() && x.part === 'body' && x.pose === 'idle');
    if (!s || s.hidden) continue;
    const [w] = s.frameSize;
    const box = a.building.width * 24;
    // No slab any more: the front fills the footprint and the back leans east by the ground shear (0.35 px per
    // px of depth), a little more for a tree crown.
    assert.ok(w <= box + 0.35 * a.building.height * 24 + 12, `${a.id}: ${w} px wide for a footprint ${box} px wide`);
  }
});

test('placement on the grid: the front edge of a structure sits on its cells (no inset slab), its front corners on the footprint\'s sides', async () => {
  const [main] = await builtin();
  const checked = [];
  for (const id of ['FACT', 'POWR', 'APWR', 'PROC', 'TENT', 'BARR', 'WEAP', 'FIX', 'DOME', 'HPAD', 'ATEK', 'STEK', 'AFLD', 'KENN', 'PBOX', 'TSLA', 'FCOM', 'HOSP', 'OILB', 'V01']) {
    const a = rules.actors.find((x) => x.id === id);
    const b = a.building;
    const s = main.manifest.sprites.find((x) => x.actor === id && x.part === 'body' && x.pose === 'idle');
    const sheet = await decodeTestPng(main.files.get(s.image));
    const [fw, fh] = s.frameSize;
    // The engine draws the sprite's centre at the actor point plus `offset`; the actor point is the footprint
    // box centre plus center_offset (1/1024 cell).
    const [ox, oy] = s.offset ?? [0, 0];
    const co = (b.center_offset?.[1] ?? 0) * 24 / 1024;
    let bottom = -1;
    for (let y = fh - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < fw; x++) if (sheet.rgba[(y * sheet.width + x) * 4 + 3] === 255) bottom = y;
    let left = fw;
    let right = -1;
    for (let x = 0; x < fw; x++) {
      if (sheet.rgba[(bottom * sheet.width + x) * 4 + 3] === 255) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    // With a bib the apron reaches the footprint's front edge; without one the front is the bottom of the original
    // sprite (OpenRA's bounds: on the footprint's front for every structure here but the depot, whose pad is centred).
    const bib = b.footprint.some((row) => /^=+$/.test(row));
    const ob = ORIGINAL_BOUNDS[id];
    const box = ob?.decoration ?? (ob?.bounds?.length ? ob.bounds : null);
    const wantY = bib || !box ? b.height * 12 - co : (box[3] + box[1] / 2) * 24 / 1024;
    const frontY = oy - fh / 2 + bottom + 1;
    assert.ok(Math.abs(frontY - wantY) <= 1.5, `${id}: front edge at y ${frontY}, want ${wantY.toFixed(1)}`);
    const wantHalf = (box ? box[0] : b.width * 1024) * 12 / 1024;
    assert.ok(Math.abs(ox - fw / 2 + left + wantHalf) <= 1.5, `${id}: front-left corner at x ${ox - fw / 2 + left}, want ${-wantHalf}`);
    assert.ok(Math.abs(ox - fw / 2 + right + 1 - wantHalf) <= 1.5, `${id}: front-right corner at x ${ox - fw / 2 + right + 1}, want ${wantHalf}`);
    checked.push(id);
  }
  assert.equal(checked.length, 20);
});

test('team coloured parts come with a team mask, and units have them', async () => {
  const [main] = await builtin();
  const kind = new Map(rules.actors.map((a) => [a.id.toUpperCase(), a.kind]));
  // One team area per object: a structure's strip, a soldier's torso, a unit's turret (the 'second' part) or its
  // cargo bed, an aircraft's tail.
  const withMask = new Set(main.manifest.sprites.filter((s) => s.teamMask && (s.pose ?? 'idle') === 'idle').map((s) => s.actor));
  for (const id of ['1TNK', 'POWR', 'FACT', 'E1', 'HELI', 'PT', 'WEAP']) assert.ok(withMask.has(id), `${id} has a team mask`);
  for (const s of main.manifest.sprites) {
    if (!s.teamMask) continue;
    const a = pngSize(main.files.get(s.image));
    const b = pngSize(main.files.get(s.teamMask));
    assert.deepEqual(b, a, `${s.actor}: the mask has the sheet's size`);
  }
  for (const [id, k] of kind) {
    if (['vehicle', 'ship', 'aircraft'].includes(k) && !/Husk|CRATE/i.test(id)) assert.ok(withMask.has(id), `${id} (a ${k}) has team colour`);
  }
});

test('turrets and hidden layers: turreted actors have a second part, animated structures hide the old layer', async () => {
  const [main] = await builtin();
  const second = (id) => main.manifest.sprites.filter((s) => s.actor === id && s.part === 'second');
  for (const id of ['1TNK', '2TNK', '3TNK', '4TNK', 'JEEP', 'FTRK', 'PT', 'DD', 'CA', 'GUN', 'AGUN', 'SAM']) {
    const t = second(id).find((s) => !s.hidden);
    assert.ok(t, `${id} has a turret sprite`);
    assert.equal(t.facings, 32, `${id} turret facings`);
  }
  for (const id of ['DOME', 'POWR', 'APWR', 'PROC', 'BARR', 'HPAD', 'AFLD', 'ATEK', 'STEK', 'FACT', 'MSLO']) {
    assert.ok(second(id).some((s) => s.hidden), `${id} hides WebRA's animated layer`);
  }
  for (const id of ['HELI', 'MH60', 'HIND']) assert.ok(second(id).some((s) => s.pose === 'move' && s.frames > 1), `${id} has a spinning rotor`);
});

test('soldiers have the poses the engine plays, and their deaths', async () => {
  const [main] = await builtin();
  const poses = (id, part) => new Set(main.manifest.sprites.filter((s) => s.actor === id && s.part === part).map((s) => s.pose));
  for (const id of ['E1', 'E2', 'E3', 'E4', 'E6', 'E7', 'MEDI', 'MECH', 'SPY', 'THF', 'SHOK']) {
    const p = poses(id, 'body');
    for (const need of ['idle', 'move', 'attack', 'die1', 'die2', 'die3', 'die4', 'die5', 'die6', 'crushed']) assert.ok(p.has(need), `${id} ${need}`);
  }
  for (const id of ['E1', 'E2', 'E3']) assert.ok(poses(id, 'second').has('idle'), `${id} has a prone pose`);
  for (const id of ['C1', 'C5', 'C11', 'TECN']) assert.ok(poses(id, 'body').has('move') && poses(id, 'body').has('die1'), `${id} civilian poses`);
});

test('structures have idle, damaged and make poses where they should', async () => {
  const [main] = await builtin();
  const poses = (id) => new Set(main.manifest.sprites.filter((s) => s.actor === id && s.part === 'body').map((s) => s.pose));
  for (const id of ['FACT', 'POWR', 'WEAP', 'DOME', 'PBOX', 'TSLA']) {
    const p = poses(id);
    assert.ok(p.has('idle') && p.has('damaged') && p.has('make'), `${id}: ${[...p]}`);
  }
  for (const s of main.manifest.sprites.filter((x) => x.pose === 'make')) assert.ok(s.frames > 1 && s.fps > 0, `${s.actor} make animation`);
});

test('cameos: every buildable actor has a 64 x 48 picture', async () => {
  const [main] = await builtin();
  for (const a of rules.actors) {
    if (!(a.cost > 0) || a.kind === 'proxy') continue;
    const path = main.manifest.cameos[a.id.toUpperCase()];
    assert.ok(path, `${a.id} cameo`);
    assert.deepEqual(pngSize(main.files.get(path)), { width: 64, height: 48 }, `${a.id} cameo size`);
  }
});

test('terrain: each biome has clear and water rows, ore and gems', async () => {
  const sets = await builtin();
  for (const { manifest, files } of sets) {
    const t = manifest.terrain;
    assert.ok(t && t.tileSize === 24);
    for (const k of ['clear', 'rough', 'rock', 'water', 'tree', 'ford']) {
      assert.ok(t[k], `${t.biomes[0]} ${k}`);
      const { width, height } = pngSize(files.get(t[k]));
      assert.equal(height, 24);
      assert.ok(width % 24 === 0 && width / 24 >= 2 && width / 24 <= 16, `${t.biomes[0]} ${k} variants`);
    }
    assert.ok(t.ore && t.gems, `${t.biomes[0]} ore and gems`);
    const ore = pngSize(files.get(t.ore));
    assert.ok(ore.width / 24 === 12 && ore.height / 24 >= 2 && ore.height / 24 <= 4, `${t.biomes[0]} ore grid`);
  }
});

test('the pack is drawn in the classic camera with the ground shear, and says so: the game shears turret and rotor offsets alike', async () => {
  const [main] = await builtin();
  assert.equal(main.manifest.perspective, 'classic');
  const core = readFileSync(fileURLToPath(new URL('../../../tools/gen_minimal3d/core.py', import.meta.url)), 'utf8');
  const shear = Number(core.match(/^GSHEAR = (-?[\d.]+)$/m)[1]);
  assert.equal(main.manifest.groundShear, shear, 'the manifest carries the generator\'s GSHEAR');
});

test('3D minimal in a game: turrets, rotors and muzzles of its units get the classic placement and the shear (CA, TRAN, FTRK)', async () => {
  const [main] = await builtin();
  const { content, settings } = system(async (name) => read(`../packs/${name}`));
  settings.set('graphics', 'webra3d');
  await content.reload();
  const ids = ['1TNK', 'FTRK', 'CA', 'TRAN', 'E1'];
  const actors = ids.map((id) => rules.actors.find((a) => a.id === id));
  const art = content.art(actors);
  const slots = new Set(art.original.slots);
  for (const [t, id] of ids.entries()) assert.ok(slots.has(2 * t), `${id} body is pre-rendered`);
  for (const id of ['1TNK', 'FTRK', 'CA', 'TRAN']) assert.ok(slots.has(2 * ids.indexOf(id) + 1), `${id} turret or rotor is pre-rendered`);
  const shears = new Map();
  for (let k = 0; k < art.original.info.length; k += 4) {
    if (art.original.info[k] === ORIGINAL_INFO.SHEAR) shears.set(ids[art.original.info[k + 1]], art.original.info[k + 2]);
  }
  assert.deepEqual([...shears.keys()].sort(), [...ids].sort(), 'every actor of the pack is sheared');
  for (const q of shears.values()) assert.equal(q, Math.round(main.manifest.groundShear * 1024));
});

test('the generated art keeps the pack rules: no dashes, WebRA authorship, licence', async () => {
  const [main] = await builtin();
  assert.equal(main.manifest.author, 'WebRA');
  assert.ok(main.manifest.license.length > 0);
  assert.ok(!/[\u2013\u2014]/.test(main.manifest.description));
});

// ---- The Graphics setting --------------------------------------------------------------------------

test('the old graphics value "webra" becomes "webra2d"; the three choices are kept', () => {
  assert.equal(normalizeValues({ game: { graphics: 'webra' } }).values.game.graphics, GRAPHICS.MINIMAL_2D);
  for (const v of ['webra2d', 'webra3d', 'original']) assert.equal(normalizeValues({ game: { graphics: v } }).values.game.graphics, v);
  assert.equal(normalizeValues({ game: { graphics: 'nonsense' } }).values.game.graphics, 'webra2d');
  assert.equal(normalizeValues({}).values.game.graphics, 'webra2d', 'the default is 2D minimal');
});

test('a settings document with the old value is still valid (admin editor, account upload) and reads as 2D minimal', () => {
  assert.equal(checkDocument({ game: { graphics: 'webra' } }).ok, true);
  assert.equal(checkDocument({ game: { graphics: 'webra' } }).values.game.graphics, 'webra2d');
  assert.equal(checkDocument({ game: { graphics: 'cartoon' } }).ok, false);
  const registry = createRegistry({ storage: null });
  registry.set('game', 'graphics', 'webra3d');
  registry.set('game', 'graphics', 'webra');
  assert.equal(registry.get('game', 'graphics'), 'webra2d', 'a value set by an older tab or device is mapped');
});

test('accounts accept the three choices and still the stored old value', () => {
  for (const v of ['webra2d', 'webra3d', 'original', 'webra']) assert.deepEqual(validateSettingsDocument({ game: { graphics: v } }), { game: { graphics: v } });
  assert.throws(() => validateSettingsDocument({ game: { graphics: 'cartoon' } }), /Must be one of webra2d/);
});

test('the settings screen labels the choices 2D minimal, 3D minimal and Red Alert original', () => {
  const source = readFileSync(fileURLToPath(new URL('../js/content/panel.js', import.meta.url)), 'utf8');
  for (const label of ['2D minimal', '3D minimal', 'Red Alert original']) assert.ok(source.includes(`label: '${label}'`), label);
});

// ---- The content system -----------------------------------------------------------------------------

/** A tiny stand-in for a built-in archive: one sprite of one actor, a cameo, one terrain row. */
function tinyPack(name, extra = {}) {
  const px = buildPng(2, 2, new Uint8ClampedArray(16).fill(200));
  const row = buildPng(48, 24, new Uint8ClampedArray(48 * 24 * 4).fill(120));
  const manifest = {
    format: 'webra-pack', formatVersion: 1, name, author: 'WebRA', version: '1.0.0', license: 'GPL-3.0-or-later',
    sprites: [{ actor: '1TNK', image: 'a.png', frameSize: [2, 2] }], cameos: { '1TNK': 'a.png' },
    terrain: { biomes: ['temperate'], tileSize: 24, clear: 'row.png', water: 'row.png' }, ...extra,
  };
  return buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, { name: 'a.png', data: px }, { name: 'row.png', data: row }]);
}

function system(reader) {
  const registry = createRegistry({ storage: null });
  const settings = createSettings(registry);
  const content = new ContentSystem({ settings, registry, open: async () => new MemoryStore(), decodeImage: decodeTestPng, known: {}, builtin: reader });
  return { content, settings };
}

test('3D minimal loads the built-in pack only when it is chosen, below the packs the player installed', async () => {
  const asked = [];
  const { content, settings } = system(async (name) => {
    asked.push(name);
    return name === BUILTIN_PACKS[0] ? tinyPack('3D minimal') : tinyPack(`3D minimal (${name})`, { sprites: undefined, cameos: undefined });
  });
  await content.load();
  assert.deepEqual(asked, [], 'nothing is fetched while 2D minimal is chosen');
  assert.equal(content.enabledPacks().length, 0);
  settings.set('graphics', 'webra3d');
  await content.loaded;
  await content.reload();
  assert.deepEqual(asked, BUILTIN_PACKS, 'the archives are read once 3D minimal is chosen');
  assert.equal(content.graphics, 'webra3d');
  const names = content.enabledPacks().map((p) => p.manifest.name);
  assert.equal(names[0], '3D minimal');
  const art = content.art([{ id: '1TNK', kind: 'vehicle' }]);
  assert.ok(art.report.packs.includes('3D minimal'));
  assert.ok(content.cameos(), 'the pack brings cameos');
  // Back to 2D minimal: the pack stays loaded but is not in force.
  settings.set('graphics', 'webra2d');
  assert.equal(content.enabledPacks().length, 0);
  assert.equal(content.originalActive, false);
});

test('a built-in pack that cannot be read leaves the flat art and does not break the game', async () => {
  const { content, settings } = system(async () => {
    throw new Error('offline');
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    settings.set('graphics', 'webra3d');
    await content.reload();
  } finally {
    console.warn = warn;
  }
  assert.equal(content.enabledPacks().length, 0);
  assert.equal(content.loadError, null);
  assert.match(content.builtinError, /3D minimal could not be loaded \(minimal3d\.webrapack: offline/);
});

test('a built-in archive that failed (offline, a server error) is tried again on the next choice or panel open, only what is missing', async () => {
  let down = new Set([BUILTIN_PACKS[0], BUILTIN_PACKS[2]]);
  const asked = [];
  const { content, settings } = system(async (name) => {
    asked.push(name);
    if (down.has(name)) throw new Error('503');
    return name === BUILTIN_PACKS[0] ? tinyPack('3D minimal') : tinyPack(`3D minimal (${name})`, { sprites: undefined, cameos: undefined });
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    settings.set('graphics', 'webra3d');
    await content.loaded;
    await content.reload();
    assert.equal(content.builtinLoaded, false);
    assert.match(content.builtinError, /minimal3d\.webrapack: 503; minimal3d-desert\.webrapack: 503/);
    assert.deepEqual(content.enabledPacks().map((p) => p.manifest.name), ['3D minimal (minimal3d-snow.webrapack)'], 'what did load is used');
    // Still down: the panel opening tries again and keeps the reason.
    asked.length = 0;
    await content.retryBuiltin();
    assert.deepEqual(asked, [BUILTIN_PACKS[0], BUILTIN_PACKS[2]], 'only the missing archives');
    assert.ok(content.builtinError);
    // Back online: choosing 3D minimal again reads the rest, in order.
    down = new Set();
    settings.set('graphics', 'webra2d');
    assert.equal(content.retryBuiltin(), null, 'nothing to retry while 2D minimal is chosen');
    settings.set('graphics', 'webra3d');
    await content.loaded;
    assert.equal(content.builtinLoaded, true);
    assert.equal(content.builtinError, null);
    assert.deepEqual(content.enabledPacks().map((p) => p.archive), BUILTIN_PACKS);
    asked.length = 0;
    assert.equal(content.retryBuiltin(), null, 'all in: nothing more is fetched');
    assert.deepEqual(asked, []);
  } finally {
    console.warn = warn;
  }
});

test('a player pack comes before the built-in pack', async () => {
  const { content, settings } = system(async (name) => tinyPack(name === BUILTIN_PACKS[0] ? '3D minimal' : `other ${name}`));
  settings.set('graphics', 'webra3d');
  await content.reload();
  content.packs = [{ record: { id: 'mine|me', files: {} }, manifest: { name: 'Mine', sprites: [], cameos: {}, terrain: null, sounds: {} }, images: new Map(), enabled: true, problems: [] }];
  assert.equal(content.enabledPacks()[0].manifest.name, 'Mine');
  assert.equal(content.enabledPacks().at(-1).builtin, true);
});
