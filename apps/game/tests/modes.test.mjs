// Game modes in the lobbies (js/modes.js, js/modepicker.js): presets apply
// exact option sets, any other change reads as Custom, saved modes round
// trip through the settings registry and the server's validation, and only
// the host picks a mode online. Also: every option in both lobbies and the
// game menu carries its "?" help.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, memoryStorage, click, check, typeInto, FakeEvent, textOf } from './dom-fixtures.mjs';
import { CUSTOM, applyMode, currentMode, deletePreset, matchesMode, modeList, savePreset, savedId, PRESET_KEYS } from '../js/modes.js';
import { createRegistry, defaultRegistry, checkValue, specOf, REGISTRY_KEY } from '../js/registry.js';
import { parseValue, formatValue } from '../js/account/admin-forms.js';
import { BUILTIN_MODES, DEFAULT_OPTIONS, PRESETS_MAX, validateLobbyOptions, validateSettingsDocument } from '../protocol/index.js';
import { HELP } from '../js/help.js';

const COLORS = Array.from({ length: 8 }, (_, i) => [i / 8, 0.5, 0.5]);
const builtin = (id) => BUILTIN_MODES.find((m) => m.id === id);

test('modes: the list per lobby, exact bundles and Custom detection', () => {
  const skirmish = modeList('skirmish');
  const online = modeList('online', [{ name: 'Mine', options: { ...builtin('winter').options, startingCash: 7500 } }]);
  assert.ok(skirmish.some((m) => m.id === 'sandbox'));
  assert.ok(!online.some((m) => m.id === 'sandbox'), 'Sandbox is skirmish only');
  assert.equal(online.at(-1).id, savedId('Mine'));
  assert.equal(online.at(-1).saved, true);

  const start = { ...DEFAULT_OPTIONS, seed: 77, mapSize: 128 };
  for (const mode of skirmish) {
    const next = applyMode(start, mode);
    // Exactly the bundle: every mode key from the mode, the rest untouched.
    for (const k of PRESET_KEYS) assert.equal(next[k], mode.options[k], `${mode.id}.${k}`);
    assert.equal(next.seed, 77);
    assert.equal(next.mapSize, 128);
    assert.equal(currentMode(next, skirmish), mode.id);
    assert.doesNotThrow(() => validateLobbyOptions(next));
    // Any single change makes it Custom (or another mode that happens to match).
    const changed = { ...next, startingCash: next.startingCash === 5000 ? 7500 : 5000 };
    assert.equal(matchesMode(changed, mode), false);
  }
  assert.equal(currentMode({ ...DEFAULT_OPTIONS, startingCash: 7500, gameSpeed: 'slowest' }, skirmish), CUSTOM);
  // A preferred mode wins when it matches; Custom stays when chosen.
  const winterCopy = modeList('skirmish', [{ name: 'Snowy', options: builtin('winter').options }]);
  const winter = applyMode(DEFAULT_OPTIONS, builtin('winter'));
  assert.equal(currentMode(winter, winterCopy), 'winter');
  assert.equal(currentMode(winter, winterCopy, savedId('Snowy')), savedId('Snowy'));
  assert.equal(currentMode(winter, winterCopy, CUSTOM), CUSTOM);
  assert.equal(currentMode({ ...winter, fog: false }, winterCopy, savedId('Snowy')), CUSTOM);
});

