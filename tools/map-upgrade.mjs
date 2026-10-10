#!/usr/bin/env node
// Upgrade WebRA map files to the current map format version in bulk and
// report the ones that need an author (docs/contracts.md section 2, "Map
// versions"):
//
//   node tools/map-upgrade.mjs <files...>              upgrade in place
//   node tools/map-upgrade.mjs --out <dir> <files...>  write the results to <dir>
//   node tools/map-upgrade.mjs --check <files...>      change nothing; exit 1 if any file would change or fails
//   node tools/map-upgrade.mjs --no-engine <files...>  skip the engine's checks
//
// Every file goes through the same upgrade and checks as in the game and on
// the server (packages/protocol upgradeMap and validateMap, then the engine's
// own validation when apps/game/pkg is built). Files that pass are written
// as the map editor saves them (formatVersion and this release's gameVersion
// in front, compact JSON); that includes files from before map versions,
// which gain the explicit version. Files already in the current format with
// a version stay untouched. A file that cannot be upgraded automatically is
// left as it is and listed with each problem, its location and the quick
// fixes the map editor offers. Exit status: 0 all fine, 1 a file failed (or
// --check found work), 2 usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAP_MAX_BYTES, MAP_VERSIONS, incompatibleMapMessage, mapFileJson, mapFormatVersionOf, utf8Length, validateMap } from '../packages/protocol/src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_RULES = JSON.parse(readFileSync(join(ROOT, 'engine', 'rules.json'), 'utf8'));
const ENGINE_WASM = join(ROOT, 'apps', 'game', 'pkg', 'webra_sim_bg.wasm');

/** The engine's map validation (the server's binding), or null when the engine is not built. */
export async function loadJudge() {
  if (!existsSync(ENGINE_WASM)) return null;
  const { engine } = await import('../apps/server/src/engine.js');
  return engine();
}

/** Where a problem is, for the report (" At 4,9 (and 2 more).", " At rules.actors.E1."). */
function where(p) {
  if (Number.isInteger(p.x) && Number.isInteger(p.y)) {
    const more = Array.isArray(p.at) && p.at.length > 1 ? ` (and ${p.at.length - 1} more)` : '';
    return ` At ${p.x},${p.y}${more}.`;
  }
  if (Array.isArray(p.path)) return ` At ${p.path.join('.')}.`;
  return '';
}

/**
 * Upgrade one map file's text. Returns `{ status, text, lines }`: status
 * `current` (nothing to do), `written` (upgraded or given its version;
 * `text` is the new file), `incompatible`, `newer` or `invalid` (`lines`
 * say why and what to do).
 */
export function upgradeFile(source, { versions = MAP_VERSIONS, judge = null } = {}) {
  if (utf8Length(source) > MAP_MAX_BYTES) return { status: 'invalid', lines: ['the file is larger than 1 MiB'] };
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    return { status: 'invalid', lines: ['not valid JSON'] };
  }
  const r = validateMap(raw, { rules: ENGINE_RULES, versions });
  if (!r.ok) {
    if (!r.compat) return { status: 'invalid', lines: r.errors };
    const lines = [r.compat.message];
    for (const p of r.compat.problems) {
      lines.push(`- ${p.message}${where(p)}`);
      if (p.fixes?.length) lines.push(`  quick fixes in the map editor: ${p.fixes.map((f) => f.label).join('; ')}`);
    }
    return { status: r.compat.status, lines };
  }
  if (judge) {
    const v = judge.validateMap(r.canonical);
    if (!v.ok) {
      // A file that only fails after its upgrade is not compatible any more.
      if (r.upgrade) return { status: 'incompatible', lines: [incompatibleMapMessage(r.upgrade.from, r.writtenBy, versions), ...v.errors.map((e) => `- ${e}`)] };
      return { status: 'invalid', lines: v.errors };
    }
  }
  const explicit = mapFormatVersionOf(raw) === versions.current && raw.formatVersion !== undefined && typeof raw.gameVersion === 'string';
  if (!r.upgrade && explicit) return { status: 'current', lines: [] };
  const lines = r.upgrade ? [`upgraded from format ${r.upgrade.from} to ${r.upgrade.to}`, ...r.upgrade.notes.map((n) => `- ${n}`)] : [`format ${versions.current}: version written into the file`];
  return { status: 'written', text: mapFileJson(r.map), lines };
}

/**
 * Upgrade map files (see the file comment). `log` gets the report lines.
 * Returns `{ written, current, failed }` (file paths).
 */
export function upgradeMapFiles(paths, { check = false, out = null, versions = MAP_VERSIONS, judge = null, log = console.log } = {}) {
  const done = { written: [], current: [], failed: [] };
  if (out && !check) mkdirSync(out, { recursive: true });
  for (const path of paths) {
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch (err) {
      log(`failed       ${path}: ${err.message}`);
      done.failed.push(path);
      continue;
    }
    const r = upgradeFile(source, { versions, judge });
    const label = { current: 'current', written: check ? 'would change' : 'upgraded', incompatible: 'incompatible', newer: 'newer', invalid: 'invalid' }[r.status];
    log(`${label.padEnd(12)} ${path}`);
    for (const line of r.lines) log(`             ${line}`);
    if (r.status === 'current') {
      done.current.push(path);
      if (out && !check) writeFileSync(join(out, basename(path)), source);
    } else if (r.status === 'written') {
      done.written.push(path);
      if (!check) writeFileSync(out ? join(out, basename(path)) : path, r.text);
    } else {
      done.failed.push(path);
    }
  }
  log(`${paths.length} file${paths.length === 1 ? '' : 's'}: ${done.written.length} ${check ? 'to change' : 'written'}, ${done.current.length} current, ${done.failed.length} failed`);
  return done;
}

const USAGE = 'usage: node tools/map-upgrade.mjs [--check] [--out <dir>] [--no-engine] <map files...>';

async function main() {
  const args = process.argv.slice(2);
  let check = false;
  let out = null;
  let useEngine = true;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--no-engine') useEngine = false;
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i].startsWith('--')) {
      console.error(USAGE);
      process.exit(2);
    } else paths.push(args[i]);
  }
  if (!paths.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const judge = useEngine ? await loadJudge() : null;
  if (useEngine && !judge) console.log('note: the engine is not built (npm run build:wasm); only the protocol checks ran');
  const done = upgradeMapFiles(paths, { check, out, judge });
  process.exit(done.failed.length || (check && done.written.length) ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
