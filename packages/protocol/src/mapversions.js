// Map format versions (docs/contracts.md section 2, "Map versions"): the
// version every map file carries, the migrations that upgrade older maps to
// the current format, and what players are told when that is not possible.
//
// This is the one place every reader uses: the game, the map editor, the
// server and the tools run upgradeMap (through validateMap and parseMap in
// map.js) before they validate, hash or hand a map to the engine, which reads
// the current format only (engine/src/mapdata.rs FORMAT_VERSION). Migrations
// are pure and deterministic, so every browser and the server turn the same
// old file into the same map, byte for byte.
//
// Adding a format version (a rename or rewrite that changes what old maps
// mean): bump MAP_FORMAT_VERSION here and FORMAT_VERSION in the engine, add
// the migration from the previous version to MAP_MIGRATIONS (built from the
// helpers below), add the version to MAP_FORMAT_HISTORY and set `lastGame`
// of the one before, and add a fixture pair for the old version under
// packages/protocol/test/fixtures/maps/. test/mapversions.test.mjs refuses
// a bump without all of them.

import { decodeBase64, encodeBase64 } from './base64.js';
import { isPlainObject } from './check.js';

/** The map format version this release reads and writes. */
export const MAP_FORMAT_VERSION = 1;
/** Largest `formatVersion` a file may name (newer than ours is still a clean refusal). */
export const MAP_FORMAT_VERSION_MAX = 65535;
/** `gameVersion` values (the engine checks the same rule). */
export const GAME_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/** The non-blocking notice shown after an automatic upgrade. */
export const MAP_UPGRADED_NOTICE = 'This map was upgraded from an older version; save it in the editor to keep the upgrade.';

/**
 * Every format version, oldest first. `lastGame` is the last WebRA release
 * (major.minor) that wrote the version: set it when the next version comes,
 * so messages about files without `gameVersion` can still name a release.
 */
export const MAP_FORMAT_HISTORY = Object.freeze([
  Object.freeze({
    version: 1,
    lastGame: null,
    summary: 'The baseline: every map from before map versions (a file without formatVersion is format 1).',
  }),
]);

/**
 * Migrations, one per version step: `{ from, to: from + 1, summary,
 * migrate(map, ctx) }`. `migrate` changes the map it is given (a private
 * copy of the file at version `from`) or returns a replacement, using the
 * helpers below; it reports what it changed with `ctx.note(text)` and what
 * it cannot decide with `ctx.problem(...)`. It must not depend on anything
 * but its input (no clock, no randomness, no engine).
 */
export const MAP_MIGRATIONS = Object.freeze([]);

/** The registry upgradeMap uses by default (tests pass their own). */
export const MAP_VERSIONS = Object.freeze({ current: MAP_FORMAT_VERSION, history: MAP_FORMAT_HISTORY, migrations: MAP_MIGRATIONS });

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The format version a parsed map names (absent means 1), or null when `formatVersion` is malformed. */
export function mapFormatVersionOf(input) {
  if (!isPlainObject(input)) return null;
  const v = input.formatVersion;
  if (v === undefined) return 1;
  return Number.isSafeInteger(v) && v >= 1 && v <= MAP_FORMAT_VERSION_MAX ? v : null;
}

/** "0.9" for messages: the file's `gameVersion`, else the last release of its format (history), else null. */
export function mapMadeFor(version, gameVersion, versions = MAP_VERSIONS) {
  const m = typeof gameVersion === 'string' ? /^(\d+)\.(\d+)/.exec(gameVersion) : null;
  if (m) return `${Number(m[1])}.${Number(m[2])}`;
  return versions.history.find((h) => h.version === version)?.lastGame ?? null;
}

/** Why an older map cannot be upgraded automatically. */
export function incompatibleMapMessage(version, gameVersion = null, versions = MAP_VERSIONS) {
  const game = mapMadeFor(version, gameVersion, versions);
  return (
    `This map was made for ${game ? `WebRA ${game}` : 'an older version of WebRA'} (format ${version}) and is no longer compatible with this version. ` +
    'Open it in the map editor and save it again.'
  );
}

