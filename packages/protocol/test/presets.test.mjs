// Game modes (src/presets.js): the built-in bundles, the saved-mode
// validator and the settings document check that uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_MODES,
  DEFAULT_OPTIONS,
  PRESET_KEYS,
  PRESET_NAME_MAX,
  PRESETS_MAX,
  presetOptions,
  validateLobbyOptions,
  validatePresetOptions,
  validateSavedPresets,
  validateSettingsDocument,
  LOBBY_OPTION_KEYS,
} from '../src/index.js';

const bundle = (over = {}) => ({ ...presetOptions(DEFAULT_OPTIONS), ...over });

test('a mode sets every lobby option but the seed and the map size', () => {
  assert.deepEqual([...PRESET_KEYS].sort(), LOBBY_OPTION_KEYS.filter((k) => k !== 'seed' && k !== 'mapSize').sort());
});

test('built-in modes: unique ids and names, complete bundles the server accepts', () => {
  assert.equal(new Set(BUILTIN_MODES.map((m) => m.id)).size, BUILTIN_MODES.length);
  assert.equal(new Set(BUILTIN_MODES.map((m) => m.name.toLowerCase())).size, BUILTIN_MODES.length);
  for (const m of BUILTIN_MODES) {
    assert.deepEqual(Object.keys(m.options), [...PRESET_KEYS], m.id);
    assert.deepEqual(validatePresetOptions(m.options), m.options, m.id);
    assert.doesNotThrow(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, ...m.options }), m.id);
    assert.ok(m.description.length > 20, m.id);
  }
  // No two modes are the same bundle (the lobby could not tell them apart).
  const bundles = BUILTIN_MODES.map((m) => JSON.stringify(m.options));
  assert.equal(new Set(bundles).size, bundles.length);
});

test('built-in modes hold what their names promise', () => {
  const by = Object.fromEntries(BUILTIN_MODES.map((m) => [m.id, m.options]));
  assert.deepEqual([by.classic.biome, by.classic.weather, by.classic.gameSpeed], ['temperate', 'off', 'normal']);
  assert.deepEqual([by.weatherwar.weather, by.weatherwar.biome], ['full', 'random']);
  assert.deepEqual([by.winter.biome, by.winter.weather], ['snow', 'full']);
  assert.deepEqual([by.desertstorm.biome, by.desertstorm.weather], ['desert', 'full']);
  assert.equal(by.islands.mapStyle, 'islands');
  assert.deepEqual([by.rush.startingCash, by.rush.techLevel, by.rush.gameSpeed], [2500, 'high', 'fast'], 'rush: low cash, no superweapons, fast');
  assert.deepEqual([by.turtle.startingCash, by.turtle.gameSpeed], [20000, 'slower']);
  assert.equal(by.sandbox.cheats, true);
  assert.deepEqual(
    BUILTIN_MODES.filter((m) => m.skirmishOnly).map((m) => m.id),
    ['sandbox'],
    'only Sandbox stays out of online lobbies',
  );
  for (const m of BUILTIN_MODES) if (m.id !== 'sandbox') assert.equal(m.options.cheats, false, m.id);
});

test('mode bundles are strict: every key, known values, nothing else', () => {
  assert.throws(() => validatePresetOptions({ ...bundle(), seed: 5 }), /unknown field/);
  const { fog: _fog, ...missing } = bundle();
  assert.throws(() => validatePresetOptions(missing), /fog/);
  assert.throws(() => validatePresetOptions(bundle({ biome: 'moon' })), /biome/);
  assert.throws(() => validatePresetOptions(bundle({ startingCash: 1234 })), /startingCash/);
  assert.throws(() => validatePresetOptions(bundle({ cheats: 'yes' })), /cheats/);
  assert.throws(() => validatePresetOptions(null), /object/);
});

test('saved modes: names, limits, duplicates and built-in names', () => {
  const ok = [{ name: 'Tank rush', options: bundle({ startingUnits: 'heavy' }) }];
  assert.deepEqual(validateSavedPresets(ok), ok);
  assert.deepEqual(validateSavedPresets([]), []);
  const many = Array.from({ length: PRESETS_MAX + 1 }, (_, i) => ({ name: `Mode ${i}`, options: bundle() }));
  assert.throws(() => validateSavedPresets(many), /at most 16/);
  assert.doesNotThrow(() => validateSavedPresets(many.slice(0, PRESETS_MAX)));
  const fail = (list, path) => {
    try {
      validateSavedPresets(list);
    } catch (err) {
      assert.equal(err.path, path, err.message);
      return;
    }
    assert.fail(`accepted ${JSON.stringify(list).slice(0, 80)}`);
  };
  fail([{ name: 'A', options: bundle() }, { name: 'a', options: bundle() }], '[1].name');
  fail([{ name: 'classic', options: bundle() }], '[0].name');
  fail([{ name: '', options: bundle() }], '[0].name');
  fail([{ name: 'x'.repeat(PRESET_NAME_MAX + 1), options: bundle() }], '[0].name');
  fail([{ name: ' padded ', options: bundle() }], '[0].name');
  fail([{ name: 'bad‮chars', options: bundle() }], '[0].name');
  fail([{ name: 'Fine', options: bundle({ weather: 'acid' }) }], '[0].options.weather');
  fail([{ name: 'Fine', options: bundle(), extra: 1 }], '[0]');
  fail(['nope'], '[0]');
  assert.throws(() => validateSavedPresets({}), /list/);
  assert.doesNotThrow(() => validateSavedPresets([{ name: 'x'.repeat(PRESET_NAME_MAX), options: bundle() }]));
});

test('the settings document takes saved modes and names the bad field', () => {
  const doc = { schema: 1, lobby: { presets: [{ name: 'Night ops', options: bundle({ fog: true, explored: false }) }] } };
  assert.deepEqual(validateSettingsDocument(doc), doc);
  const field = (presets) => {
    try {
      validateSettingsDocument({ lobby: { presets } });
    } catch (err) {
      return err.field;
    }
    return null;
  };
  assert.equal(field([{ name: 'A', options: bundle({ gameSpeed: 'warp' }) }]), 'settings.lobby.presets[0].options.gameSpeed');
  assert.equal(field([{ name: 'A', options: bundle() }, { name: 'A', options: bundle() }]), 'settings.lobby.presets[1].name');
  assert.equal(field('all of them'), 'settings.lobby.presets');
  assert.equal(field(Array.from({ length: 17 }, (_, i) => ({ name: `M${i}`, options: bundle() }))), 'settings.lobby.presets');
  // Sixteen modes with the longest names fit in the document with room to spare.
  const full = Array.from({ length: PRESETS_MAX }, (_, i) => ({ name: `${i}`.padEnd(PRESET_NAME_MAX, 'm'), options: bundle() }));
  assert.ok(JSON.stringify(full).length < 6 * 1024);
  assert.doesNotThrow(() => validateSettingsDocument({ lobby: { presets: full } }));
});
