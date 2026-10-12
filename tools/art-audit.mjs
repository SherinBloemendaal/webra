// The original art audit (apps/game/js/content/audit.js) on your own copy of
// Red Alert: for every actor and special sprite, whether WebRA draws it with
// OpenRA's sequence, falls back to its own art, maps a wrong sequence, has
// no way to show it yet (gap) or Red Alert has no art for it (webra-only).
// Reads MIX archives (nested ones too) and loose files from the paths given,
// in memory only: nothing is written or uploaded. Give it Red Alert's files,
// not OpenRA's mods/ra/bits: an OpenRA-made file found among them is
// reported as wrong (the tables would leave out art the player has).
//
//   npm run build:wasm
//   node tools/art-audit.mjs <file or directory>... [--tileset TEMPERAT|SNOW|DESERT] [--only wrong,fallback]
//
// Exits with 1 when a row is wrong or falls back.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const root = new URL('../apps/game/', import.meta.url);
const { initSync, Game } = await import(new URL('pkg/webra_sim.js', root));
const { MixArchive, bytesSource } = await import(new URL('js/audio/mix.js', root));
const { ARCHIVES } = await import(new URL('js/content/install.js', root));
const { GRAPHICS_FILES, SEQUENCES, ACTOR_PALETTE } = await import(new URL('js/content/tables.js', root));
const { auditOriginalArt, formatAudit, withMissionActors } = await import(new URL('js/content/audit.js', root));
const { OPENRA_MADE_FILES } = await import(new URL('js/content/render-facts.js', root));

const args = process.argv.slice(2);
const option = (name) => {
  const k = args.indexOf(name);
  if (k < 0) return null;
  const v = args[k + 1];
  args.splice(k, 2);
  return v;
};
const tileset = option('--tileset') ?? 'TEMPERAT';
const only = option('--only')?.split(',') ?? null;
if (!args.length) {
  console.error('usage: node tools/art-audit.mjs <file or directory>... [--tileset TEMPERAT] [--only wrong,fallback]');
  process.exit(2);
}

// Every file a sequence names (the audit also checks sequences the game does not install yet),
// and OpenRA's own files, which Red Alert should not have.
const wanted = new Set([ACTOR_PALETTE, ...GRAPHICS_FILES, ...Object.keys(OPENRA_MADE_FILES)]);
wanted.delete(''); // a tileset without an original file (SequenceDef tilesets)
for (const seqs of Object.values(SEQUENCES)) {
  for (const def of Object.values(seqs)) {
    wanted.add(def.file);
    for (const f of Object.values(def.tilesets ?? {})) wanted.add(f);
  }
}

const found = new Map();
async function scanMix(bytes, depth) {
  let archive;
  try {
    archive = await MixArchive.open(bytesSource(bytes));
  } catch {
    return false;
  }
  for (const name of wanted) if (!found.has(name) && archive.has(name)) found.set(name, await archive.read(name));
  if (depth < 3) {
    for (const nested of ARCHIVES) {
      if (archive.has(nested)) await scanMix(await archive.read(nested), depth + 1);
    }
  }
  return true;
}
async function scanPath(path) {
  if (statSync(path).isDirectory()) {
    for (const f of readdirSync(path)) await scanPath(join(path, f));
    return;
  }
  const name = basename(path).toLowerCase();
  const bytes = new Uint8Array(readFileSync(path));
  if (name.endsWith('.mix')) await scanMix(bytes, 0);
  else if (wanted.has(name) && !found.has(name)) found.set(name, bytes);
}
for (const p of args) await scanPath(p);

initSync({ module: readFileSync(new URL('pkg/webra_sim_bg.wasm', root)) });
const actors = withMissionActors(JSON.parse(new Game(7, 'england', 'russia', 64).rules_json()).actors);
const result = auditOriginalArt(actors, (n) => found.get(n) ?? null, { tileset });
console.log(formatAudit(result, { only }));
const missing = [...wanted].filter((n) => !found.has(n) && !(n in OPENRA_MADE_FILES));
if (missing.length) console.log(`\nNot found in what you gave (${missing.length}): ${missing.sort().join(' ')}`);
process.exit(result.counts.wrong || result.counts.fallback ? 1 : 0);