test('saved modes: save, replace, limits and delete', () => {
  let list = [];
  const a = savePreset(list, '  Night   ops ', { ...DEFAULT_OPTIONS, fog: true, explored: true });
  assert.equal(a.name, 'Night ops');
  assert.equal(a.replaced, false);
  list = a.list;
  assert.deepEqual(Object.keys(list[0].options), [...PRESET_KEYS], 'only the mode keys are kept (no seed, size or players)');
  const b = savePreset(list, 'night OPS', { ...DEFAULT_OPTIONS, startingCash: 20000 });
  assert.equal(b.replaced, true);
  assert.equal(b.list.length, 1);
  assert.equal(b.list[0].options.startingCash, 20000);
  assert.match(savePreset(list, 'Classic', DEFAULT_OPTIONS).error, /built-in/);
  assert.match(savePreset(list, '   ', DEFAULT_OPTIONS).error, /empty/);
  assert.match(savePreset(list, 'x'.repeat(33), DEFAULT_OPTIONS).error, /at most 32/);
  const full = Array.from({ length: PRESETS_MAX }, (_, i) => ({ name: `M${i}`, options: builtin('classic').options }));
  assert.match(savePreset(full, 'One more', DEFAULT_OPTIONS).error, /delete one first/);
  assert.equal(savePreset(full, 'm3', DEFAULT_OPTIONS).replaced, true, 'replacing still works when full');
  assert.deepEqual(deletePreset(b.list, 'NIGHT ops'), []);
});

test('saved modes round trip through the registry, the account document and another device', () => {
  const storage = memoryStorage();
  const r = createRegistry({ storage });
  const { list } = savePreset([], 'Tank party', { ...DEFAULT_OPTIONS, startingUnits: 'heavy', techLevel: 'high' });
  r.set('lobby', 'presets', list);
  assert.deepEqual(r.get('lobby', 'presets'), list);
  // What the account stores passes the server's validation unchanged.
  const doc = r.document();
  assert.deepEqual(validateSettingsDocument(doc).lobby.presets, list);
  // The same browser after a reload.
  assert.deepEqual(createRegistry({ storage }).get('lobby', 'presets'), list);
  // Another device takes the account document.
  const other = createRegistry({ storage: null });
  other.applyDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(other.get('lobby', 'presets'), list);
  // Bad entries from elsewhere are dropped, good ones kept; checkValue reports them.
  const messy = [list[0], { name: 'Bad', options: { ...list[0].options, biome: 'moon' } }, { name: 'tank PARTY', options: list[0].options }, 'junk'];
  other.set('lobby', 'presets', messy);
  assert.deepEqual(other.get('lobby', 'presets'), list);
  assert.equal(checkValue(specOf('lobby', 'presets'), list), null);
  assert.match(checkValue(specOf('lobby', 'presets'), messy), /^mode 2 options\.biome/);
  assert.match(checkValue(specOf('lobby', 'presets'), 'no'), /must be a list/);
  // The admin's settings editor reads and writes them as JSON.
  const spec = specOf('lobby', 'presets');
  assert.deepEqual(parseValue(spec, formatValue(spec, list)).value, list);
  assert.deepEqual(parseValue(spec, '').value, []);
  assert.match(parseValue(spec, '[{"name":"x"}]').error, /mode 1/);
  assert.ok(storage.getItem(REGISTRY_KEY).includes('Tank party'));
});

// ---- The skirmish lobby ---------------------------------------------------------------------

async function mountLobby() {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  const root = doc.createElement('section');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'presets', []);
  defaultRegistry().set('lobby', 'lastOptions', {});
  const { Lobby } = await import('../js/lobby.js');
  const started = [];
  const lobby = new Lobby(root, {
    colors: COLORS,
    colorNames: [],
    mapPreview: () => new Uint8Array(0),
    onStart: (o) => started.push(o),
    onStress: () => {},
  });
  const modeSelect = root.querySelector('.mode-select');
  const pick = (value) => {
    modeSelect.value = value;
    modeSelect.dispatchEvent(new FakeEvent('change'));
  };
  return { doc, root, lobby, modeSelect, pick, started };
}

function done() {
  delete globalThis.requestAnimationFrame;
  uninstallDom();
}

