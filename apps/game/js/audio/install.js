// Original sounds from the player's own copy of Red Alert (for example the
// freeware release: main.mix, redalert.mix, or sounds.mix, allies.mix,
// russian.mix, speech.mix, scores.mix, or loose .aud files). The scanning is
// shared with the original graphics (js/content/install.js, which installs
// both in one pass); this keeps only the sounds the game uses (catalog.js)
// and stores them in this browser. Nothing is uploaded and nothing is
// shipped with WebRA.

import { allOriginalNames } from './catalog.js';
import { categoryOf as contentCategory, scanFiles } from '../content/install.js';
import { isSoundName } from './bank.js';

/** Which settings group a stored sound belongs to (for the install report). */
export const categoryOf = (name) => contentCategory(name);

/**
 * Import sounds from files the player picked.
 * @param {Iterable<File | Blob & { name: string }>} files
 * @param {{ putAll(records): Promise<void> }} store
 * @param {{ onProgress?(text: string): void, wanted?: string[], publicKey?: { n: bigint, e: bigint } }} [opts]
 * @returns {Promise<{ added: number, byCategory: Record<string, number>, archives: string[], skipped: string[], errors: string[] }>}
 */
export async function installFromFiles(files, store, { onProgress = () => {}, wanted = allOriginalNames(), publicKey } = {}) {
  const scan = await scanFiles(files, { wanted: new Set(wanted), onProgress, publicKey });
  const records = [...scan.found].map(([name, f]) => ({ name, bytes: f.bytes.buffer, size: f.bytes.length, from: f.from, kind: 'sound' }));
  if (records.length) {
    onProgress(`Saving ${records.length} sounds in this browser`);
    await store.putAll(records);
  }
  const byCategory = { effects: 0, voices: 0, announcer: 0, music: 0 };
  for (const r of records) byCategory[categoryOf(r.name)]++;
  return { added: records.length, byCategory, archives: scan.archives, skipped: scan.skipped, errors: scan.errors };
}

/** Counts of stored sounds per category, for the settings panel. */
export async function installedSummary(store) {
  const names = (await store.names()).filter(isSoundName);
  const byCategory = { effects: 0, voices: 0, announcer: 0, music: 0 };
  for (const n of names) byCategory[categoryOf(n)]++;
  return { total: names.length, byCategory };
}
