// CHANGELOG.md parser (tools/release-notes.mjs) and the release-notes.json it writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMIT, SCHEMA, buildReleaseNotes, parseChangelog, parseEntry, writeReleaseNotes } from './release-notes.mjs';
import { sanitizeNotes } from '../apps/game/js/releasenotes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const { version: PACKAGE_VERSION } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REPO = 'https://github.com/SherinBloemendaal/webra';
const HASH = 'c82c843e40c53afb04ac815b1f76933f1f3303ab';

/** Every bullet line of a markdown text. */
const bullets = (md) => md.split('\n').filter((l) => /^[*-] /.test(l));

test('the real CHANGELOG.md: every bullet becomes an entry with a commit link', () => {
  const releases = parseChangelog(CHANGELOG);
  assert.ok(releases.length >= 1);
  assert.equal(releases[0].version, PACKAGE_VERSION, 'newest release is the package version');
  const entries = releases.flatMap((r) => r.sections.flatMap((s) => s.entries));
  assert.equal(entries.length, bullets(CHANGELOG).length);
  for (const e of entries) {
    assert.match(e.text, /^\S/);
    assert.doesNotMatch(e.text, /\]\(|\*\*|\(\[/, `markdown left in "${e.text}"`);
    assert.match(e.commit, /^[0-9a-f]{7}$/);
    assert.ok(e.url.startsWith(`${REPO}/commit/${e.commit}`), e.url);
  }
  for (const r of releases) {
    assert.match(r.version, /^\d+\.\d+\.\d+/);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    if (r.compareUrl) assert.ok(r.compareUrl.startsWith(`${REPO}/compare/`), r.compareUrl);
    for (const s of r.sections) assert.ok(s.entries.length > 0);
  }
});

test('the real CHANGELOG.md: the first entries of 0.3.0 read as written', () => {
  const r = parseChangelog(CHANGELOG).find((x) => x.version === '0.3.0');
  assert.ok(r, 'release 0.3.0');
  assert.equal(r.date, '2026-10-08');
  assert.equal(r.compareUrl, `${REPO}/compare/v0.2.0...v0.3.0`);
  assert.deepEqual(
    r.sections.map((s) => [s.type, s.title]),
    [
      ['features', 'Features'],
      ['fixes', 'Bug Fixes'],
    ],
  );
  assert.deepEqual(r.sections[0].entries[0], {
    scope: 'editor',
    text: 'add map document with undo history, tools and symmetry',
    commit: 'c82c843',
    url: `${REPO}/commit/${HASH}`,
  });
});

test('entries: no scope, issue references, markdown in the summary, several commits', () => {
  assert.deepEqual(parseEntry(`plain summary ([c82c843](${REPO}/commit/${HASH}))`), {
    scope: null,
    text: 'plain summary',
    commit: 'c82c843',
    url: `${REPO}/commit/${HASH}`,
  });
  const e = parseEntry(`**game:** use \`Esc\` and [docs](https://example.com) (sidebar) ([c82c843](${REPO}/commit/${HASH})), closes [#12](${REPO}/issues/12) [#13](${REPO}/issues/13)`);
  assert.equal(e.scope, 'game');
  assert.equal(e.text, 'use Esc and docs (sidebar)');
  assert.deepEqual(e.refs, [
    { label: '#12', url: `${REPO}/issues/12` },
    { label: '#13', url: `${REPO}/issues/13` },
  ]);
  const two = parseEntry(`**engine:** one fix ([aaaaaaa](${REPO}/commit/aaaaaaa1)), ([bbbbbbb](${REPO}/commit/bbbbbbb2))`);
  assert.equal(two.commit, 'aaaaaaa');
  assert.deepEqual(two.refs, [{ label: 'bbbbbbb', url: `${REPO}/commit/bbbbbbb2` }]);
  assert.deepEqual(parseEntry('**repo:** no link at all'), { scope: 'repo', text: 'no link at all', commit: null, url: null });
  // Only https links are kept: a plain http, javascript: or relative link never reaches the page.
  const odd = parseEntry('**game:** odd ([c82c843](http://example.com/commit/c82c843)), [x](/relative) [y](javascript:void)');
  assert.equal(odd.text, 'odd');
  assert.equal(odd.commit, 'c82c843');
  assert.equal(odd.url, null);
  assert.equal(odd.refs, undefined);
});

test('headings: first release without compare link, ### patch releases, prerelease, no date, CRLF', () => {
  const md = [
    '# Changelog',
    '',
    '### [1.0.1](https://github.com/o/r/compare/v1.0.0...v1.0.1) (2026-02-02)',
    '',
    '### Bug Fixes',
    '',
    '* **server:** patch ([1111111](https://github.com/o/r/commit/1111111))',
    '',
    '## [1.1.0-beta.2](https://github.com/o/r/compare/v1.0.1...v1.1.0-beta.2) (2026-03-01)',
    '',
    '### Features',
    '',
    '* **game:** beta ([2222222](https://github.com/o/r/commit/2222222))',
    '',
    '## 1.0.0 (2026-01-01)',
    '',
    '### Features',
    '',
    '* **engine:** first ([3333333](https://github.com/o/r/commit/3333333))',
    '',
    '## v0.9.0',
    '',
    '* loose bullet without section ([4444444](https://github.com/o/r/commit/4444444))',
  ].join('\r\n');
  const releases = parseChangelog(md);
  assert.deepEqual(
    releases.map((r) => [r.version, r.date, r.compareUrl]),
    [
      ['1.1.0-beta.2', '2026-03-01', 'https://github.com/o/r/compare/v1.0.1...v1.1.0-beta.2'],
      ['1.0.1', '2026-02-02', 'https://github.com/o/r/compare/v1.0.0...v1.0.1'],
      ['1.0.0', '2026-01-01', null],
      ['0.9.0', null, null],
    ],
  );
  assert.equal(releases[1].sections[0].entries[0].text, 'patch');
  assert.deepEqual(releases[3].sections, [
    { type: 'other', title: 'Changes', entries: [{ scope: null, text: 'loose bullet without section', commit: '4444444', url: 'https://github.com/o/r/commit/4444444' }] },
  ]);
});

test('breaking changes: decorated title, indented continuation lines', () => {
  const md = [
    '## [2.0.0](https://github.com/o/r/compare/v1.0.0...v2.0.0) (2026-05-05)',
    '',
    '',
    '### ⚠ BREAKING CHANGES',
    '',
    '* **protocol:** orders carry a version field.',
    '  Old clients cannot join new games.',
    '',
    '### Features',
    '',
    '* **protocol:** version orders ([5555555](https://github.com/o/r/commit/5555555))',
    '',
    '### Performance Improvements',
    '',
    '* faster paths ([6666666](https://github.com/o/r/commit/6666666))',
    '',
    '### Something Custom',
    '',
    '* custom ([7777777](https://github.com/o/r/commit/7777777))',
  ].join('\n');
  const [r] = parseChangelog(md);
  assert.deepEqual(
    r.sections.map((s) => [s.type, s.title, s.entries.length]),
    [
      ['breaking', 'Breaking changes', 1],
      ['features', 'Features', 1],
      ['performance', 'Performance Improvements', 1],
      ['something-custom', 'Something Custom', 1],
    ],
  );
  assert.equal(r.sections[0].entries[0].text, 'orders carry a version field. Old clients cannot join new games.');
  assert.equal(r.sections[0].entries[0].commit, null);
});

test('robustness: empty input, releases without entries, duplicated versions, stray text', () => {
  assert.deepEqual(parseChangelog(''), []);
  assert.deepEqual(parseChangelog('# Changelog\n\nNothing released yet.\n'), []);
  const md = [
    '## [1.2.0](https://github.com/o/r/compare/v1.1.0...v1.2.0) (2026-06-01)',
    '',
    'Some paragraph release-please never writes.',
    '',
    '## [1.1.0](https://github.com/o/r/compare/v1.0.0...v1.1.0) (2026-05-01)',
    '### Features',
    '* **game:** kept ([1111111](https://github.com/o/r/commit/1111111))',
    '## [1.1.0](https://github.com/o/r/compare/v1.0.0...v1.1.0) (2026-05-01)',
    '### Features',
    '* **game:** duplicate ([2222222](https://github.com/o/r/commit/2222222))',
    '* ',
  ].join('\n');
  const releases = parseChangelog(md);
  assert.deepEqual(
    releases.map((r) => [r.version, r.sections.length]),
    [
      ['1.2.0', 0],
      ['1.1.0', 1],
    ],
  );
  assert.deepEqual(
    releases[1].sections[0].entries.map((e) => e.text),
    ['kept'],
  );
});

test('releases sort newest first even when the file is out of order', () => {
  const md = ['## 0.10.0 (2026-01-03)', '## 0.9.0 (2026-01-02)', '## 0.11.0-rc.1 (2026-01-04)', '## 0.11.0 (2026-01-05)'].join('\n');
  assert.deepEqual(
    parseChangelog(md).map((r) => r.version),
    ['0.11.0', '0.11.0-rc.1', '0.10.0', '0.9.0'],
  );
});

test('buildReleaseNotes caps the release count and names every scope it uses', () => {
  const md = Array.from({ length: 40 }, (_, i) => `## 1.${40 - i}.0 (2026-01-01)\n### Features\n* **${i % 2 ? 'server' : 'custom'}:** item ${i} ([1111111](https://github.com/o/r/commit/1111111))`).join('\n');
  const doc = buildReleaseNotes(md);
  assert.equal(doc.schema, SCHEMA);
  assert.equal(doc.releases.length, DEFAULT_LIMIT);
  assert.equal(doc.releases[0].version, '1.40.0');
  assert.deepEqual(doc.scopes, { custom: 'Custom', server: 'Online' });
  assert.equal(buildReleaseNotes(md, { limit: 3 }).releases.length, 3);
});

test('writeReleaseNotes: compact JSON from the real changelog that the game accepts unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-notes-'));
  try {
    const out = join(dir, 'release-notes.json');
    writeReleaseNotes(join(root, 'CHANGELOG.md'), out);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.endsWith('}\n') && !text.includes('\n  '), 'compact, one line');
    assert.ok(text.length < 512 * 1024, `small enough to load on every start: ${text.length} bytes`);
    const doc = JSON.parse(text);
    assert.equal(doc.schema, SCHEMA);
    assert.equal(doc.releases[0].version, PACKAGE_VERSION);
    assert.equal(doc.scopes.server, 'Online');
    assert.equal(doc.scopes.editor, 'Map editor');
    // The game's sanitizer keeps everything the build writes.
    const clean = sanitizeNotes(doc);
    const count = (d) => d.releases.reduce((n, r) => n + r.sections.reduce((m, s) => m + s.entries.length, 0), 0);
    assert.equal(count(clean), count(doc));
    assert.equal(count(doc), bullets(CHANGELOG).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReleaseNotes overwrites an older file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-notes-'));
  try {
    const src = join(dir, 'CHANGELOG.md');
    const out = join(dir, 'release-notes.json');
    writeFileSync(out, 'stale');
    writeFileSync(src, '## 1.0.0 (2026-01-01)\n### Features\n* one ([1111111](https://github.com/o/r/commit/1111111))\n');
    writeReleaseNotes(src, out);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).releases[0].sections[0].entries[0].text, 'one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
