// CHANGELOG.md (written by release-please) to release-notes.json, for the
// game's "What's new" dialog and the website's /changelog page.
//
// release-please writes, per release:
//
//   ## [0.3.0](https://github.com/o/r/compare/v0.2.0...v0.3.0) (2026-10-08)
//   ### Features
//   * **scope:** summary ([abc1234](https://github.com/o/r/commit/abc1234...))
//   * summary without scope ([abc1234](...)), closes [#12](https://github.com/o/r/issues/12)
//
// A first release has no compare link (`## 0.1.0 (2026-01-01)`), older
// release-please versions wrote patch releases as `###` headings, and
// "BREAKING CHANGES" notes can continue on indented lines. All of that is
// accepted here; anything else in the file is ignored.
//
// Output (compact JSON, newest release first, at most `limit` releases):
//   { schema: 1, scopes: { scope: label }, releases: [{ version, date,
//     compareUrl, sections: [{ type, title, entries: [{ scope, text, commit
//     (short hash), url (commit page), refs? }] }] }] }

import { readFileSync, writeFileSync } from 'node:fs';
import { SCOPE_LABELS, compareVersions, scopeLabel } from '../apps/game/js/releasenotes.js';

export const SCHEMA = 1;
export const DEFAULT_LIMIT = 30;

// Version heading: "## [1.2.3](url) (date)", "## 1.2.3 (date)", also "###" and
// a leading "v". The date is optional.
const VERSION_HEADING =
  /^#{2,3}[ \t]+(?:\[v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]\(([^()\s]+)\)|v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))(?:[ \t]+\((\d{4}-\d{2}-\d{2})\))?[ \t]*$/;
const SECTION_HEADING = /^###[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const BULLET = /^[*-][ \t]+(.*)$/;
const SCOPED = /^\*\*([^*]+?):\*\*[ \t]*(.*)$/;
const LINK = /\[([^\]]+)\]\(([^()\s]+)\)/g;
const COMMIT_LABEL = /^[0-9a-f]{7,40}$/;

/** release-please section titles (its default changelog-sections) by type. */
const SECTION_TYPES = [
  [/breaking/i, 'breaking', 'Breaking changes'],
  [/^features?$/i, 'features', 'Features'],
  [/^bug fixes$/i, 'fixes', 'Bug Fixes'],
  [/^performance improvements$/i, 'performance', 'Performance Improvements'],
  [/^reverts$/i, 'reverts', 'Reverts'],
  [/^documentation$/i, 'docs', 'Documentation'],
  [/^miscellaneous chores$/i, 'chores', 'Miscellaneous Chores'],
  [/^code refactoring$/i, 'refactor', 'Code Refactoring'],
  [/^tests$/i, 'tests', 'Tests'],
  [/^build system$/i, 'build', 'Build System'],
  [/^continuous integration$/i, 'ci', 'Continuous Integration'],
  [/^styles$/i, 'style', 'Styles'],
];

function sectionType(rawTitle) {
  // Drop decoration such as release-please's warning sign before "BREAKING CHANGES".
  const title = rawTitle.replace(/^[^\p{L}\p{N}]+/u, '').trim() || rawTitle.trim();
  for (const [re, type, label] of SECTION_TYPES) if (re.test(title)) return { type, title: label };
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
  return { type: slug, title };
}

/** Plain text from the little markdown release-please copies from commit subjects. */
function plain(text) {
  return text
    .replace(LINK, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One bullet (continuation lines already joined) as an entry. The first link
 * whose label is a commit hash ends the summary; links after it (more commits,
 * "closes #12") become refs.
 */
export function parseEntry(line) {
  let body = line.trim();
  let scope = null;
  const scoped = SCOPED.exec(body);
  if (scoped) {
    scope = scoped[1].trim() || null;
    body = scoped[2];
  }
  let text = body;
  let commit = null;
  let url = null;
  const refs = [];
  for (const m of body.matchAll(LINK)) {
    const [, label, href] = m;
    if (commit === null && COMMIT_LABEL.test(label)) {
      // Summary ends at the "(" that opens "([hash](url))".
      const before = body.slice(0, m.index).replace(/\(\s*$/, '');
      text = before;
      // The short hash as release-please prints it; the URL holds the full one.
      commit = label;
      url = /^https:\/\//.test(href) ? href : null;
      continue;
    }
    if (commit !== null && /^https:\/\//.test(href)) refs.push({ label: plain(label), url: href });
  }
  const entry = { scope, text: plain(text), commit, url };
  if (refs.length) entry.refs = refs;
  return entry;
}

/**
 * Parse release-please markdown into releases, newest first. Releases without
 * any entries keep an empty `sections` list (release-please writes those for
 * releases made only of hidden commit types).
 */
export function parseChangelog(markdown) {
  const releases = [];
  const seen = new Set();
  let release = null;
  let section = null;
  let entry = null; // raw text of the bullet being read

  const flush = () => {
    if (entry === null || !release) return;
    const parsed = parseEntry(entry);
    entry = null;
    if (!parsed.text) return;
    if (!section) {
      section = { type: 'other', title: 'Changes', entries: [] };
      release.sections.push(section);
    }
    section.entries.push(parsed);
  };

  for (const raw of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const version = VERSION_HEADING.exec(line);
    if (version) {
      flush();
      const v = version[1] ?? version[3];
      section = null;
      if (seen.has(v)) {
        release = null; // a duplicated heading: keep the first (newest) copy
        continue;
      }
      seen.add(v);
      release = { version: v, date: version[4] ?? null, compareUrl: version[2] && /^https:\/\//.test(version[2]) ? version[2] : null, sections: [] };
      releases.push(release);
      continue;
    }
    if (/^#{1,2}[ \t]/.test(line)) {
      // "# Changelog" or another top-level heading: not part of a release.
      flush();
      if (/^##[ \t]/.test(line)) release = null;
      section = null;
      continue;
    }
    if (!release) continue;
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      flush();
      const { type, title } = sectionType(heading[1]);
      section = release.sections.find((s) => s.type === type) ?? null;
      if (!section) {
        section = { type, title, entries: [] };
        release.sections.push(section);
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      entry = bullet[1];
      continue;
    }
    if (entry !== null && /^[ \t]+\S/.test(line)) {
      // An indented line continues the bullet (multi-line breaking change notes).
      entry += ` ${line.trim().replace(/^[*-][ \t]+/, '')}`;
      continue;
    }
    flush();
  }
  flush();
  for (const r of releases) r.sections = r.sections.filter((s) => s.entries.length);
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The release-notes.json document for `markdown`: the newest `limit` releases
 * plus the friendly name of every scope they use.
 */
export function buildReleaseNotes(markdown, { limit = DEFAULT_LIMIT } = {}) {
  const releases = parseChangelog(markdown).slice(0, Math.max(0, limit));
  const scopes = {};
  for (const r of releases) {
    for (const s of r.sections) {
      for (const e of s.entries) {
        if (!e.scope) continue;
        for (const part of e.scope.split(/[,/]/)) {
          const key = part.trim().toLowerCase();
          if (key && !(key in scopes)) scopes[key] = scopeLabel(key, SCOPE_LABELS);
        }
      }
    }
  }
  return { schema: SCHEMA, scopes, releases };
}

/** Read `changelogPath`, write the notes to `outPath`; returns the document. */
export function writeReleaseNotes(changelogPath, outPath, options) {
  const doc = buildReleaseNotes(readFileSync(changelogPath, 'utf8'), options);
  writeFileSync(outPath, `${JSON.stringify(doc)}\n`);
  return doc;
}