/** Why a map from a newer release cannot be read. */
export function newerMapMessage(version, gameVersion = null, versions = MAP_VERSIONS) {
  const game = mapMadeFor(version, gameVersion, versions);
  return `This map was made with a newer version of WebRA (${game ? `${game}, ` : ''}format ${version}; this version reads format ${versions.current}). Update the game to play it.`;
}

/**
 * Upgrade a parsed map file to the current format. Pure: the input is not
 * changed. Returns
 * `{ status, ok, from, to, gameVersion, map, notes, problems, message, errors }`:
 *
 * - `current`: already the current format (`map` is a copy of the input);
 * - `upgraded`: migrated from `from` (`message` is MAP_UPGRADED_NOTICE);
 * - `incompatible`: a migration met something it cannot decide (`problems`,
 *   each with a location where it has one and quick fixes); `map` is the best
 *   effort for the map editor, never for a game;
 * - `newer`: made by a newer release (`map` is null);
 * - `invalid`: not a map object, or a malformed `formatVersion`/`gameVersion` (`errors`).
 *
 * `ok` is true for `current` and `upgraded`. The result still has to pass
 * validateMap and the engine's checks.
 */
export function upgradeMap(input, versions = MAP_VERSIONS) {
  const result = (status, extra) => ({
    status,
    ok: status === 'current' || status === 'upgraded',
    from: null,
    to: versions.current,
    gameVersion: null,
    map: null,
    notes: [],
    problems: [],
    message: null,
    errors: [],
    ...extra,
  });
  if (!isPlainObject(input)) return result('invalid', { errors: ['map must be a JSON object'] });
  const from = mapFormatVersionOf(input);
  if (from === null) return result('invalid', { errors: [`formatVersion must be a whole number from 1 to ${MAP_FORMAT_VERSION_MAX}`] });
  const gameVersion = input.gameVersion ?? null;
  if (gameVersion !== null && (typeof gameVersion !== 'string' || !GAME_VERSION_RE.test(gameVersion))) {
    return result('invalid', { from, errors: ['gameVersion must be a version such as 0.9.0'] });
  }
  if (from > versions.current) {
    return result('newer', { from, gameVersion, message: newerMapMessage(from, gameVersion, versions) });
  }
  let map = clone(input);
  const notes = [];
  const problems = [];
  const ctx = {
    version: from,
    note: (text) => notes.push(String(text)),
    problem: (p) => problems.push({ version: ctx.version, fixes: [], ...p }),
  };
  for (let v = from; v < versions.current; v++) {
    const step = versions.migrations.find((m) => m.from === v);
    // A gap is a bug in this registry (the tests refuse it), never the file's fault.
    if (!step || step.to !== v + 1) throw new Error(`no map migration from format ${v} to ${v + 1}`);
    ctx.version = step.to;
    const out = step.migrate(map, ctx);
    if (out !== undefined) map = out;
    if (!isPlainObject(map)) throw new Error(`the map migration to format ${step.to} returned no map`);
    map.formatVersion = step.to;
  }
  if (problems.length) {
    return result('incompatible', { from, gameVersion, map, notes, problems, message: incompatibleMapMessage(from, gameVersion, versions) });
  }
  if (from < versions.current) return result('upgraded', { from, gameVersion, map, notes, message: MAP_UPGRADED_NOTICE });
  return result('current', { from, gameVersion, map });
}

// ---- Paths -------------------------------------------------------------------------
// Fields are named by key arrays (`['rules', 'actors', 'T01.Husk', 'cost']`):
// rule ids and fields may contain dots.