test('skirmish lobby: every option has a "?" tip wired to its control', async () => {
  const { root } = await mountLobby();
  try {
    const { HELP_KEYS } = await import('../js/lobby.js');
    const shown = new Set(root.querySelectorAll('.info-btn').map((b) => b.dataset.help));
    for (const key of HELP_KEYS) assert.ok(shown.has(key), `no "?" for ${key}`);
    const tips = new Set(root.querySelectorAll('[role="tooltip"]').map((t) => t.id));
    for (const t of root.querySelectorAll('[role="tooltip"]')) {
      const button = root.querySelectorAll('.info-btn').find((b) => b.getAttribute('aria-describedby') === t.id);
      assert.equal(t.textContent, HELP[button.dataset.help]);
    }
    // Every option control is described by a tip of this lobby.
    const controls = [...root.querySelectorAll('.lobby-options select'), ...root.querySelectorAll('.lobby-options input'), ...root.querySelectorAll('.lobby-map select')];
    assert.ok(controls.length >= 15);
    for (const c of controls) {
      if (c.classList.contains('mode-name')) continue;
      const ids = (c.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
      assert.ok(ids.length && ids.every((id) => tips.has(id)), `${c.id || c.className} has no help`);
    }
    // Slot controls follow their column's help.
    for (const c of root.querySelectorAll('.lobby-slots select')) assert.ok(tips.has(c.getAttribute('aria-describedby')), c.getAttribute('aria-label'));
    // Labels name their controls.
    for (const label of root.querySelectorAll('label.lobby-field-label')) assert.ok(root.querySelector(`#${label.getAttribute('for')}`), textOf(label));
  } finally {
    done();
  }
});

test('skirmish lobby: map style, biome and weather form the World group', async () => {
  const { root, lobby } = await mountLobby();
  try {
    const world = root.querySelector('fieldset.lobby-world');
    assert.equal(textOf(world.querySelector('legend')), 'World');
    const selects = world.querySelectorAll('select');
    assert.deepEqual(selects, [lobby.styleSelect, lobby.biomeSelect, lobby.weatherSelect]);
    assert.deepEqual(world.querySelectorAll('.info-btn').map((b) => b.dataset.help), ['mapStyle', 'biome', 'weather']);
    lobby.weatherSelect.value = 'cosmetic';
    lobby.weatherSelect.dispatchEvent(new FakeEvent('change'));
    assert.equal(lobby.getOptions().weather, 'cosmetic');
  } finally {
    done();
  }
});

test('skirmish lobby: a mode applies its exact options; any change switches to Custom', async () => {
  const { root, lobby, modeSelect, pick } = await mountLobby();
  try {
    const seed = lobby.state.seed;
    const offered = modeSelect.querySelectorAll('option').map((o) => o.value);
    assert.deepEqual(offered, [...BUILTIN_MODES.map((m) => m.id), CUSTOM]);
    for (const mode of BUILTIN_MODES) {
      pick(mode.id);
      const o = lobby.getOptions();
      for (const k of PRESET_KEYS) assert.equal(o[k], mode.options[k], `${mode.id}.${k}`);
      assert.equal(o.seed, seed, 'the seed stays');
      assert.equal(modeSelect.value, mode.id);
      assert.equal(textOf(root.querySelector('.mode-desc')), mode.description);
      // The controls show the mode's values.
      assert.equal(lobby.optionSelects.startingCash.value, String(mode.options.startingCash));
      assert.equal(lobby.biomeSelect.value, mode.options.biome);
      assert.equal(lobby.optionToggles.cheats.checked, mode.options.cheats);
    }
    pick('rush');
    const cash = lobby.optionSelects.startingCash;
    cash.value = '10000';
    cash.dispatchEvent(new FakeEvent('change'));
    assert.equal(modeSelect.value, CUSTOM);
    assert.equal(textOf(root.querySelector('.mode-desc')), 'Options set by hand.');
    cash.value = '2500';
    cash.dispatchEvent(new FakeEvent('change'));
    assert.equal(modeSelect.value, 'rush', 'back to the mode when the options match again');
    check(lobby.optionToggles.fog, false);
    assert.equal(modeSelect.value, CUSTOM);
    // Choosing Custom keeps the options and shows Custom.
    pick('classic');
    pick(CUSTOM);
    assert.equal(modeSelect.value, CUSTOM);
    assert.ok(matchesMode(lobby.getOptions(), builtin('classic')));
    // The chosen mode is remembered with the last setup.
    pick('winter');
    lobby.start();
    assert.equal(defaultRegistry().get('lobby', 'lastOptions').mode, 'winter');
  } finally {
    done();
  }
});

test('skirmish lobby: save, pick and delete your own modes', async () => {
  const { root, lobby, modeSelect, pick } = await mountLobby();
  try {
    pick('desertstorm');
    const units = lobby.optionSelects.startingUnits;
    units.value = 'heavy';
    units.dispatchEvent(new FakeEvent('change'));
    const [saveAs] = root.querySelectorAll('.mode-tools button');
    click(saveAs);
    const form = root.querySelector('.mode-save');
    assert.equal(form.hidden, false);
    const name = root.querySelector('.mode-name');
    // Enter saves and does not start the game.
    name.value = 'Hot tanks';
    const enter = new FakeEvent('keydown', { key: 'Enter' });
    name.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(form.hidden, true);
    assert.equal(textOf(root.querySelector('.mode-status')), 'Mode "Hot tanks" saved.');
    const saved = defaultRegistry().get('lobby', 'presets');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], { name: 'Hot tanks', options: Object.fromEntries(PRESET_KEYS.map((k) => [k, lobby.getOptions()[k]])) });
    assert.doesNotThrow(() => validateSettingsDocument(defaultRegistry().document()));
    assert.equal(modeSelect.value, savedId('Hot tanks'));
    assert.deepEqual(
      modeSelect.querySelectorAll('optgroup').map((g) => g.label),
      ['Modes', 'Your modes'],
    );
    // Another mode, then back to the saved one.
    pick('classic');
    assert.equal(lobby.state.startingUnits, 'mcv');
    pick(savedId('Hot tanks'));
    assert.equal(lobby.state.startingUnits, 'heavy');
    assert.equal(lobby.state.biome, 'desert');
    // A built-in name is refused with a message.
    click(saveAs);
    typeInto(name, 'Winter');
    click(root.querySelectorAll('.mode-save button')[0]);
    assert.match(textOf(root.querySelector('.mode-status')), /built-in mode/);
    click(root.querySelectorAll('.mode-save button')[1]);
    // Delete asks first.
    const del = root.querySelectorAll('.mode-tools button')[1];
    assert.equal(del.hidden, false);
    click(del);
    assert.equal(defaultRegistry().get('lobby', 'presets').length, 1);
    assert.match(textOf(del), /Delete "Hot tanks"\?/);
    click(del);
    assert.deepEqual(defaultRegistry().get('lobby', 'presets'), []);
    assert.equal(modeSelect.value, CUSTOM);
    assert.equal(del.hidden, true);
    // A mode synced from the account shows up at once.
    defaultRegistry().applyDocument({ lobby: { presets: [{ name: 'From laptop', options: builtin('turtle').options }] } });
    assert.ok(modeSelect.querySelectorAll('option').some((o) => o.value === savedId('From laptop')));
  } finally {
    done();
  }
});

