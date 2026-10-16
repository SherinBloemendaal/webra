// The settings registry (js/registry.js): schema, defaults, normalization,
// strict checks for editors, migration of the old per-module keys, the
// account document shape (docs/accounts-api.md 5.8) and change origins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS,
  REGISTRY_KEY,
  LEGACY_KEYS,
  SCHEMA_VERSION,
  MAX_DOCUMENT_BYTES,
  createRegistry,
  checkDocument,
  checkValue,
  normalizeValue,
  normalizeValues,
  defaultValues,
  diffValues,
  migrateLegacy,
  specOf,
  toDocument,
  checkJson,
} from '../js/registry.js';
import { SCHEMA as SETTINGS_SCHEMA, KEYS as SETTINGS_KEYS } from '../js/settings.js';
import { DEFAULT_PREFS } from '../js/audio/prefs.js';
import { VIEWS } from '../js/debug.js';
import { memoryStorage } from './dom-fixtures.mjs';
import { mergeSettings } from '../js/account/sync.js';

const throwingStorage = () => ({
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
});

test('registry: every setting has a type, a label and a valid default', () => {
  for (const [group, g] of Object.entries(GROUPS)) {
    assert.ok(g.label && g.description, `${group} has a label and description`);
    for (const [key, spec] of Object.entries(g.settings)) {
      assert.ok(spec.label, `${group}.${key} has a label`);
      if (spec.default === null) assert.ok(spec.nullable, `${group}.${key} null default must be nullable`);
      else assert.equal(checkValue(spec, spec.default), null, `${group}.${key} default is valid`);
    }
  }
  // The groups and keys are the account's settings document sections.
  assert.deepEqual(Object.keys(GROUPS), ['game', 'audio', 'content', 'debug', 'lobby', 'releaseNotes', 'privacy', 'net', 'social', 'guide', 'extra']);
  assert.deepEqual(Object.keys(GROUPS.game.settings).sort(), [
    'attackMoveTipSeen',
    'buildRightClick',
    'edgeScrollSpeed',
    'gameEventNotifications',
    'gameScale',
    'graphics',
    'healthBars',
    'hideReplayChat',
    'hotkeys',
    'keyScrollSpeed',
    'lowQuality',
    'mouseCapture',
    'mouseCaptureEscMenu',
    'mouseCaptureNotice',
    'mouseCaptureRaw',
    'mouseCaptureSpeed',
    'pauseWhenHidden',
    'pixelRatioCap',
    'playerStanceColors',
    'reduceMotion',
    'showUnitPaths',
    'targetLines',
    'uiFeedbackNotifications',
    'uiScale',
    'zoomFactor',
  ]);
  assert.deepEqual(Object.keys(GROUPS.audio.settings), ['enabled', 'master', 'effects', 'voices', 'music', 'speech', 'original', 'cashTicks', 'clickSounds', 'menuMusic', 'musicOn', 'musicShuffle', 'musicRepeat']);
  assert.deepEqual(Object.keys(GROUPS.debug.settings), [...VIEWS.map((v) => v.key), 'cpuInstances', 'perfCaptureSeconds', 'perfCaptureStart']);
  assert.deepEqual(Object.keys(GROUPS.lobby.settings), ['name', 'faction', 'color', 'lastOptions', 'presets']);
  // settings.js and audio/prefs.js are views on the registry.
  for (const [name, [group, key]] of Object.entries(SETTINGS_KEYS)) assert.equal(SETTINGS_SCHEMA[name], specOf(group, key));
  assert.deepEqual(DEFAULT_PREFS, defaultValues().audio);
});

