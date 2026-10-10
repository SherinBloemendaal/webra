// "Install original Red Alert content", like OpenRA: the player picks files
// from their own copy of Red Alert (the 2008 freeware release or a disc:
// the CD image itself, main.mix and redalert.mix, or the archives inside
// them, or loose files).
// We read them in the browser, keep only what WebRA uses (the sounds of
// js/audio/catalog.js, the graphics of content/tables.js and the movies of
// content/movies.js), check that each file decodes, and store them in this
// browser (content/store.js).
// Nothing is uploaded and nothing is shipped with WebRA.

import { MixArchive, MixError, blobSource } from '../audio/mix.js';
import { IsoImage, IsoError } from './iso.js';
import { looksLikeAud, decodeAud } from '../audio/aud.js';
import { allOriginalNames, ARCHIVES as SOUND_ARCHIVES, EVA, MUSIC_FILES } from '../audio/catalog.js';
import { ACTOR_PALETTE, GRAPHICS_FILES, TERRAIN } from './tables.js';
import { decodeSprite } from './shp.js';
import { decodePalette } from './palette.js';
import { kindOf, storageProblem } from './store.js';
import { openVqa } from './vqa.js';
import { MOVIE_FILES, isMovieName } from './movies.js';
import { openZip, looksLikeZip, ZipError } from '../oramap/zip.js';

const MAX_DEPTH = 3;
/**
 * The archives on a Red Alert CD (OpenRA's ra-content installer, allies95
 * and soviet95: MAIN.MIX holds the game and music archives, scores.mix
 * among them; INSTALL/REDALERT.MIX the interface, speech and cameos).
 */
export const CD_ARCHIVES = Object.freeze(['MAIN.MIX', 'INSTALL/REDALERT.MIX']);
const VOICE_EXT = /\.[vr]0\d$/;
const ANNOUNCER = new Set(Object.values(EVA).flatMap((e) => e.originals));

/**
 * Archives searched inside other archives: the sound archives, plus the
 * graphics ones (units and structures in conquer.mix, cameos in hires.mix,
 * one archive per theater; desert.mix comes from Tiberian Dawn, as in
 * OpenRA), plus the movies (movies1.mix in MAIN.MIX of the Allied disc,
 * movies2.mix of the Soviet disc, as OpenRA's movies-allied and
 * movies-soviet packages). lores.mix is left out: its low resolution cameos
 * share names with the hires ones.
 */
export const ARCHIVES = [
  ...SOUND_ARCHIVES,
  'conquer.mix',
  'hires.mix',
  'hires1.mix',
  'temperat.mix',
  'snow.mix',
  'interior.mix',
  'desert.mix',
  'movies1.mix',
  'movies2.mix',
].filter(
  (v, i, all) => all.indexOf(v) === i,
);

/**
 * The largest file of each kind taken from an archive or picked loose: an
 * index or a file claiming more is reported as too large instead of being
 * read into memory. Generous for the real files (music tracks are a few
 * megabytes, movies a few dozen; scores.mix itself, 61 MB, is opened as an
 * archive, not read).
 */
export const MAX_FILE_BYTES = Object.freeze({ music: 32 * 1024 * 1024, movie: 64 * 1024 * 1024, other: 8 * 1024 * 1024 });

/** The size limit for a wanted file (MAX_FILE_BYTES). */
export const maxBytesOf = (name) => (MUSIC_FILES.has(name) ? MAX_FILE_BYTES.music : isMovieName(name) ? MAX_FILE_BYTES.movie : MAX_FILE_BYTES.other);

/** The install report's categories, all zero. */
export const emptyCategories = () => ({ effects: 0, voices: 0, announcer: 0, music: 0, graphics: 0, movies: 0 });

/** Which settings group a stored file belongs to (for the install report). */
export function categoryOf(name) {
  if (kindOf(name) === 'graphics') return 'graphics';
  if (kindOf(name) === 'movie') return 'movies';
  if (MUSIC_FILES.has(name)) return 'music';
  if (ANNOUNCER.has(name)) return 'announcer';
  if (VOICE_EXT.test(name)) return 'voices';
  return 'effects';
}

