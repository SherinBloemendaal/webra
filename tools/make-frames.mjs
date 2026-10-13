// How many frames the make animations of Red Alert's structures have, read
// from your own copy of Red Alert: OpenRA's `make` sequences say `Length: *`
// (every frame of the file), so the build-up time of each structure
// (tools/gen_rules.py MAKE_FRAMES, the `building.make_ticks` of the rules)
// comes from the files themselves. Reads MIX archives (nested ones too) and
// loose files from the paths given, in memory only, and prints one line per
// make file it finds: its name and its frame count. Nothing else is printed
// or written.
//
//   node tools/make-frames.mjs <file or directory>...

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MixArchive, bytesSource } from '../apps/game/js/audio/mix.js';
import { ARCHIVES } from '../apps/game/js/content/install.js';
import { SEQUENCES } from '../apps/game/js/content/tables.js';
import { decodeSprite } from '../apps/game/js/content/shp.js';
import { RENDER_FACTS } from '../apps/game/js/content/render-facts.js';

/** File extensions of Red Alert's sprites: shapes and the theater variants. */
const EXTENSIONS = ['shp', 'tem', 'sno', 'des', 'int'];

/**
 * The make files: every file (and tileset variant) of a `make` sequence
 * WebRA draws, and `<image>make.<ext>` of every OpenRA image of an actor
 * (render-facts.js), so the make files OpenRA itself ships count as well
 * when they are given.
 */
export function makeFiles() {
  const out = new Set();
  for (const facts of Object.values(RENDER_FACTS)) for (const ext of EXTENSIONS) out.add(`${facts.image}make.${ext}`);
  for (const seqs of Object.values(SEQUENCES)) {
    const def = seqs.make;
    if (!def) continue;
    for (const f of [def.file, ...Object.values(def.tilesets ?? {})]) if (f) out.add(f);
  }
  return out;
}

/**
 * Frame counts of the make files among `sources` ({ name, bytes }: MIX
 * archives, nested ones too, or loose files), as a Map file -> frames,
 * sorted by name. The first copy of a file wins.
 */
export async function countMakeFrames(sources) {
  const wanted = makeFiles();
  const found = new Map();
  const take = (name, bytes) => {
    if (!wanted.has(name) || found.has(name)) return;
    found.set(name, decodeSprite(bytes).frames.length);
  };
  const scanMix = async (bytes, depth) => {
    let archive;
    try {
      archive = await MixArchive.open(bytesSource(bytes));
    } catch {
      return;
    }
    for (const name of wanted) if (!found.has(name) && archive.has(name)) take(name, await archive.read(name));
    if (depth < 3) {
      for (const nested of ARCHIVES) if (archive.has(nested)) await scanMix(await archive.read(nested), depth + 1);
    }
  };
  for (const { name, bytes } of sources) {
    const n = name.toLowerCase();
    if (n.endsWith('.mix')) await scanMix(bytes, 0);
    else take(n, bytes);
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

/** Files under the paths given, as { name, bytes }. */
function readPaths(paths) {
  const out = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) {
      for (const f of readdirSync(path).sort()) walk(join(path, f));
      return;
    }
    out.push({ name: basename(path), bytes: new Uint8Array(readFileSync(path)) });
  };
  for (const p of paths) walk(p);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node tools/make-frames.mjs <file or directory>...');
    process.exit(2);
  }
  const counts = await countMakeFrames(readPaths(args));
  for (const [file, frames] of counts) console.log(`${file}: ${frames} frames`);
}