test('registry: lenient normalization clamps, trims and falls back; strict checks report', () => {
  const speed = specOf('game', 'edgeScrollSpeed');
  assert.equal(normalizeValue(speed, 9), 3);
  assert.equal(normalizeValue(speed, -1), 0);
  assert.equal(normalizeValue(speed, '2'), 1, 'text is not a number');
  assert.match(checkValue(speed, 9), /between 0 and 3/);
  assert.equal(normalizeValue(specOf('lobby', 'color'), 2.6), 3, 'integers round');
  assert.equal(normalizeValue(specOf('game', 'healthBars'), 'sometimes'), 'damaged');
  // Lobby names follow the protocol's text rules (spaces collapsed, no control characters).
  const name = specOf('lobby', 'name');
  assert.equal(normalizeValue(name, '  Tanya   Adams '), 'Tanya Adams');
  assert.equal(normalizeValue(name, 'x'.repeat(40)), 'Commander', 'too long: default');
  assert.equal(normalizeValue(name, 'bad\u0007'), 'Commander');
  assert.match(checkValue(name, ''), /empty/);
  assert.match(checkValue(name, ' padded '), /extra spaces/);
  // Release versions normalize; garbage is the default (null).
  const seen = specOf('releaseNotes', 'lastSeenVersion');
  assert.equal(normalizeValue(seen, 'v0.6.0+abc'), '0.6.0');
  assert.equal(normalizeValue(seen, '<script>'), null);
  assert.match(checkValue(seen, '0.6'), /version/);
  // Hotkeys: action names and combos per the contract.
  const hk = specOf('game', 'hotkeys');
  assert.deepEqual(normalizeValue(hk, { stop: ['S', 'Ctrl+Shift+F1', 'has space', ''], 'bad name!': ['A'], attackMove: 'A' }), { stop: ['S', 'Ctrl+Shift+F1'] });
  assert.equal(checkValue(hk, { stop: ['A', 'B', 'C', 'D', 'E'] }), 'stop must be a list of at most 4 keys');
  // Packs: { id, enabled }, distinct ids.
  const packs = specOf('content', 'packs');
  assert.deepEqual(normalizeValue(packs, [{ id: 'a|b', enabled: false }, { id: 'a|b', enabled: true }, { id: '' }, 'x', { id: 'c|d' }]), [
    { id: 'a|b', enabled: false },
    { id: 'c|d', enabled: true },
  ]);
  assert.match(checkValue(packs, [{ id: 'a', enabled: true }, { id: 'a', enabled: true }]), /twice/);
  assert.match(checkValue(packs, [{ id: 'a', enabled: true, extra: 1 }]), /\{ id, enabled \}/);
  // Free JSON: depth, keys, text length, list length, finite numbers.
  assert.equal(checkJson({ a: { b: { c: 1 } } }), null);
  assert.match(checkJson({ a: { b: { c: { d: { e: 1 } } } } }), /levels deep/);
  assert.match(checkJson({ 'bad key': 1 }), /invalid key/);
  assert.match(checkJson({ a: 'x'.repeat(501) }), /500/);
  assert.match(checkJson({ a: Array(65).fill(0) }), /64/);
  assert.match(checkValue(specOf('lobby', 'lastOptions'), { big: Array(60).fill('x'.repeat(100)) }), /4096 bytes/);
});

test('registry: scale settings take "auto" or a factor; music settings', () => {
  for (const key of ['uiScale', 'gameScale']) {
    const spec = specOf('game', key);
    assert.equal(spec.type, 'scale');
    assert.equal(spec.default, 'auto');
    assert.equal(normalizeValue(spec, 'auto'), 'auto');
    assert.equal(normalizeValue(spec, 1.25), 1.25);
    assert.equal(normalizeValue(spec, 99), spec.max, 'clamped');
    assert.equal(normalizeValue(spec, 0), spec.min, 'clamped');
    assert.equal(normalizeValue(spec, 'Auto'), 'auto', 'not a number: the default');
    assert.equal(normalizeValue(spec, '1.5'), 'auto');
    assert.equal(normalizeValue(spec, null), 'auto');
    assert.equal(normalizeValue(spec, NaN), 'auto');
    assert.equal(checkValue(spec, 'auto'), null);
    assert.equal(checkValue(spec, spec.min), null);
    assert.match(checkValue(spec, spec.max + 0.5), /"auto" or between/);
    assert.match(checkValue(spec, 'big'), /"auto" or a number/);
  }
  assert.deepEqual([specOf('game', 'uiScale').min, specOf('game', 'uiScale').max], [0.5, 2]);
  assert.deepEqual([specOf('game', 'gameScale').min, specOf('game', 'gameScale').max], [0.5, 3]);
  const r = createRegistry({ storage: memoryStorage() });
  assert.equal(r.set('game', 'uiScale', 0.85), 0.85);
  assert.equal(r.set('game', 'gameScale', 'auto'), 'auto');
  assert.equal(r.set('audio', 'musicRepeat', 'one'), 'one');
  assert.equal(r.set('audio', 'musicRepeat', 'twice'), 'all', 'unknown repeat mode: the default');
  assert.deepEqual(r.document().audio, { ...defaultValues().audio, musicRepeat: 'all' });
  assert.equal(r.document().game.uiScale, 0.85);
});

