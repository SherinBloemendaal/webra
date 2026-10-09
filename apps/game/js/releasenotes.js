// Release notes: the data side, shared by the game's dialog
// (js/releasenotes-dialog.js) and the build (tools/release-notes.mjs).
//
// tools/build-dist.mjs turns CHANGELOG.md (written by release-please) into
// dist/release-notes.json; the game loads it from `../release-notes.json`
// and the website's /changelog page from `/release-notes.json`.
//
// No DOM in this module, so Node tests and the build can import it.

/** Where the build writes the notes, relative to the game's index.html. */
export const RELEASE_NOTES_URL = '../release-notes.json';

/** Settings registry place of the last version whose notes were seen (js/registry.js). */
export const SEEN_SETTING = Object.freeze(['releaseNotes', 'lastSeenVersion']);

/**
 * Conventional Commit scopes as players read them. Several scopes can share a
 * name: the dialog groups by that name. Unknown scopes show capitalized.
 */
export const SCOPE_LABELS = Object.freeze({
  engine: 'Engine',
  sim: 'Engine',
  game: 'Game',
  ui: 'Game',
  audio: 'Sound',
  server: 'Online',
  protocol: 'Online',
  online: 'Online',
  editor: 'Map editor',
  maps: 'Maps',
  rules: 'Game rules',
  website: 'Website',
  security: 'Security',
  docs: 'Documentation',
  contracts: 'Documentation',
  repo: 'Project',
  ci: 'Project',
  deps: 'Project',
  infra: 'Project',
  deploy: 'Project',
});

/** Label of entries without a scope. */
export const GENERAL_LABEL = 'General';

/**
 * Friendly name of a scope: the table above, otherwise the scope itself with a
 * capital first letter. Combined scopes (`game,engine`) name each part once.
 */
export function scopeLabel(scope, labels = SCOPE_LABELS) {
  if (typeof scope !== 'string' || !scope.trim()) return GENERAL_LABEL;
  const names = [];
  for (const part of scope.split(/[,/]/)) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    const name = Object.hasOwn(labels, key) ? labels[key] : key.charAt(0).toUpperCase() + key.slice(1);
    if (!names.includes(name)) names.push(name);
  }
  return names.length ? names.join(', ') : GENERAL_LABEL;
}

/**
 * Entries grouped by friendly scope name, in order of first appearance, with
 * "General" (no scope) last. Returns [{ label, entries }].
 */
export function groupByScope(entries, labels = SCOPE_LABELS) {
  const groups = new Map();
  for (const entry of entries) {
    const label = scopeLabel(entry.scope, labels);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }
  const out = [...groups].map(([label, list]) => ({ label, entries: list }));
  const general = out.findIndex((g) => g.label === GENERAL_LABEL);
  if (general >= 0 && general !== out.length - 1) out.push(...out.splice(general, 1));
  return out;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "0.3.0" from "0.3.0", "v0.3.0" or a build string "0.3.0+abcdef12"; null otherwise. */
export function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const m = VERSION_RE.exec(value.trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ''}`;
}

/**
 * Semantic version order (build metadata ignored): negative when a < b.
 * Unparsable versions sort before every valid one.
 */
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(normalizeVersion(a) ?? '');
  const pb = VERSION_RE.exec(normalizeVersion(b) ?? '');
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  // A pre-release sorts before its release; identifiers compare per semver 11.
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) + (pb[4] ? 1 : 0);
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Check the shape of a release-notes.json document and drop anything that is
 * not as expected, so the UI never renders half-broken data. Returns
 * { releases, scopes } or null when the document is unusable.
 */
export function sanitizeNotes(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.releases)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const httpUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : null);
  const releases = [];
  for (const r of doc.releases) {
    const version = normalizeVersion(r?.version);
    if (!version || !Array.isArray(r.sections)) continue;
    const sections = [];
    for (const s of r.sections) {
      if (!s || !Array.isArray(s.entries) || !str(s.title)) continue;
      const entries = s.entries
        .filter((e) => e && str(e.text))
        .map((e) => ({
          scope: str(e.scope),
          text: e.text,
          commit: typeof e.commit === 'string' && /^[0-9a-f]{7,40}$/.test(e.commit) ? e.commit : null,
          url: httpUrl(e.url),
          refs: Array.isArray(e.refs) ? e.refs.filter((x) => x && str(x.label) && httpUrl(x.url)).map((x) => ({ label: x.label, url: x.url })) : [],
        }));
      if (entries.length) sections.push({ type: str(s.type) ?? 'other', title: s.title, entries });
    }
    releases.push({
      version,
      date: typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
      compareUrl: httpUrl(r.compareUrl),
      sections,
    });
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  const scopes = {};
  if (doc.scopes && typeof doc.scopes === 'object') {
    for (const [k, v] of Object.entries(doc.scopes)) if (str(v)) scopes[k] = v;
  }
  return { releases, scopes: { ...SCOPE_LABELS, ...scopes } };
}

/** "8 Oct 2026" for "2026-10-08" (UTC, so the day never shifts); null for no date. */
export function formatReleaseDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// ---- "What's new" once per version --------------------------------------------

/**
 * Last version whose notes were seen, or null. `registry` is the settings
 * registry (js/registry.js; anything with get(group, key)). Never throws.
 */
export function readSeenVersion(registry) {
  try {
    return normalizeVersion(registry?.get(...SEEN_SETTING) ?? null);
  } catch {
    return null;
  }
}

/** Remember that the notes up to `version` were seen. Never throws. */
export function writeSeenVersion(version, registry) {
  const v = normalizeVersion(version);
  if (!v || !registry) return false;
  try {
    return registry.set(...SEEN_SETTING, v) === v;
  } catch {
    return false;
  }
}

/**
 * Decide whether the "What's new" dialog opens on this load.
 *
 * - `current`: the version of the game that is running (from the engine).
 * - `seen`: the version stored by the last load, or null on a first visit.
 * - `releases`: sanitized releases, newest first.
 *
 * Returns { show, releases, remember }: `releases` are the ones newer than
 * `seen` up to and including `current`, and `remember` is the version to
 * store (null: store nothing, so a later load decides again).
 *
 * A first visit shows nothing (a new player has nothing to catch up on) but
 * remembers the version. A version without notes (a development build, or
 * notes that failed to load) shows nothing and remembers nothing.
 */
export function whatsNew({ current, seen, releases }) {
  const cur = normalizeVersion(current);
  if (!cur || !Array.isArray(releases)) return { show: false, releases: [], remember: null };
  const last = normalizeVersion(seen);
  // Same version, or an older build than one seen before (a stale cache):
  // nothing new, and the newer version stays remembered.
  if (last && compareVersions(cur, last) <= 0) return { show: false, releases: [], remember: null };
  if (!releases.some((r) => compareVersions(r.version, cur) === 0)) return { show: false, releases: [], remember: null };
  if (!last) return { show: false, releases: [], remember: cur };
  const fresh = releases.filter((r) => compareVersions(r.version, last) > 0 && compareVersions(r.version, cur) <= 0);
  return { show: fresh.length > 0, releases: fresh, remember: cur };
}