/** The value at `path`, or undefined. */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Set `path` (creating objects on the way); `undefined` deletes it and prunes emptied objects. */
export function setPath(obj, path, value) {
  if (!path.length) return;
  const parents = [obj];
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (!isPlainObject(cur[k])) {
      if (value === undefined) return;
      cur[k] = {};
    }
    cur = cur[k];
    parents.push(cur);
  }
  const last = path[path.length - 1];
  if (value !== undefined) {
    cur[last] = value;
    return;
  }
  delete cur[last];
  // Drop objects the deletion emptied, but never the map itself.
  for (let i = parents.length - 1; i >= 1; i--) {
    if (Object.keys(parents[i]).length) break;
    delete parents[i - 1][path[i - 1]];
  }
}

const pathText = (path) => path.join('.');

// ---- Migration helpers ---------------------------------------------------------------
// The kinds of change a format version may make. Each changes `map` in
// place, notes what it did and reports what needs the author.

/**
 * Actor ids that changed (one format version's alias table, ids matched
 * case-insensitively like the engine): `{ OLD: 'NEW' }` renames,
 * `{ OLD: null }` removed without a replacement, `{ OLD: ['A', 'B'] }`
 * split into several (the author picks). Applies to pre-placed actors and to
 * `rules.actors` overrides.
 */
export function renameActors(map, aliases, ctx) {
  const table = new Map(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v]));
  const renamed = new Map();
  const open = new Map();
  for (const a of Array.isArray(map.actors) ? map.actors : []) {
    if (!isPlainObject(a) || typeof a.type !== 'string') continue;
    const to = table.get(a.type.toLowerCase());
    if (to === undefined) continue;
    if (typeof to === 'string') {
      const key = `${a.type} to ${to}`;
      renamed.set(key, (renamed.get(key) ?? 0) + 1);
      a.type = to;
    } else {
      if (!open.has(a.type)) open.set(a.type, { choices: Array.isArray(to) ? to : [], at: [] });
      open.get(a.type).at.push({ type: a.type, x: a.x, y: a.y });
    }
  }
  for (const [key, n] of renamed) ctx.note(`Renamed ${n} actor${n === 1 ? '' : 's'} from ${key}.`);
  for (const [type, { choices, at }] of open) {
    const first = at[0];
    const what = `${at.length} ${type} actor${at.length === 1 ? '' : 's'}`;
    ctx.problem({
      code: choices.length ? 'actor-split' : 'actor-removed',
      message: choices.length
        ? `${what}: ${type} was replaced by ${choices.join(' or ')} in format ${ctx.version}; pick one.`
        : `${what}: ${type} was removed in format ${ctx.version}.`,
      x: first.x,
      y: first.y,
      at: at.map(({ x, y }) => [x, y]),
      fixes: [
        ...choices.map((c) => ({ label: `Replace with ${c}`, action: { kind: 'setActorType', match: at, type: c } })),
        { label: `Remove ${at.length === 1 ? 'the actor' : `all ${at.length}`}`, action: { kind: 'removeActors', match: at } },
      ],
    });
  }
  const overrides = getPath(map, ['rules', 'actors']);
  if (!isPlainObject(overrides)) return;
  for (const id of Object.keys(overrides)) {
    const to = table.get(id.toLowerCase());
    if (to === undefined) continue;
    const from = ['rules', 'actors', id];
    if (typeof to === 'string') {
      const target = Object.keys(overrides).find((k) => k !== id && k.toLowerCase() === to.toLowerCase());
      if (target === undefined) {
        moveOverride(overrides, id, to);
        ctx.note(`Moved the rules override of ${id} to ${to}.`);
        continue;
      }
      ctx.problem({
        code: 'rules-conflict',
        message: `rules.actors has overrides for both ${id} and ${target}, which are one actor (${to}) since format ${ctx.version}.`,
        path: from,
        fixes: [
          { label: `Keep the ${id} override`, action: { kind: 'moveField', from, to: ['rules', 'actors', target] } },
          { label: `Keep the ${target} override`, action: { kind: 'setField', path: from } },
        ],
      });
      continue;
    }
    const choices = Array.isArray(to) ? to : [];
    ctx.problem({
      code: choices.length ? 'rules-split' : 'rules-removed',
      message: choices.length
        ? `rules.actors.${id}: ${id} was replaced by ${choices.join(' or ')} in format ${ctx.version}; pick where its override goes.`
        : `rules.actors.${id}: ${id} was removed in format ${ctx.version}, so its override cannot apply.`,
      path: from,
      fixes: [
        ...choices.map((c) => ({ label: `Apply it to ${c}`, action: { kind: 'moveField', from, to: ['rules', 'actors', c] } })),
        { label: 'Drop the override', action: { kind: 'setField', path: from } },
      ],
    });
  }
}

