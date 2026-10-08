// "Install original Red Alert content", like OpenRA: the player picks files
// from their own copy of Red Alert (for example the freeware release: main.mix,
// redalert.mix, or sounds.mix, allies.mix, russian.mix, speech.mix,
// scores.mix, or loose .aud files). We read them in the browser, keep only the
// sounds the game uses (catalog.js), and store them in this browser
// (store.js). Nothing is uploaded and nothing is shipped with WebRA.

import { MixArchive, MixError, blobSource } from './mix.js';
import { looksLikeAud, decodeAud } from './aud.js';
import { allOriginalNames, ARCHIVES, EVA, MUSIC_FILES } from './catalog.js';

const MAX_DEPTH = 3;
const VOICE_EXT = /\.[vr]0\d$/;

const ANNOUNCER = new Set(Object.values(EVA).flatMap((e) => e.originals));

/** Which settings group a stored file belongs to (for the install report). */
export function categoryOf(name) {
  if (MUSIC_FILES.has(name)) return 'music';
  if (ANNOUNCER.has(name)) return 'announcer';
  if (VOICE_EXT.test(name)) return 'voices';
  return 'effects';
}

/** The file name part of a path ("RA/MAIN.MIX" -> "main.mix"). */
const baseName = (path) => path.split(/[\\/]/).pop().toLowerCase();

/**
 * Import sounds from files the player picked.
 * @param {Iterable<File | Blob & { name: string }>} files
 * @param {{ putAll(records): Promise<void> }} store
 * @param {{ onProgress?(text: string): void, wanted?: string[], publicKey?: { n: bigint, e: bigint } }} [opts]
 * @returns {Promise<{ added: number, byCategory: Record<string, number>, archives: string[], skipped: string[], errors: string[] }>}
 */
export async function installFromFiles(files, store, { onProgress = () => {}, wanted = allOriginalNames(), publicKey } = {}) {
  const want = new Set(wanted);
  const found = new Map(); // name -> { bytes, from }
  const report = { added: 0, byCategory: { effects: 0, voices: 0, announcer: 0, music: 0 }, archives: [], skipped: [], errors: [] };

  const take = (name, bytes, from) => {
    if (found.has(name) || !want.has(name)) return;
    if (!looksLikeAud(bytes)) {
      report.errors.push(`${name} (in ${from}): not an AUD sound`);
      return;
    }
    try {
      decodeAud(bytes); // reject files we could not play later
    } catch (err) {
      report.errors.push(`${name} (in ${from}): ${err.message}`);
      return;
    }
    found.set(name, { bytes: bytes.slice(), from });
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
    for (const name of want) {
      if (found.has(name) || !archive.has(name)) continue;
      take(name, await archive.read(name), label);
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

  for (const file of files) {
    const name = baseName(file.webkitRelativePath || file.name || '');
    if (name.endsWith('.mix')) {
      onProgress(`Reading ${name}`);
      await scanMix(blobSource(file), name, 0);
    } else if (want.has(name)) {
      take(name, new Uint8Array(await file.arrayBuffer()), name);
    } else {
      report.skipped.push(name);
    }
  }

  const records = [...found].map(([name, f]) => ({ name, bytes: f.bytes.buffer, size: f.bytes.length, from: f.from }));
  if (records.length) {
    onProgress(`Saving ${records.length} sounds in this browser`);
    await store.putAll(records);
  }
  report.added = records.length;
  for (const r of records) report.byCategory[categoryOf(r.name)]++;
  return report;
}

/** Counts of stored files per category, for the settings panel. */
export async function installedSummary(store) {
  const names = await store.names();
  const byCategory = { effects: 0, voices: 0, announcer: 0, music: 0 };
  for (const n of names) byCategory[categoryOf(n)]++;
  return { total: names.length, byCategory };
}