/** The file name part of a path ("RA/MAIN.MIX" -> "main.mix"). */
export const baseName = (path) => path.split(/[\\/]/).pop().toLowerCase();

/** Checks that a wanted file decodes; returns an error message or null. */
export function checkFile(name, bytes) {
  try {
    if (kindOf(name) === 'graphics') {
      if (name.endsWith('.pal')) decodePalette(bytes);
      else decodeSprite(bytes);
      return null;
    }
    if (kindOf(name) === 'movie') {
      openVqa(bytes); // the header, the frame index and every chunk
      return null;
    }
    if (!looksLikeAud(bytes)) return 'not an AUD sound';
    decodeAud(bytes); // reject files we could not play later
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Find wanted files in what the player picked: Red Alert CD images (.iso),
 * MIX archives (nested ones too, encrypted indexes included) and loose files.
 * Movies are large: they are not read here, `movies` says where each one is
 * (a byte source: the archive entry or the picked file), and saveMovies
 * reads, checks and stores them one at a time.
 * @param {Iterable<File | Blob & { name: string }>} files
 * @param {{ wanted: Set<string>, onProgress?(text: string): void, publicKey?: { n: bigint, e: bigint }, check?: typeof checkFile }} o
 * @returns {Promise<{ found: Map<string, { bytes: Uint8Array, from: string }>, movies: Map<string, { source: { size: number, read(offset: number, length: number): Promise<Uint8Array> }, from: string }>,
 *   archives: string[], skipped: string[], errors: string[] }>}
 */
export async function scanFiles(files, { wanted, onProgress = () => {}, publicKey, check = checkFile }) {
  const found = new Map();
  const movies = new Map();
  const report = { found, movies, archives: [], skipped: [], errors: [] };

  /** Whether `size` is within the limit for `name`; reports it otherwise. */
  const fits = (name, size, from) => {
    if (size <= maxBytesOf(name)) return true;
    report.errors.push(`${name} (in ${from}): too large (${size} bytes, at most ${maxBytesOf(name)})`);
    return false;
  };

  const take = (name, bytes, from) => {
    if (found.has(name) || !wanted.has(name)) return;
    const problem = check(name, bytes);
    if (problem) {
      report.errors.push(`${name} (in ${from}): ${problem}`);
      return;
    }
    found.set(name, { bytes: bytes.slice(), from });
  };

  /** Remember where a wanted movie is (read when it is saved). */
  const takeMovie = (name, source, from) => {
    if (movies.has(name) || !wanted.has(name)) return;
    movies.set(name, { source, from });
  };

  async function scanMix(source, label, depth) {
    let archive;
    try {
      archive = await MixArchive.open(source, { publicKey });
    } catch (err) {
      if (err instanceof MixError) {
        report.errors.push(`${label}: ${err.message}`);
        return;
      }
      throw err;
    }
    report.archives.push(label);
    for (const name of wanted) {
      if (found.has(name) || movies.has(name) || !archive.has(name)) continue;
      if (!fits(name, archive.sizeOf(name), label)) continue;
      if (isMovieName(name)) takeMovie(name, archive.entrySource(name), label);
      else take(name, await archive.read(name), label);
    }
    if (depth >= MAX_DEPTH) return;
    for (const nested of ARCHIVES) {
      const src = archive.entrySource(nested);
      if (src) {
        onProgress(`Reading ${label} / ${nested}`);
        await scanMix(src, `${label}/${nested}`, depth + 1);
      }
    }
  }

  /** A CD image: only its directory and the archives in CD_ARCHIVES are read, by slices. */
  async function scanIso(source, label) {
    let iso;
    const archives = [];
    try {
      iso = await IsoImage.open(source);
      for (const path of CD_ARCHIVES) {
        const src = await iso.fileSource(path);
        if (src) archives.push([path, src]);
      }
    } catch (err) {
      if (err instanceof IsoError) {
        report.errors.push(`${label}: ${err.message}`);
        return;
      }
      throw err;
    }
    if (!archives.length) {
      report.errors.push(`${label}: no MAIN.MIX or INSTALL/REDALERT.MIX on this image (it is not a Red Alert CD)`);
      return;
    }
    for (const [path, src] of archives) {
      onProgress(`Reading ${label} / ${path.toLowerCase()}`);
      await scanMix(src, `${label}/${path.toLowerCase()}`, 0);
    }
  }

  for (const file of files) {
    const name = baseName(file.webkitRelativePath || file.name || '');
    if (name.endsWith('.iso')) {
      onProgress(`Reading ${name}`);
      await scanIso(blobSource(file), name);
    } else if (name.endsWith('.mix')) {
      onProgress(`Reading ${name}`);
      await scanMix(blobSource(file), name, 0);
    } else if (wanted.has(name)) {
      if (!fits(name, file.size, name)) continue;
      if (isMovieName(name)) takeMovie(name, blobSource(file), name);
      else take(name, new Uint8Array(await file.arrayBuffer()), name);
    } else {
      report.skipped.push(name);
    }
  }
  return report;
}

/**
 * OpenRA's quick install package (ra-quickinstall.zip, 13,502,031 bytes:
 * the freeware .mix files as OpenRA's content installer downloads them from
 * its mirrors). It is bigger inside than the .oramap limits allow, so this
 * known shape gets its own limits; the compression ratio checks stay.
 */
export const QUICKINSTALL_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 256,
  maxNameBytes: 255,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 1000,
  ratioFloorBytes: 64 * 1024,
});

