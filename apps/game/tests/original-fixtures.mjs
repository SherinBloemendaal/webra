// Synthetic original graphics for the tests: every file the sequence tables
// name, each frame a 4x2 picture that spells its own file and frame number
// (js/content/audit.js `identify` reads them back). No Electronic Arts file,
// and nothing made from one, is in the repository.
import { ACTOR_ART, ACTOR_PALETTE, CURSOR_ART, PALETTES, RESOURCES, SEQUENCES, SMUDGES, TERRAIN, TREES } from '../js/content/tables.js';
import { resolveSequence } from '../js/content/sequences.js';
import { decodePalette, paletteLookup, ACTOR_SHADOW } from '../js/content/palette.js';
import { buildShp, buildPal } from './content-fixtures.mjs';

/** Every file a sequence, tree, resource, smudge or theater names, and how many frames each needs. */
export function neededFrames() {
  const need = new Map();
  const want = (file, n) => need.set(file, Math.max(need.get(file) ?? 1, n));
  const defs = [...Object.values(SEQUENCES).flatMap((seqs) => Object.values(seqs)), ...Object.values(TREES), ...RESOURCES.ore, ...RESOURCES.gems, ...[...SMUDGES.scorch, ...SMUDGES.crater].filter(Boolean)];
  for (const def of defs) {
    // OpenRA Combine: each part's listed frames of its file.
    for (const part of def.parts ?? []) {
      for (const file of [part.file, ...Object.values(part.tilesets ?? {})]) want(file, part.frames ? Math.max(...part.frames) + 1 : 1);
    }
    if (def.parts) continue;
    for (const file of [def.file, ...Object.values(def.tilesets ?? {})]) {
      if (def.length === -1) {
        want(file, Math.max((def.start ?? 0) + 3, ...(def.frames ?? []).map((f) => f + 1)));
        continue;
      }
      const r = resolveSequence(def, 4096);
      want(file, Math.max(...r.fileFrames, ...(r.shadowFrames ?? [])) + 1);
    }
  }
  for (const t of Object.values(TERRAIN)) for (const f of t.images) want(f, 1);
  // Bridges are tileset templates per state (one frame per template cell).
  for (const e of Object.values(ACTOR_ART)) {
    for (const rec of Object.values(e.bridge ?? {})) {
      for (const [state, file] of Object.entries(rec)) if (state !== 'size') want(file, rec.size[0] * rec.size[1]);
    }
  }
  for (const c of Object.values(CURSOR_ART)) want(c.file, c.start + c.length);
  return need;
}

/**
 * Palette indices that spell numbers 0..99: clear of every palette's
 * transparent and shadow indices, the 80..95 remap range and the indices an
 * indexed palette shows other colours on (the civilians' clothes), so a
 * frame reads the same in every palette the art is drawn with.
 */
const DIGITS = (() => {
  const taken = new Set([...Array(16).keys()].map((i) => 80 + i));
  for (const p of Object.values(PALETTES)) for (const i of [...(p.transparent ?? []), ...(p.shadow ?? []), ...(p.index ?? [])]) taken.add(i);
  const out = [];
  for (let i = 1; out.length < 100; i++) if (!taken.has(i)) out.push(i);
  return out;
})();
const digit = (v) => DIGITS[v];

/** The bridges' template files (ACTOR_ART bridge): tiles a cell big, as the theaters have them. */
function bridgeFiles() {
  const out = new Set();
  for (const e of Object.values(ACTOR_ART)) {
    for (const rec of Object.values(e.bridge ?? {})) for (const [state, file] of Object.entries(rec)) if (state !== 'size') out.add(file);
  }
  return out;
}

/** World pixels of a template tile. */
const TILE = 24;

/**
 * Synthetic files: frame k of file f is [k % 100, k / 100, f % 100, f / 100]
 * in two rows. Bridge templates have whole tiles (one colour per tile, its
 * frame's first digit): the theater draws them a cell at a time.
 */
export function syntheticFiles() {
  const need = neededFrames();
  const names = [...need.keys()].sort();
  const bridges = bridgeFiles();
  const files = new Map();
  names.forEach((name, f) => {
    if (bridges.has(name)) {
      const tiles = Array.from({ length: need.get(name) }, (_, k) => new Uint8Array(TILE * TILE).fill(digit(k % 100)));
      files.set(name, buildShp(TILE, TILE, tiles));
      return;
    }
    const frames = [];
    for (let k = 0; k < need.get(name); k++) {
      const row = [digit(k % 100), digit(Math.floor(k / 100)), digit(f % 100), digit(Math.floor(f / 100))];
      frames.push(Uint8Array.from([...row, ...row]));
    }
    files.set(name, buildShp(4, 2, frames));
  });
  // Indices 100..199 as unique colours (6-bit: low six bits, then the rest).
  const pal = buildPal((i) => [i & 63, i >> 6, 7]);
  files.set(ACTOR_PALETTE, pal);
  for (const t of Object.values(TERRAIN)) files.set(t.palette, pal);
  return { files, names, pal };
}

/** Names the file and frame an atlas image was cut from (`null` for anything else). */
export function identifier(names, pal) {
  const lookup = paletteLookup(decodePalette(pal), { remap: true, shadow: ACTOR_SHADOW });
  const index = new Map();
  DIGITS.forEach((i, v) => index.set(Array.from(lookup.color.subarray(i * 4, i * 4 + 3)).join(','), v));
  return (img) => {
    if (!img || img.width !== 4 || img.height !== 2) return null;
    const d = [0, 1, 2, 3].map((x) => index.get(Array.from(img.color.subarray(x * 4, x * 4 + 3)).join(',')));
    if (d.some((v) => v === undefined)) return null;
    return { file: names[d[2] + d[3] * 100], frame: d[0] + d[1] * 100 };
  };
}