// ---- The online lobby ---------------------------------------------------------------------------

async function mountOnline({ host }) {
  const doc = installDom();
  const root = doc.createElement('div');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'presets', [{ name: 'My war', options: builtin('winter').options }]);
  const { OnlineUI } = await import('../js/online.js');
  const ui = Object.create(OnlineUI.prototype);
  const sent = [];
  Object.assign(ui, {
    root,
    ctx: { colors: COLORS, colorNames: [], Game: { map_preview_styled: () => new Uint8Array(0) } },
    installed: new Map(),
    mapStatus: { hash: null, text: '', ok: true },
    serverMaps: [],
    send: (m) => sent.push(m),
    state: {
      you: host ? 1 : 2,
      hostId: 1,
      session: { id: 'abc', name: 'Test', public: true },
      role: 'player',
      slots: [],
      spectators: [],
      maxSpectators: 2,
      options: null,
      map: null,
      lobbySeen: false,
    },
  });
  ui.buildLobby();
  const lobby = (options) =>
    ui.onLobby({
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false },
        { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: false },
        { type: 'ai', difficulty: 'hard', faction: 'random', color: 2, team: 0 },
      ],
      options,
      map: null,
      hostId: 1,
      spectators: [],
      maxSpectators: 2,
    });
  return { root, ui, sent, lobby };
}

