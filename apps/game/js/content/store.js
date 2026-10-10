// Where installed content lives: IndexedDB in this browser, on this device
// only. Nothing is uploaded; clearing site data or "Remove installed content"
// deletes it.
//
// Object stores of the "webra-content" database:
// - files: { name, bytes (ArrayBuffer), size, from, kind } from the player's
//   own Red Alert files: sounds (.aud and voice variants, kind "sound"),
//   graphics (.shp, .pal, .tem, .sno, .des, kind "graphics") and movies
//   (.vqa, kind "movie").
// - meta: { name, size, kind } per file, so the settings panel can show what
//   is installed without reading every file.
// - packs: texture packs, { id, name, author, version, license, description,
//   manifest, files: { path: ArrayBuffer }, size, enabled, order, installedAt }.
// - partials: pieces of a download that is not finished yet, { id
//   ("<download>:<index>"), key, index, bytes (ArrayBuffer) }, so a download
//   cut off (closed tab, lost network) goes on where it stopped. They are
//   removed once the download is installed or found to be wrong; they are
//   never content the game uses.

const DB_NAME = 'webra-content';
const DB_VERSION = 3;
const FILES = 'files';
const META = 'meta';
const PACKS = 'packs';
const PARTIALS = 'partials';

const GRAPHICS_EXT = /\.(shp|pal|tem|sno|des|int)$/i;
const MOVIE_EXT = /\.vqa$/i;

/** Which kind of file a stored name is. */
export const kindOf = (name) => (GRAPHICS_EXT.test(name) ? 'graphics' : MOVIE_EXT.test(name) ? 'movie' : 'sound');

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** A storage problem in words a player can act on (full storage, blocked storage). */
export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

/**
 * The player-facing error for a failed write: browsers report a full disk or
 * quota as QuotaExceededError (Safari and old Firefox under other names).
 */
export function storageProblem(err) {
  const name = err?.name ?? '';
  const text = `${name} ${err?.message ?? ''}`;
  if (/quota|NS_ERROR_DOM_QUOTA_REACHED|QuotaExceeded|disk.*full|not enough space/i.test(text)) {
    return new StorageError(
      'This browser has no room left for the files. Free up disk space or remove texture packs you do not use, then try again. Nothing was installed.',
      err,
    );
  }
  if (err instanceof StorageError) return err;
  return new StorageError(`The browser could not save the files (${err?.message || name || 'unknown error'}). Nothing was installed.`, err);
}

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageProblem(tx.error));
    tx.onabort = () => reject(storageProblem(tx.error ?? new Error('transaction aborted')));
  });

const metaOf = (r) => ({ name: r.name, size: r.size ?? r.bytes?.byteLength ?? 0, kind: r.kind ?? kindOf(r.name) });

export class IdbStore {
  constructor(db) {
    this.db = db;
  }