test('registry: the document is the account settings document; nulls are left out', () => {
  const r = createRegistry({ storage: null });
  const doc = r.document();
  assert.equal(doc.schema, SCHEMA_VERSION);
  assert.equal('lastSeenVersion' in doc.releaseNotes, false, 'null means not set');
  assert.deepEqual(checkDocument(doc).errors, []);
  r.set('releaseNotes', 'lastSeenVersion', '0.6.0');
  assert.equal(r.document().releaseNotes.lastSeenVersion, '0.6.0');
  assert.ok(JSON.stringify(r.document()).length < MAX_DOCUMENT_BYTES);
});

test('registry: checkDocument reports every problem with its path, and the normalized values', () => {
  const r = checkDocument({
    schema: 2,
    game: { edgeScrollSpeed: 7, hotkeys: { stop: 'S' }, nope: 1 },
    audio: 'loud',
    lobby: { name: '', faction: 'atlantis' },
    extra: { futureFeature: { on: true }, 'bad key': 1 },
    unknown: {},
  });
  assert.equal(r.ok, false);
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['audio', 'extra.bad key', 'game.edgeScrollSpeed', 'game.hotkeys', 'game.nope', 'lobby.faction', 'lobby.name', 'schema', 'unknown']);
  assert.equal(r.values.game.edgeScrollSpeed, 3, 'normalized result clamps');
  assert.equal(checkDocument({}).ok, true, 'every section is optional');
  assert.equal(checkDocument([]).ok, false);
  assert.equal(checkDocument({ extra: { blob: 'x'.repeat(400), b2: 'y'.repeat(400), more: Array(20).fill('z'.repeat(400)) } }).ok, false, 'extra is at most 8 KiB');
});

test('registry: values persist under one key, survive a reload, and objects are copies', () => {
  const storage = memoryStorage();
  const r = createRegistry({ storage });
  assert.equal(r.set('audio', 'master', 0.3), 0.3);
  assert.equal(r.set('audio', 'master', 5), 1, 'clamped');
  r.patch('game', { showUnitPaths: true, healthBars: 'all' });
  assert.equal(JSON.parse(storage.map.get(REGISTRY_KEY)).game.healthBars, 'all');
  const again = createRegistry({ storage });
  assert.equal(again.get('audio', 'master'), 1);
  assert.equal(again.get('game', 'showUnitPaths'), true);
  const hk = again.get('game', 'hotkeys');
  hk.stop = ['X'];
  assert.deepEqual(again.get('game', 'hotkeys'), {});
  assert.throws(() => again.get('game', 'nope'), /Unknown setting/);
  assert.throws(() => again.set('nope', 'x', 1), /Unknown setting/);
  assert.throws(() => again.group('nope'), /Unknown settings group/);
  assert.equal(again.persistent, true);
});

test('registry: blocked or corrupt storage runs on defaults and keeps changes for the page', () => {
  const blocked = createRegistry({ storage: throwingStorage() });
  assert.equal(blocked.get('audio', 'master'), 0.8);
  assert.equal(blocked.set('audio', 'master', 0.2), 0.2);
  assert.equal(blocked.get('audio', 'master'), 0.2);
  assert.equal(blocked.persistent, false);
  const corrupt = createRegistry({ storage: memoryStorage({ [REGISTRY_KEY]: '{not json' }) });
  assert.deepEqual(corrupt.values(), defaultValues());
  const memory = createRegistry({ storage: null });
  assert.equal(memory.persistent, false);
});

