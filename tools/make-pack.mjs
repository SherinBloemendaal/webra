#!/usr/bin/env node
// Build a WebRA texture pack from a folder (docs/texture-packs.md):
//
//   node tools/make-pack.mjs <folder> [out.webrapack]
//
// The folder holds manifest.json and the PNG images and OGG, WAV or MP3
// sounds it names (LICENSE, README and other .txt or .md files are packed
// too). The manifest is checked with the game's own validator, the archive
// is written (deflate) and then read back exactly as the game reads a pack,
// so a pack this tool accepts installs in the game.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { MANIFEST, readPack, validateManifest, PackError } from '../apps/game/js/content/packs.js';
import { crc32 } from '../apps/game/js/oramap/zip.js';

/** A ZIP archive of `entries` ({ name, data }), deflated, UTF-8 names. */
export function writeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = enc.encode(name);
    const packed = new Uint8Array(deflateRawSync(data, { level: 9 }));
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const cen = new Uint8Array(46 + n.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cen.set(n, 46);
    parts.push(local, packed);
    central.push(cen);
    offset += local.length + packed.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Files under `dir`, as pack paths with forward slashes. */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  })(dir);
  return out;
}

/**
 * Build a pack from `dir`: returns `{ bytes, manifest, warnings }` or throws
 * PackError with every problem found.
 */
export async function makePack(dir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
  } catch (err) {
    throw new PackError(`${MANIFEST}: ${err.message}`);
  }
  const { manifest, errors, files } = validateManifest(raw);
  if (!manifest) throw new PackError(errors.join('; '));
  const present = new Set(listFiles(dir));
  const missing = files.filter((f) => !present.has(f));
  if (missing.length) throw new PackError(`missing files: ${missing.join(', ')}`);
  const extras = [...present].filter((f) => /\.(txt|md)$/i.test(f) && !files.includes(f));
  const entries = [{ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(raw, null, 2)) }];
  for (const f of [...files, ...extras]) entries.push({ name: f, data: new Uint8Array(readFileSync(join(dir, f))) });
  const bytes = writeZip(entries);
  // Read it back as the game does: size limits, image headers and sheet sizes, sound signatures.
  const pack = await readPack(bytes);
  return { bytes, manifest: pack.manifest, warnings: pack.warnings };
}

async function main(argv) {
  const [dir, out] = argv;
  if (!dir) {
    console.error('usage: node tools/make-pack.mjs <folder> [out.webrapack]');
    return 2;
  }
  try {
    const { bytes, manifest } = await makePack(dir);
    const file = out ?? `${basename(dir.replace(/[\\/]+$/, '')) || 'pack'}.webrapack`;
    writeFileSync(file, bytes);
    console.log(`wrote ${file}: ${manifest.name} ${manifest.version} by ${manifest.author} (${manifest.license}), ${bytes.length} bytes`);
    return 0;
  } catch (err) {
    console.error(err instanceof PackError ? `not a valid pack: ${err.message}` : err);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