/** Rename an override key in place, keeping the key order (the canonical form sorts anyway). */
function moveOverride(obj, from, to) {
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k === from ? to : k] = v;
}

/**
 * Terrain codes that changed: `{ old: new }`, or `{ old: { fallback,
 * choices, reason } }` when no single code fits (a code removed or split):
 * those cells get `fallback`, and the author confirms it or picks another
 * choice. `names` (code to name) only makes the messages readable.
 */
export function remapTerrain(map, table, ctx, names = []) {
  const name = (t) => names[t] ?? `terrain ${t}`;
  if (!Number.isSafeInteger(map.width) || map.width < 1) return;
  let cells;
  try {
    cells = decodeBase64(map.terrain, 'terrain');
  } catch {
    return; // Undecodable layers are validateMap's to report.
  }
  const counts = new Map();
  const open = new Map();
  for (let i = 0; i < cells.length; i++) {
    const rule = table[cells[i]];
    if (rule === undefined) continue;
    const old = cells[i];
    if (typeof rule === 'number') {
      cells[i] = rule;
      counts.set(old, (counts.get(old) ?? 0) + 1);
    } else {
      cells[i] = rule.fallback;
      if (!open.has(old)) open.set(old, []);
      open.get(old).push([i % map.width, Math.floor(i / map.width)]);
    }
  }
  map.terrain = encodeBase64(cells);
  for (const [old, n] of counts) ctx.note(`Changed ${n} cell${n === 1 ? '' : 's'} of ${name(old)} to ${name(table[old])}.`);
  for (const [old, at] of open) {
    const rule = table[old];
    ctx.problem({
      code: 'terrain-changed',
      message:
        `${at.length} cell${at.length === 1 ? '' : 's'} of ${name(old)}: ${rule.reason ?? `${name(old)} changed in format ${ctx.version}`}. ` +
        `They are ${name(rule.fallback)} now; check them.`,
      x: at[0][0],
      y: at[0][1],
      at,
      fixes: [
        { label: `Keep ${name(rule.fallback)}`, action: { kind: 'accept' } },
        ...(rule.choices ?? []).filter((c) => c !== rule.fallback).map((c) => ({ label: `Use ${name(c)}`, action: { kind: 'setTerrain', cells: at, value: c } })),
      ],
    });
  }
}

/** A field that moved (`from` and `to` are key arrays). Both set and different: the author picks. */
export function moveField(map, from, to, ctx) {
  const value = getPath(map, from);
  if (value === undefined) return;
  const there = getPath(map, to);
  if (there === undefined || JSON.stringify(there) === JSON.stringify(value)) {
    setPath(map, from, undefined);
    setPath(map, to, value);
    ctx.note(`Moved ${pathText(from)} to ${pathText(to)}.`);
    return;
  }
  ctx.problem({
    code: 'field-conflict',
    message: `${pathText(from)} moved to ${pathText(to)} in format ${ctx.version}, and the map has both with different values.`,
    path: to,
    fixes: [
      { label: `Keep ${pathText(from)}`, action: { kind: 'moveField', from, to } },
      { label: `Keep ${pathText(to)}`, action: { kind: 'setField', path: from } },
    ],
  });
}

