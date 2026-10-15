// Release notes data (js/releasenotes.js): versions, scope names, the
// sanitizer, and the "What's new" dialog opening once per version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRegistry, REGISTRY_KEY } from '../js/registry.js';
import {
  GENERAL_LABEL,
  SEEN_SETTING,
  compareVersions,
  formatReleaseDate,
  groupByScope,
  normalizeVersion,
  readSeenVersion,
  sanitizeNotes,
  scopeLabel,
  sectionTag,
  whatsNew,
  writeSeenVersion,
} from '../js/releasenotes.js';

/** localStorage stand-in; `broken` makes every call throw like a blocked storage. */
function memoryStorage({ broken = false, initial = {} } = {}) {
  const map = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v))),
    removeItem: (k) => (guard(), map.delete(k)),
    map,
  };
}

/** A settings registry over memoryStorage (js/registry.js). */
const registryOver = (o) => {
  const storage = memoryStorage(o);
  return Object.assign(createRegistry({ storage }), { storage });
};

const rel = (version) => ({ version, date: '2026-01-01', compareUrl: null, sections: [] });
const RELEASES = ['0.5.0', '0.4.1', '0.4.0', '0.3.0'].map(rel);

test('versions: build strings and a leading v normalize; semver order with pre-releases', () => {
  assert.equal(normalizeVersion('0.3.0+3cb9f51f'), '0.3.0');
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3-rc.1+abc'), '1.2.3-rc.1');
  for (const bad of [null, undefined, '', 'dev', '1.2', 12]) assert.equal(normalizeVersion(bad), null, String(bad));
  const sorted = ['0.10.0', '0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '0.9.1'];
  sorted.sort(compareVersions);
  assert.deepEqual(sorted, ['0.9.0', '0.9.1', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']);
  assert.equal(compareVersions('0.3.0+aaaa', '0.3.0+bbbb'), 0);
  assert.ok(compareVersions('junk', '0.0.1') < 0);
});

test('scope names: friendly labels, unknown scopes capitalized, combined scopes, no scope', () => {
  assert.equal(scopeLabel('engine'), 'Engine');
  assert.equal(scopeLabel('sim'), 'Engine');
  assert.equal(scopeLabel('game'), 'Game');
  assert.equal(scopeLabel('server'), 'Online');
  assert.equal(scopeLabel('protocol'), 'Online');
  assert.equal(scopeLabel('editor'), 'Map editor');
  assert.equal(scopeLabel('Website'), 'Website');
  assert.equal(scopeLabel('pathfinding'), 'Pathfinding');
  assert.equal(scopeLabel('server,protocol'), 'Online');
  assert.equal(scopeLabel('game/editor'), 'Game, Map editor');
  assert.equal(scopeLabel(null), GENERAL_LABEL);
  assert.equal(scopeLabel('  '), GENERAL_LABEL);
  // Never a prototype property for a scope named like one.
  assert.equal(scopeLabel('constructor'), 'Constructor');
});

test('groupByScope merges scopes with the same name, keeps order, General last', () => {
  const entries = [
    { scope: 'server', text: 'a' },
    { scope: null, text: 'b' },
    { scope: 'engine', text: 'c' },
    { scope: 'protocol', text: 'd' },
    { scope: 'sim', text: 'e' },
  ];
  assert.deepEqual(
    groupByScope(entries).map((g) => [g.label, g.entries.map((e) => e.text).join('')]),
    [
      ['Online', 'ad'],
      ['Engine', 'ce'],
      [GENERAL_LABEL, 'b'],
    ],
  );
  assert.deepEqual(groupByScope([{ scope: 'custom', text: 'x' }], { custom: 'Custom name' })[0].label, 'Custom name');
});

test('sanitizeNotes keeps well-formed data and drops the rest', () => {
  const doc = {
    schema: 1,
    scopes: { custom: 'Custom', bad: 3 },
    releases: [
      { version: '0.2.0', date: '2026-01-02', compareUrl: 'https://github.com/o/r/compare/a...b', sections: [{ type: 'features', title: 'Features', entries: [{ scope: 'game', text: 'ok', commit: 'abc1234', url: 'https://github.com/o/r/commit/abc1234', refs: [{ label: '#1', url: 'https://github.com/o/r/issues/1' }, { label: '#2', url: 'javascript:alert(1)' }] }] }] },
      { version: '0.3.0', date: 'yesterday', compareUrl: 'javascript:alert(1)', sections: [{ type: 'fixes', title: 'Bug Fixes', entries: [{ scope: 3, text: 'x', commit: 'not a hash', url: 'http://insecure/' }, { text: '' }, null] }, { title: 'Empty', entries: [] }] },
      { version: 'nope', sections: [] },
      { version: '0.1.0' },
      null,
    ],
  };
  const clean = sanitizeNotes(doc);
  assert.deepEqual(
    clean.releases.map((r) => r.version),
    ['0.3.0', '0.2.0'],
    'valid releases only, newest first',
  );
  const [r3, r2] = clean.releases;
  assert.equal(r3.date, null);
  assert.equal(r3.compareUrl, null);
  assert.deepEqual(r3.sections, [{ type: 'fixes', title: 'Bug Fixes', entries: [{ scope: null, text: 'x', commit: null, url: null, refs: [] }] }]);
  assert.deepEqual(r2.sections[0].entries[0].refs, [{ label: '#1', url: 'https://github.com/o/r/issues/1' }]);
  assert.equal(clean.scopes.custom, 'Custom');
  assert.equal(clean.scopes.bad, undefined);
  assert.equal(clean.scopes.server, 'Online', 'built-in names stay available');
  for (const bad of [null, 'text', {}, { releases: 'x' }]) assert.equal(sanitizeNotes(bad), null);
});

test('release dates format in UTC without shifting the day', () => {
  assert.equal(formatReleaseDate('2026-10-08'), '8 Oct 2026');
  assert.equal(formatReleaseDate('2026-01-01'), '1 Jan 2026');
  assert.equal(formatReleaseDate(null), null);
  assert.equal(formatReleaseDate('8 Oct'), null);
});

test("what's new: a first visit remembers the version without opening", () => {
  assert.deepEqual(whatsNew({ current: '0.5.0+abc', seen: null, releases: RELEASES }), { show: false, releases: [], remember: '0.5.0' });
});

test("what's new: an update opens once with every release since the last one seen", () => {
  const d = whatsNew({ current: '0.5.0', seen: '0.4.0', releases: RELEASES });
  assert.equal(d.show, true);
  assert.deepEqual(
    d.releases.map((r) => r.version),
    ['0.5.0', '0.4.1'],
  );
  assert.equal(d.remember, '0.5.0');
  // The next load of the same version: nothing.
  assert.deepEqual(whatsNew({ current: '0.5.0', seen: '0.5.0', releases: RELEASES }), { show: false, releases: [], remember: null });
});

test("what's new: releases newer than the running game are not shown as new", () => {
  // The notes file can be newer than a cached game (both are fetched separately).
  const d = whatsNew({ current: '0.4.1', seen: '0.3.0', releases: RELEASES });
  assert.deepEqual(
    d.releases.map((r) => r.version),
    ['0.4.1', '0.4.0'],
  );
  assert.equal(d.remember, '0.4.1');
});

test("what's new: an older build than one seen before changes nothing", () => {
  assert.deepEqual(whatsNew({ current: '0.4.0', seen: '0.5.0', releases: RELEASES }), { show: false, releases: [], remember: null });
});

test("what's new: a version without notes neither opens nor remembers", () => {
  assert.deepEqual(whatsNew({ current: '0.6.0', seen: '0.5.0', releases: RELEASES }), { show: false, releases: [], remember: null });
  assert.deepEqual(whatsNew({ current: null, seen: '0.5.0', releases: RELEASES }), { show: false, releases: [], remember: null });
  assert.deepEqual(whatsNew({ current: '0.5.0', seen: '0.4.0', releases: null }), { show: false, releases: [], remember: null });
});

test('seen version setting: round trip, garbage, migration, and storage that throws', () => {
  const s = registryOver();
  assert.equal(readSeenVersion(s), null);
  assert.equal(writeSeenVersion('0.3.0+abcdef12', s), true);
  assert.equal(JSON.parse(s.storage.map.get(REGISTRY_KEY))[SEEN_SETTING[0]][SEEN_SETTING[1]], '0.3.0');
  assert.equal(readSeenVersion(s), '0.3.0');
  assert.equal(writeSeenVersion('dev', s), false);
  assert.equal(readSeenVersion(registryOver({ initial: { 'webra.releaseNotes.seen': '<script>' } })), null);
  assert.equal(readSeenVersion(registryOver({ initial: { 'webra.releaseNotes.seen': '0.4.0' } })), '0.4.0', 'the old key migrates');
  const broken = registryOver({ broken: true });
  assert.equal(readSeenVersion(broken), null);
  assert.equal(writeSeenVersion('0.3.0', broken), true, 'kept for this page');
  assert.equal(readSeenVersion(null), null);
  assert.equal(writeSeenVersion('0.3.0', null), false);
});

test('the whole flow: first visit, same version, update, then nothing until the next one', () => {
  const storage = registryOver();
  const load = (current) => {
    const d = whatsNew({ current, seen: readSeenVersion(storage), releases: RELEASES });
    if (d.remember) writeSeenVersion(d.remember, storage);
    return d.show ? d.releases.map((r) => r.version) : null;
  };
  assert.equal(load('0.3.0'), null);
  assert.equal(load('0.3.0'), null);
  assert.deepEqual(load('0.4.1'), ['0.4.1', '0.4.0']);
  assert.equal(load('0.4.1'), null);
  assert.deepEqual(load('0.5.0'), ['0.5.0']);
  assert.equal(load('0.5.0'), null);
});

test('the dialog builds its content with textContent only', () => {
  const src = readFileSync(new URL('../js/releasenotes-dialog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /\.style\b|setAttribute\('style'/, 'no inline styles under the CSP');
});

test('section tags: NEW for features, FIXED for fixes, the title for the rest; each with a badge look', () => {
  assert.deepEqual(sectionTag('features', 'Features'), { text: 'New', kind: 'ok' });
  assert.deepEqual(sectionTag('fixes', 'Bug Fixes'), { text: 'Fixed', kind: 'neutral' });
  assert.deepEqual(sectionTag('breaking', 'Breaking changes'), { text: 'Breaking', kind: 'bad' });
  assert.deepEqual(sectionTag('performance', 'Performance Improvements'), { text: 'Faster', kind: 'info' });
  assert.deepEqual(sectionTag('reverts', 'Reverts'), { text: 'Reverts', kind: 'neutral' });
});

test("the dialog: What's new names the version under the kicker, groups are tagged NEW or FIXED with their scope", async () => {
  const { installDom, uninstallDom, settle, textOf } = await import('./dom-fixtures.mjs');
  const { mountReleaseNotes } = await import('../js/releasenotes-dialog.js');
  const doc = installDom();
  const fetch = globalThis.fetch;
  const notes = {
    releases: [
      { version: '0.17.0', date: '2026-10-20', sections: [
        { type: 'features', title: 'Features', entries: [{ scope: 'game', text: 'The menus have a new look.' }, { scope: 'editor', text: 'Select plates in the editor.' }] },
        { type: 'fixes', title: 'Bug Fixes', entries: [{ scope: 'game', text: 'Placement follows OpenRA.' }] },
      ] },
      { version: '0.16.0', date: '2026-10-14', sections: [{ type: 'features', title: 'Features', entries: [{ scope: 'game', text: 'Loading screen.' }] }] },
    ],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(notes), { headers: { 'content-type': 'application/json' } });
  try {
    const panel = doc.createElement('section');
    doc.body.append(panel);
    const registry = registryOver();
    writeSeenVersion('0.16.0', registry);
    const rn = mountReleaseNotes(panel, { version: '0.17.0', registry });
    assert.equal(await rn.showWhatsNewOnce(), true);
    await settle();
    assert.equal(textOf(panel.querySelector('.rn-kicker')), "What's new");
    assert.equal(textOf(panel.querySelector('.rn-title')), 'Version 0.17.0');
    assert.equal(panel.querySelector('[role="dialog"]').getAttribute('aria-labelledby'), 'release-notes-kicker release-notes-title');
    const groups = [...panel.querySelectorAll('.rn-group')];
    assert.deepEqual(groups.map((g) => textOf(g.querySelector('h3'))), ['NewGame', 'NewMap editor', 'FixedGame']);
    assert.ok(groups[0].querySelector('.ui-badge-ok'), 'NEW in green with the word');
    assert.equal(groups[2].dataset.kind, 'neutral');
    assert.equal(textOf(panel.querySelector('.rn-done')), 'Got it');
    // The full list: the plain title and the running version.
    await rn.open();
    assert.equal(textOf(panel.querySelector('.rn-title')), 'Release notes');
    assert.equal(panel.querySelector('.rn-kicker').hidden, true);
    assert.equal(textOf(panel.querySelector('.rn-current-badge')), 'v0.17.0');
  } finally {
    globalThis.fetch = fetch;
    uninstallDom();
  }
});