test('registry: every old key migrates once, and the old keys are removed after a safe write', () => {
  const legacy = {
    'webra.settings': JSON.stringify({ edgeScrollSpeed: 2, keyScrollSpeed: 0.5, showUnitPaths: true, pixelRatioCap: 1, lowQuality: true, healthBars: 'damaged', graphics: 'original', hotkeys: { stop: ['Z'] } }),
    'webra.audio.v1': JSON.stringify({ enabled: false, master: 0.4, effects: 0.3, voices: 0.2, music: 0.1, speech: false, original: false }),
    'webra.debug.v1': JSON.stringify({ stats: true, cpuInstances: true }),
    'webra.lobby.v2': JSON.stringify({ seed: 5, mapSize: 'large', players: [{ type: 'human', name: 'Boris', faction: 'russia', color: 2, team: 0 }, { type: 'ai', name: 'AI', faction: 'random', color: 1 }] }),
    'webra.lobby.v1': JSON.stringify({ seed: 1 }),
    'webra.online.v1': JSON.stringify({ name: 'Tanya' }),
    'webra.releaseNotes.seen': '0.5.0',
    'webra.content.prompt.v1': 'no',
    'webra.editor.prefs': JSON.stringify({ material: 2, size: 5, ore: 4, gems: 2, symmetry: 'quad', grid: false }),
    'webra.editor.author': 'Mapper',
    'webra.lobby.map.v1': JSON.stringify({ json: '{}' }),
  };
  const storage = memoryStorage(legacy);
  const r = createRegistry({ storage });
  assert.deepEqual(r.migrated.sort(), [...LEGACY_KEYS].sort());
  const v = r.values();
  // Settings newer than every old key get their default too; the rest of the group is compared below.
  assert.deepEqual([v.game.zoomFactor, v.game.mouseCaptureRaw, v.game.hideReplayChat, v.game.uiFeedbackNotifications, v.game.gameEventNotifications], [1, false, false, true, true]);
  for (const key of ['zoomFactor', 'mouseCaptureRaw', 'hideReplayChat', 'uiFeedbackNotifications', 'gameEventNotifications']) delete v.game[key];

  assert.deepEqual(
    v.game,
    { edgeScrollSpeed: 2, keyScrollSpeed: 0.5, showUnitPaths: true, targetLines: 'automatic', pixelRatioCap: 1, lowQuality: true, reduceMotion: 'auto', uiScale: 'auto', gameScale: 'auto', healthBars: 'damaged', playerStanceColors: false, graphics: 'original', hotkeys: { stop: ['Z'] }, mouseCapture: 'fullscreen', mouseCaptureSpeed: 1, mouseCaptureEscMenu: true, mouseCaptureNotice: 'always', pauseWhenHidden: false, attackMoveTipSeen: false, buildRightClick: 'openra' },
    'settings the old key did not have get their default',
  );
  assert.deepEqual(v.audio, { enabled: false, master: 0.4, effects: 0.3, voices: 0.2, music: 0.1, speech: false, original: false, cashTicks: true, clickSounds: true, menuMusic: true, musicOn: true, musicShuffle: true, musicRepeat: 'all' });
  assert.equal(v.debug.stats, true);
  assert.equal(v.debug.cpuInstances, true);
  assert.equal(v.lobby.lastOptions.seed, 5, 'the newest lobby key wins');
  assert.equal(v.lobby.name, 'Tanya', 'the online name wins over the skirmish slot');
  assert.equal(v.lobby.faction, 'russia');
  assert.equal(v.lobby.color, 2);
  assert.equal(v.releaseNotes.lastSeenVersion, '0.5.0');
  assert.equal(v.extra.contentNoticeDismissed, true);
  assert.deepEqual(
    { a: v.extra.editorAuthor, m: v.extra.editorMaterial, s: v.extra.editorSize, o: v.extra.editorOre, g: v.extra.editorGems, y: v.extra.editorSymmetry, grid: v.extra.editorGrid },
    { a: 'Mapper', m: 2, s: 5, o: 4, g: 2, y: 'quad', grid: false },
  );
  for (const k of LEGACY_KEYS) assert.equal(storage.map.has(k), false, `${k} removed`);
  assert.equal(storage.map.has('webra.lobby.map.v1'), true, 'device data stays');
  assert.equal(checkDocument(r.document()).ok, true, 'the migrated document is valid for the account');
  // A second load reads the registry key; nothing to migrate.
  assert.deepEqual(createRegistry({ storage }).migrated, []);
  // When the registry key cannot be written, the old keys stay for the next try.
  const failing = memoryStorage({ 'webra.audio.v1': JSON.stringify({ master: 0.1 }) });
  failing.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const r2 = createRegistry({ storage: failing });
  assert.equal(r2.get('audio', 'master'), 0.1);
  assert.equal(failing.map.has('webra.audio.v1'), true);
  // migrateLegacy alone: garbage is ignored.
  assert.deepEqual(migrateLegacy(memoryStorage({ 'webra.settings': 'nope', 'webra.audio.v1': '[1]' })).raw, {});
});