/**
 * Open a ZIP of content files (OpenRA's ra-quickinstall.zip, or any ZIP with
 * MIX archives or loose content files) with the hardened ZIP reader: returns
 * File objects for the content inside (other files are left alone), or
 * throws ZipError when the ZIP has another shape (a texture pack with its
 * manifest.json, a map, nothing of Red Alert).
 */
export async function contentFromZip(bytes, label = 'archive.zip') {
  const zip = openZip(bytes, QUICKINSTALL_LIMITS);
  const names = zip.names();
  const wanted = names.filter((n) => /\.(mix|aud|v0\d|r0\d|shp|pal|tem|sno|des|vqa)$/i.test(n));
  if (!wanted.length || names.some((n) => baseName(n) === 'manifest.json' || baseName(n) === 'map.yaml')) {
    throw new ZipError(`${label} is not a Red Alert content package (it should hold .mix files)`);
  }
  const out = [];
  for (const n of wanted) {
    const data = await zip.read(n);
    out.push(new File([data], baseName(n)));
  }
  return out;
}

/**
 * Replace picked ZIP files by the content inside them (see contentFromZip);
 * other files pass through. Problems are added to `errors`, the names of
 * the ZIPs that were content packages to `unpacked`.
 */
export async function expandZips(files, errors = [], onProgress = () => {}, unpacked = []) {
  const out = [];
  for (const file of files) {
    const name = baseName(file.webkitRelativePath || file.name || '');
    if (!name.endsWith('.zip')) {
      out.push(file);
      continue;
    }
    if (file.size > QUICKINSTALL_LIMITS.maxArchiveBytes) {
      errors.push(`${name}: larger than ${QUICKINSTALL_LIMITS.maxArchiveBytes} bytes`);
      continue;
    }
    onProgress(`Unpacking ${name}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeZip(bytes)) {
      errors.push(`${name}: not a ZIP archive`);
      continue;
    }
    try {
      out.push(...(await contentFromZip(bytes, name)));
      unpacked.push(name);
    } catch (err) {
      if (!(err instanceof ZipError)) throw err;
      errors.push(`${name}: ${err.message}`);
    }
  }
  return out;
}

/** Theaters (OpenRA tileset ids) whose palette and plain ground tiles are among `names`. */
export function theatersIn(names) {
  const have = new Set(names);
  return Object.entries(TERRAIN)
    .filter(([, info]) => have.has(info.palette) && info.images.some((img) => have.has(img)))
    .map(([id]) => id);
}

/**
 * Read, check and store the movies `scanFiles` found, one at a time and each
 * in its own transaction (together they are hundreds of megabytes: only one
 * is in memory at a time). Problems go to `errors`; a full storage stops
 * the rest. Returns the stored records' { name, size }.
 */
export async function saveMovies(movies, store, { onProgress = () => {}, errors = [], check = checkFile } = {}) {
  const saved = [];
  let i = 0;
  for (const [name, { source, from }] of movies) {
    i++;
    onProgress(`Saving movie ${name} (${i} of ${movies.size})`);
    let bytes;
    try {
      bytes = await source.read(0, source.size);
      if (bytes.length !== source.size) throw new Error('short read');
    } catch (err) {
      errors.push(`${name} (in ${from}): could not be read (${err.message ?? err})`);
      continue;
    }
    const problem = check(name, bytes);
    if (problem) {
      errors.push(`${name} (in ${from}): ${problem}`);
      continue;
    }
    // A record of its own: the stored buffer is exactly the movie, not a larger read it is a window of.
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    try {
      await store.putAll([{ name, bytes: own.buffer, size: own.length, from, kind: kindOf(name), at: Date.now() }]);
    } catch (err) {
      errors.push(`Movies from ${name} on were not saved: ${storageProblem(err).message}`);
      break;
    }
    saved.push({ name, size: own.length });
  }
  return saved;
}

/** Every file name the installer looks for: the sounds, graphics and movies WebRA can use. */
export function wantedNames({ sounds = allOriginalNames(), graphics = GRAPHICS_FILES, movies = MOVIE_FILES } = {}) {
  return new Set([...sounds, ...graphics, ...movies]);
}

/**
 * Import sounds, graphics and movies from files the player picked, in one pass.
 * `only` limits the search to those names (files a newer WebRA wants from a
 * kept package, content/index.js).
 * @returns {Promise<{ added: number, bytes: number, byCategory: Record<string, number>, theaters: string[], movies: string[],
 *   archives: string[], zips: string[], skipped: string[], errors: string[] }>}
 */
export async function installContent(
  files,
  store,
  { onProgress = () => {}, publicKey, sounds = allOriginalNames(), graphics = GRAPHICS_FILES, movies = MOVIE_FILES, only = null } = {},
) {
  const wanted = wantedNames({ sounds, graphics, movies });
  if (only) for (const name of wanted) if (!only.has(name)) wanted.delete(name);
  // ZIPs (OpenRA's ra-quickinstall.zip) are unpacked first; their MIX files install like picked ones.
  const zipErrors = [];
  const zips = [];
  const expanded = await expandZips(files, zipErrors, onProgress, zips);
  const scan = await scanFiles(expanded, { wanted, onProgress, publicKey });
  scan.errors.unshift(...zipErrors);
  const at = Date.now();
  const records = [...scan.found].map(([name, f]) => ({ name, bytes: f.bytes.buffer, size: f.bytes.length, from: f.from, kind: kindOf(name), at }));
  if (records.length) {
    onProgress(`Saving ${records.length} files in this browser`);
    await store.putAll(records);
  }
  const movieRecords = await saveMovies(scan.movies, store, { onProgress, errors: scan.errors });
  const byCategory = emptyCategories();
  let bytes = 0;
  for (const r of [...records, ...movieRecords]) {
    byCategory[categoryOf(r.name)]++;
    bytes += r.size;
  }
  return {
    added: records.length + movieRecords.length,
    bytes,
    byCategory,
    theaters: theatersIn(await store.names()),
    movies: movieRecords.map((r) => r.name).sort(),
    archives: scan.archives,
    zips,
    skipped: scan.skipped,
    errors: scan.errors,
  };
}

/**
 * What is installed: counts and bytes per category, the theaters graphics
 * cover, whether the actor palette is there (without it the original
 * graphics cannot be used), and when the newest file was installed.
 */
export async function contentSummary(store) {
  const meta = await store.meta();
  const byCategory = emptyCategories();
  const bytes = { sounds: 0, graphics: 0, movies: 0 };
  for (const m of meta) {
    byCategory[categoryOf(m.name)]++;
    const kind = m.kind ?? kindOf(m.name);
    bytes[kind === 'graphics' ? 'graphics' : kind === 'movie' ? 'movies' : 'sounds'] += m.size ?? 0;
  }
  const names = meta.map((m) => m.name);
  // When the newest file came in (null for files from installs that did not record it).
  const installedAt = meta.reduce((t, m) => (Number.isFinite(m.at) && m.at > (t ?? 0) ? m.at : t), null);
  return { total: meta.length, byCategory, bytes, theaters: theatersIn(names), palette: names.includes(ACTOR_PALETTE), installedAt };
}