  /** Open (or create, or upgrade) the content database; rejects when IndexedDB is unavailable. */
  static async open(idb = globalThis.indexedDB) {
    if (!idb) throw new Error('This browser does not offer IndexedDB storage.');
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(PACKS)) db.createObjectStore(PACKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PARTIALS)) db.createObjectStore(PARTIALS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: 'name' });
        // Version 1 stored sounds only: index them.
        tx.objectStore(FILES).openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          meta.put(metaOf(cursor.value));
          cursor.continue();
        };
      }
    };
    return new IdbStore(await done(req));
  }

  /** Store files in one transaction: all of them or, on any problem, none (StorageError). */
  async putAll(records) {
    let tx;
    try {
      tx = this.db.transaction([FILES, META], 'readwrite');
      const files = tx.objectStore(FILES);
      const meta = tx.objectStore(META);
      for (const r of records) {
        const rec = { ...r, kind: r.kind ?? kindOf(r.name) };
        files.put(rec);
        meta.put(metaOf(rec));
      }
    } catch (err) {
      try {
        tx?.abort();
      } catch {
        // already finished
      }
      throw storageProblem(err);
    }
    await finished(tx);
  }

  async get(name) {
    const tx = this.db.transaction(FILES, 'readonly');
    return (await done(tx.objectStore(FILES).get(name))) ?? null;
  }

  async names() {
    const tx = this.db.transaction(META, 'readonly');
    return (await done(tx.objectStore(META).getAllKeys())).map(String);
  }

  /** { name, size, kind } of every stored file. */
  async meta() {
    const tx = this.db.transaction(META, 'readonly');
    return done(tx.objectStore(META).getAll());
  }

  /** Every record whose name passes `filter` (to load all effects and voices at once). */
  async getAll(filter = () => true) {
    const names = (await this.names()).filter((n) => filter(n));
    const tx = this.db.transaction(FILES, 'readonly');
    const os = tx.objectStore(FILES);
    const out = await Promise.all(names.map((n) => done(os.get(n))));
    return out.filter(Boolean);
  }

  /** Remove stored files (all, or those whose name passes `filter`). */
  async clear(filter = null) {
    const tx = this.db.transaction([FILES, META], 'readwrite');
    if (!filter) {
      tx.objectStore(FILES).clear();
      tx.objectStore(META).clear();
    } else {
      const names = (await done(tx.objectStore(META).getAllKeys())).map(String).filter(filter);
      for (const n of names) {
        tx.objectStore(FILES).delete(n);
        tx.objectStore(META).delete(n);
      }
    }
    await finished(tx);
  }

  // ---- Texture packs ----------------------------------------------------------------

  async packs() {
    const tx = this.db.transaction(PACKS, 'readonly');
    const all = await done(tx.objectStore(PACKS).getAll());
    return all.sort((a, b) => a.order - b.order);
  }

  async putPack(pack) {
    let tx;
    try {
      tx = this.db.transaction(PACKS, 'readwrite');
      tx.objectStore(PACKS).put(pack);
    } catch (err) {
      throw storageProblem(err);
    }
    await finished(tx);
  }

  async deletePack(id) {
    const tx = this.db.transaction(PACKS, 'readwrite');
    tx.objectStore(PACKS).delete(id);
    await finished(tx);
  }

  // ---- Unfinished downloads ---------------------------------------------------------

  /** Keep piece `index` of the download `key` (StorageError when the browser cannot). */
  async putPartial(key, index, bytes) {
    let tx;
    try {
      tx = this.db.transaction(PARTIALS, 'readwrite');
      tx.objectStore(PARTIALS).put({ id: partialId(key, index), key, index, bytes });
    } catch (err) {
      throw storageProblem(err);
    }
    await finished(tx);
  }

  /** The kept pieces of `key`: Map(index -> ArrayBuffer). */
  async partials(key) {
    const tx = this.db.transaction(PARTIALS, 'readonly');
    const all = await done(tx.objectStore(PARTIALS).getAll(partialRange(key)));
    return new Map(all.filter((r) => r.key === key).map((r) => [r.index, r.bytes]));
  }

  /** Forget the pieces of `key`. */
  async clearPartials(key) {
    const tx = this.db.transaction(PARTIALS, 'readwrite');
    tx.objectStore(PARTIALS).delete(partialRange(key));
    await finished(tx);
  }
}

const partialId = (key, index) => `${key}:${String(index).padStart(6, '0')}`;
const partialRange = (key) => globalThis.IDBKeyRange.bound(`${key}:`, `${key}:\uffff`);

/** Same interface in memory (tests, or when IndexedDB is blocked: content lasts for this page). */
export class MemoryStore {
  constructor() {
    this.map = new Map();
    this.packMap = new Map();
    this.partialMap = new Map();
  }
  async putAll(records) {
    for (const r of records) this.map.set(r.name, { ...r, kind: r.kind ?? kindOf(r.name) });
  }
  async get(name) {
    return this.map.get(name) ?? null;
  }
  async names() {
    return [...this.map.keys()];
  }
  async meta() {
    return [...this.map.values()].map(metaOf);
  }
  async getAll(filter = () => true) {
    return [...this.map.values()].filter((r) => filter(r.name));
  }
  async clear(filter = null) {
    for (const n of [...this.map.keys()]) if (!filter || filter(n)) this.map.delete(n);
  }
  async packs() {
    return [...this.packMap.values()].sort((a, b) => a.order - b.order);
  }
  async putPack(pack) {
    this.packMap.set(pack.id, pack);
  }
  async deletePack(id) {
    this.packMap.delete(id);
  }
  async putPartial(key, index, bytes) {
    this.partialMap.set(partialId(key, index), { key, index, bytes });
  }
  async partials(key) {
    return new Map([...this.partialMap.values()].filter((r) => r.key === key).map((r) => [r.index, r.bytes]));
  }
  async clearPartials(key) {
    for (const [id, r] of [...this.partialMap]) if (r.key === key) this.partialMap.delete(id);
  }
}

let shared = null;
let sharedError = null;

/**
 * The content store of this page, opened once: IndexedDB, or memory when the
 * browser blocks it (`storeError()` then says why).
 */
export function openContentStore(open = () => IdbStore.open()) {
  if (!shared) {
    shared = open().catch((err) => {
      sharedError = err.message ?? String(err);
      return new MemoryStore();
    });
  }
  return shared;
}

export const storeError = () => sharedError;