test('registry: changes carry their origin; group subscriptions; unsubscribe; no event without a change', () => {
  const r = createRegistry({ storage: null });
  const all = [];
  const audio = [];
  const off = r.subscribe((changes, origin) => all.push([changes.map((c) => `${c.group}.${c.key}`), origin]));
  r.subscribe('audio', (values, changes, origin) => audio.push([values.master, changes.length, origin]));
  r.set('audio', 'master', 0.5);
  r.set('audio', 'master', 0.5);
  r.set('game', 'lowQuality', true, { origin: 'remote' });
  const changes = r.applyDocument({ schema: 1, audio: { master: 0.6, music: 0.2 }, game: { nope: 1 }, unknown: { a: 1 } });
  assert.equal(changes.length, 2);
  off();
  r.set('audio', 'voices', 0.1);
  assert.deepEqual(all, [
    [['audio.master'], 'local'],
    [['game.lowQuality'], 'remote'],
    [['audio.master', 'audio.music'], 'remote'],
  ]);
  assert.deepEqual(audio, [
    [0.5, 1, 'local'],
    [0.6, 2, 'remote'],
    [0.6, 1, 'local'],
  ]);
});

test('registry: open keys under extra survive (other builds); invalid ones and unknown groups do not', () => {
  const storage = memoryStorage();
  const r = createRegistry({ storage });
  r.applyDocument({ extra: { futureThing: { on: true }, 'bad key': 1, deep: { a: { b: { c: { d: 1 } } } } }, mystery: { x: 1 } });
  const doc = r.document();
  assert.deepEqual(doc.extra.futureThing, { on: true });
  assert.equal('bad key' in doc.extra, false);
  assert.equal('deep' in doc.extra, false);
  assert.equal('mystery' in doc, false);
  assert.deepEqual(createRegistry({ storage }).document().extra.futureThing, { on: true }, 'kept across a reload');
  assert.equal(checkDocument(doc).ok, true);
});

test('registry: another tab\'s change arrives through the storage event', () => {
  const storage = memoryStorage();
  const listeners = [];
  const win = { addEventListener: (type, fn) => type === 'storage' && listeners.push(fn) };
  const a = createRegistry({ storage, window: win });
  const seen = [];
  a.subscribe((changes, origin) => seen.push([changes[0].key, origin]));
  const b = createRegistry({ storage });
  b.set('audio', 'music', 0.1);
  for (const fn of listeners) fn({ key: REGISTRY_KEY, newValue: storage.getItem(REGISTRY_KEY) });
  assert.equal(a.get('audio', 'music'), 0.1);
  assert.deepEqual(seen, [['music', 'storage']]);
  for (const fn of listeners) fn({ key: REGISTRY_KEY, newValue: '{broken' });
  for (const fn of listeners) fn({ key: 'other', newValue: '{}' });
  assert.equal(a.get('audio', 'music'), 0.1);
});