/** A new required field: maps without it get `value`. */
export function addField(map, path, value, ctx) {
  if (getPath(map, path) !== undefined) return;
  setPath(map, path, clone(value));
  ctx.note(`Added ${pathText(path)} (${JSON.stringify(value)}).`);
}

/**
 * Renamed or removed fields of rules overrides (`section`: actors or
 * weapons): `[[fromPath, toPath], [fromPath, null]]`, paths inside one
 * entry's override (`['unit', 'speed']`).
 */
export function renameRuleFields(map, section, renames, ctx) {
  const entries = getPath(map, ['rules', section]);
  if (!isPlainObject(entries)) return;
  for (const id of Object.keys(entries)) {
    for (const [from, to] of renames) {
      const at = ['rules', section, id];
      if (getPath(entries[id], from) === undefined) continue;
      if (to === null) {
        ctx.problem({
          code: 'rules-field-removed',
          message: `rules.${section}.${id}.${pathText(from)} was removed in format ${ctx.version}, so this override cannot apply.`,
          path: [...at, ...from],
          fixes: [{ label: 'Drop the override', action: { kind: 'setField', path: [...at, ...from] } }],
        });
        continue;
      }
      moveField(map, [...at, ...from], [...at, ...to], ctx);
    }
  }
}

/**
 * Renamed values of a field (an option such as `biome`): `{ old: 'new' }`,
 * `{ old: null }` for a value that is gone (the author picks one of
 * `choices`, or the field is dropped back to its default).
 */
export function renameValues(map, path, table, ctx, choices = []) {
  const v = getPath(map, path);
  if (typeof v !== 'string' || !Object.hasOwn(table, v)) return;
  const to = table[v];
  if (typeof to === 'string') {
    setPath(map, path, to);
    ctx.note(`Changed ${pathText(path)} from ${v} to ${to}.`);
    return;
  }
  ctx.problem({
    code: 'value-removed',
    message: `${pathText(path)} "${v}" was removed in format ${ctx.version}.`,
    path,
    fixes: [
      ...choices.map((c) => ({ label: `Use ${c}`, action: { kind: 'setField', path, value: c } })),
      { label: 'Use the default', action: { kind: 'setField', path } },
    ],
  });
}

// ---- Quick fixes ---------------------------------------------------------------------

const sameActor = (a, m) => isPlainObject(a) && typeof a.type === 'string' && a.type.toLowerCase() === String(m.type).toLowerCase() && a.x === m.x && a.y === m.y;

/**
 * Apply one quick fix (`problem.fixes[i].action`) to a map. Pure: returns
 * the changed copy. Actions name actors by type and cell and fields by key
 * path, so they stay right after other fixes changed the map.
 */
export function applyMapFix(map, action) {
  const out = clone(map);
  switch (action?.kind) {
    case 'accept':
      break;
    case 'removeActors':
      out.actors = (Array.isArray(out.actors) ? out.actors : []).filter((a) => !action.match.some((m) => sameActor(a, m)));
      break;
    case 'setActorType':
      for (const a of Array.isArray(out.actors) ? out.actors : []) if (action.match.some((m) => sameActor(a, m))) a.type = action.type;
      break;
    case 'setTerrain': {
      const cells = decodeBase64(out.terrain, 'terrain');
      for (const [x, y] of action.cells) {
        if (x >= 0 && y >= 0 && x < out.width && y < out.height) cells[y * out.width + x] = action.value;
      }
      out.terrain = encodeBase64(cells);
      break;
    }
    case 'setField':
      setPath(out, action.path, clone(action.value));
      break;
    case 'moveField': {
      const value = getPath(out, action.from);
      setPath(out, action.from, undefined);
      setPath(out, action.to, value);
      break;
    }
    default:
      throw new Error(`unknown map fix ${action?.kind}`);
  }
  return out;
}