test('online lobby: the host picks a mode and sends plain options', async () => {
  const { root, sent, lobby } = await mountOnline({ host: true });
  try {
    lobby({ ...DEFAULT_OPTIONS, seed: 9 });
    const select = root.querySelector('.mode-select');
    assert.equal(select.disabled, false);
    const offered = select.querySelectorAll('option').map((o) => o.value);
    assert.ok(!offered.includes('sandbox'), 'Sandbox is skirmish only');
    assert.ok(offered.includes(savedId('My war')), 'the host can use saved modes');
    select.value = 'rush';
    select.dispatchEvent(new FakeEvent('change'));
    const msg = sent.at(-1);
    assert.equal(msg.t, 'options');
    assert.deepEqual(Object.keys(msg.options).sort(), Object.keys(DEFAULT_OPTIONS).sort(), 'no new fields on the wire');
    assert.equal(msg.options.seed, 9);
    for (const k of PRESET_KEYS) assert.equal(msg.options[k], builtin('rush').options[k]);
    assert.doesNotThrow(() => validateLobbyOptions(msg.options));
    // The server echoes the options: the lobby shows Rush.
    lobby(msg.options);
    assert.equal(select.value, 'rush');
    // A host edit goes out as an option change too, and reads as Custom once echoed.
    // Fog of war: third in OpenRA's order (crates, short game, fog of war, ...).
    const toggle = root.querySelectorAll('.online-toggles input')[2];
    check(toggle, false);
    assert.equal(sent.at(-1).options.fog, false);
    lobby(sent.at(-1).options);
    assert.equal(select.value, CUSTOM);
    assert.equal(root.querySelector('.mode-tools').hidden, false);
  } finally {
    uninstallDom();
  }
});

test('online lobby: guests see the mode and its options but cannot change them', async () => {
  const { root, sent, lobby } = await mountOnline({ host: false });
  try {
    lobby({ ...DEFAULT_OPTIONS, ...builtin('winter').options, seed: 3 });
    const select = root.querySelector('.mode-select');
    assert.equal(select.disabled, true);
    assert.equal(select.querySelectorAll('option').find((o) => o.value === select.value).textContent, 'Winter');
    assert.equal(textOf(root.querySelector('.mode-desc')), builtin('winter').description);
    assert.equal(root.querySelector('.mode-tools').hidden, true, 'no saving or deleting for guests');
    // The World group and every option show the values, read only.
    const world = root.querySelector('fieldset.online-world');
    assert.deepEqual(world.querySelectorAll('select').map((s) => s.value), ['random', 'snow', 'full']);
    for (const c of [...root.querySelectorAll('.online-options select'), ...root.querySelectorAll('.online-options input[type="checkbox"]')]) {
      assert.equal(c.disabled, true, c.id);
    }
    assert.equal(sent.length, 0);
  } finally {
    uninstallDom();
  }
});

test('online lobby: every option has a "?" tip', async () => {
  const { root, ui, lobby } = await mountOnline({ host: true });
  try {
    lobby({ ...DEFAULT_OPTIONS });
    ui.renderSpectators();
    const { ONLINE_HELP_KEYS } = await import('../js/online.js');
    const shown = new Set(root.querySelectorAll('.info-btn').map((b) => b.dataset.help));
    for (const key of ONLINE_HELP_KEYS) assert.ok(shown.has(key), `no "?" for ${key}`);
    const tips = new Set(root.querySelectorAll('[role="tooltip"]').map((t) => t.id));
    for (const c of [...root.querySelectorAll('.online-options select'), ...root.querySelectorAll('.online-options input[type="checkbox"]'), ...root.querySelectorAll('.online-slots select')]) {
      const ids = (c.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
      assert.ok(ids.length && ids.every((id) => tips.has(id)), `${c.id || c.getAttribute('aria-label')} has no help`);
    }
  } finally {
    uninstallDom();
  }
});