test('registry: diffValues lists changed settings; toDocument keeps groups in order', () => {
  const a = defaultValues();
  const b = normalizeValues({ audio: { master: 0.1 }, game: { hotkeys: { stop: ['Q'] } } }).values;
  assert.deepEqual(
    diffValues(a, b).map((d) => `${d.group}.${d.key}`),
    ['game.hotkeys', 'audio.master'],
  );
  assert.deepEqual(Object.keys(toDocument(a)), ['schema', ...Object.keys(GROUPS)]);
});

test('registry: the protocol package (the server\'s validator) accepts its documents', async () => {
  const protocol = await import('../protocol/accounts.js');
  assert.equal(SCHEMA_VERSION, protocol.SETTINGS_SCHEMA_VERSION);
  assert.equal(MAX_DOCUMENT_BYTES, protocol.SETTINGS_MAX_BYTES);
  assert.equal(GROUPS.extra.maxBytes, protocol.SETTINGS_EXTRA_MAX_BYTES);
  assert.equal(GROUPS.lobby.settings.lastOptions.maxBytes, protocol.SETTINGS_LAST_OPTIONS_MAX_BYTES);
  const r = createRegistry({ storage: null });
  r.set('releaseNotes', 'lastSeenVersion', '0.6.0');
  r.set('game', 'hotkeys', { stop: ['Ctrl+Shift+F1'], guard: [] });
  r.set('content', 'packs', [{ id: 'desert tiles|someone', enabled: false }]);
  r.set('lobby', 'lastOptions', { seed: 5, players: [{ type: 'human', name: 'Tanya', faction: 'russia', color: 2, team: 0 }], mapSource: 'random' });
  r.patch('lobby', { name: 'Tanya Adams', faction: 'ukraine', color: 7 });
  r.applyDocument({ extra: { futureThing: { on: true } } });
  assert.doesNotThrow(() => protocol.validateSettingsDocument(r.document()));
  assert.doesNotThrow(() => protocol.validateSettingsDocument(createRegistry({ storage: null }).document()));
  // What the registry refuses, the server refuses too.
  for (const bad of [{ audio: { master: 2 } }, { game: { healthBars: 'x' } }, { lobby: { color: 8 } }, { nope: {} }]) {
    assert.equal(checkDocument(bad).ok, false);
    assert.throws(() => protocol.validateSettingsDocument({ schema: 1, ...bad }));
  }
  // The scales and the music settings: the same keys, limits and choices on both sides.
  assert.deepEqual([specOf('game', 'uiScale').min, specOf('game', 'uiScale').max], [protocol.UI_SCALE_LIMITS.min, protocol.UI_SCALE_LIMITS.max]);
  assert.deepEqual([specOf('game', 'gameScale').min, specOf('game', 'gameScale').max], [protocol.GAME_SCALE_LIMITS.min, protocol.GAME_SCALE_LIMITS.max]);
  assert.deepEqual([specOf('game', 'zoomFactor').min, specOf('game', 'zoomFactor').max], [protocol.ZOOM_FACTOR_LIMITS.min, protocol.ZOOM_FACTOR_LIMITS.max]);
  assert.deepEqual(specOf('audio', 'musicRepeat').options, [...protocol.MUSIC_REPEAT_MODES]);
  const values = [
    'auto',
    'Auto',
    '1',
    null,
    true,
    0,
    0.25,
    0.49,
    0.5,
    0.85,
    1,
    1.999,
    2,
    2.01,
    2.5,
    3,
    3.01,
    -1,
    Infinity,
    NaN,
    'all',
    'one',
    'off',
    'never',
    'always',
    'first',
    false,
  ];
  for (const [group, key] of [
    ['game', 'uiScale'],
    ['game', 'gameScale'],
    ['game', 'zoomFactor'],
    ['game', 'mouseCaptureRaw'],
    ['game', 'mouseCaptureNotice'],
    ['game', 'pauseWhenHidden'],
    ['game', 'hideReplayChat'],
    ['game', 'gameEventNotifications'],
    ['audio', 'musicOn'],
    ['audio', 'musicShuffle'],
    ['audio', 'musicRepeat'],
  ]) {
    for (const v of values) {
      const client = checkValue(specOf(group, key), v) === null;
      let server = true;
      try {
        protocol.validateSettingsDocument({ [group]: { [key]: v } });
      } catch {
        server = false;
      }
      assert.equal(client, server, `${group}.${key} = ${String(v)}: client ${client}, server ${server}`);
    }
  }
  r.patch('game', { uiScale: 1.35, gameScale: 2.5 });
  r.patch('audio', { musicOn: false, musicShuffle: false, musicRepeat: 'off' });
  assert.doesNotThrow(() => protocol.validateSettingsDocument(r.document()));
});

test('registry: the 0.17 keys (network warnings, friends privacy, guide and tips) are declared, validated and synced', async () => {
  const protocol = await import('../protocol/accounts.js');
  assert.deepEqual(Object.keys(GROUPS.net.settings), ['warnSelf', 'warnOthers', 'signalBars']);
  assert.deepEqual(Object.keys(GROUPS.social.settings), ['showOnline', 'friendsJoin', 'allowSpectate']);
  assert.deepEqual(Object.keys(GROUPS.guide.settings), ['tourInGames', 'done', 'seen', 'lastTip']);
  const r = createRegistry({ storage: null });
  // Defaults: every network aid on; shown online and joinable by friends, spectating off; the tour on.
  assert.deepEqual(r.values().net, { warnSelf: true, warnOthers: true, signalBars: true });
  assert.deepEqual(r.values().social, { showOnline: true, friendsJoin: true, allowSpectate: false });
  assert.deepEqual(r.values().guide, { tourInGames: true, done: {}, seen: null, lastTip: -1 });
  assert.deepEqual(r.values().net, { ...protocol.NET_SETTING_DEFAULTS });
  assert.deepEqual(r.values().social, { ...protocol.SOCIAL_SETTING_DEFAULTS }, 'the server applies the same defaults');
  assert.equal(GROUPS.guide.settings.done.maxBytes, protocol.SETTINGS_GUIDE_DONE_MAX_BYTES);
  assert.equal(GROUPS.guide.settings.lastTip.max, protocol.LOADING_TIP_INDEX_MAX);

  // Values the registry keeps pass the server; what it refuses, the server refuses too.
  r.patch('net', { warnSelf: false, signalBars: false });
  r.patch('social', { allowSpectate: true, showOnline: false });
  r.patch('guide', { tourInGames: false, done: { 'ch1.deploy': true, 'ch1.power': true }, seen: '0.18.0', lastTip: 12 });
  const doc = r.document();
  assert.deepEqual(protocol.validateSettingsDocument(doc).guide, { tourInGames: false, done: { 'ch1.deploy': true, 'ch1.power': true }, seen: '0.18.0', lastTip: 12 });
  assert.deepEqual(doc.social, { showOnline: false, friendsJoin: true, allowSpectate: true });
  for (const bad of [
    { net: { warnSelf: 'yes' } },
    { social: { allowSpectate: 1 } },
    { social: { invisible: true } },
    { guide: { lastTip: -2 } },
    { guide: { lastTip: 1000 } },
    { guide: { lastTip: 1.5 } },
    { guide: { done: [] } },
    { guide: { seen: 18 } },
    { guide: { seen: 'not a version!' } },
    { guide: { done: { 'bad key!': true } } },
    { guide: { done: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`chapter.step${i}`, true])) } },
  ]) {
    assert.equal(checkDocument(bad).ok, false, JSON.stringify(bad).slice(0, 60));
    assert.throws(() => protocol.validateSettingsDocument({ schema: 1, ...bad }), JSON.stringify(bad).slice(0, 60));
  }
  // A stored value of the wrong type falls back to the default instead of breaking the game.
  assert.equal(normalizeValues({ guide: { lastTip: 'x' }, net: { signalBars: 3 } }).values.guide.lastTip, -1);
  assert.equal(normalizeValues({ net: { signalBars: 3 } }).values.net.signalBars, true);

  // Sync: they are declared keys, so a change on one side merges and both-sided changes conflict.
  const base = normalizeValues({}).values;
  const local = normalizeValues({ guide: { lastTip: 4 }, net: { warnOthers: false } }).values;
  const remote = normalizeValues({ social: { allowSpectate: true }, net: { warnOthers: true, warnSelf: false } }).values;
  const m = mergeSettings({ base, local, remote });
  assert.equal(m.merged.guide.lastTip, 4);
  assert.equal(m.merged.social.allowSpectate, true);
  assert.equal(m.merged.net.warnSelf, false);
  assert.deepEqual(m.conflicts, []);
  // guide.done merges step by step: steps done on two devices add up, no conflict.
  const done = (d) => normalizeValues({ guide: { done: d } }).values;
  const both = mergeSettings({ base, local: done({ a: true }), remote: done({ b: true }) });
  assert.deepEqual(both.conflicts, []);
  assert.deepEqual(both.merged.guide.done, { a: true, b: true });
  // Without a base (first sync of a device): the union.
  assert.deepEqual(mergeSettings({ base: null, local: done({ a: true }), remote: done({ b: true }) }).merged.guide.done, { a: true, b: true });
  // A reset on one side (steps removed from the base) stays a reset; new steps on the other side are kept.
  const b2 = done({ a: true, b: true });
  const reset = mergeSettings({ base: b2, local: done({}), remote: done({ a: true, b: true, c: true }) });
  assert.deepEqual(reset.merged.guide.done, { c: true });
  // One-sided changes win as for every setting.
  assert.deepEqual(mergeSettings({ base: b2, local: b2, remote: done({ a: true }) }).merged.guide.done, { a: true });
  // A union too big for the setting stays a conflict, with the account's value until the player chooses.
  const many = (p) => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`${p}.chapter.step${i}`, true]));
  const big = mergeSettings({ base, local: done(many('x')), remote: done(many('y')) });
  assert.deepEqual(big.conflicts.map((c) => `${c.group}.${c.key}`), ['guide.done']);
  assert.deepEqual(big.merged.guide.done, many('y'));
});

test('registry: guide.seen syncs as the newer version of two devices, never a conflict', () => {
  const seen = (v) => normalizeValues({ guide: { seen: v } }).values;
  const base = seen('0.17.0');
  // Both sides moved on: the newer stays (semantic order, not text order).
  const both = mergeSettings({ base, local: seen('0.9.0'), remote: seen('0.18.0') });
  assert.equal(both.merged.guide.seen, '0.18.0');
  assert.deepEqual(both.conflicts, []);
  assert.equal(mergeSettings({ base, local: seen('0.19.0'), remote: seen('0.18.0') }).merged.guide.seen, '0.19.0');
  // One side only: the newer too, also when that side went back (an older client never lowers it).
  assert.equal(mergeSettings({ base, local: seen('0.17.0'), remote: seen('0.18.0') }).merged.guide.seen, '0.18.0');
  assert.equal(mergeSettings({ base: seen('0.18.0'), local: seen('0.18.0'), remote: seen('0.17.0') }).merged.guide.seen, '0.18.0');
  // A new device (no base) against an account that never set it: the version, no conflict.
  const fresh = mergeSettings({ base: null, local: seen('0.18.0'), remote: normalizeValues({}).values });
  assert.equal(fresh.merged.guide.seen, '0.18.0');
  assert.deepEqual(fresh.conflicts.filter((c) => c.key === 'seen'), []);
  // A pre-release sorts before its release.
  assert.equal(mergeSettings({ base: null, local: seen('0.18.0-rc.1'), remote: seen('0.18.0') }).merged.guide.seen, '0.18.0');
});
