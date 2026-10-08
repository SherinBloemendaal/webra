// Where installed original sounds live: IndexedDB in this browser, on this
// device only. Nothing is uploaded; clearing site data or "Remove installed
// content" deletes it. Records are { name, bytes (ArrayBuffer of the .aud
// file), size, from (the file it came from) }.

const DB_NAME = 'webra-content';
const DB_VERSION = 1;
const FILES = 'files';

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

export class IdbStore {
  constructor(db) {
    this.db = db;
  }

  /** Open (or create) the content database; rejects when IndexedDB is unavailable. */
  static async open(idb = globalThis.indexedDB) {
    if (!idb) throw new Error('This browser does not offer IndexedDB storage.');
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES, { keyPath: 'name' });
    };
    return new IdbStore(await done(req));
  }

  async putAll(records) {
    const tx = this.db.transaction(FILES, 'readwrite');
    const os = tx.objectStore(FILES);
    for (const r of records) os.put(r);
    await finished(tx);
  }

  async get(name) {
    const tx = this.db.transaction(FILES, 'readonly');
    return (await done(tx.objectStore(FILES).get(name))) ?? null;
  }

  async names() {
    const tx = this.db.transaction(FILES, 'readonly');
    return (await done(tx.objectStore(FILES).getAllKeys())).map(String);
  }

  /** Every record whose name passes `filter` (to load all effects and voices at once). */
  async getAll(filter = () => true) {
    const tx = this.db.transaction(FILES, 'readonly');
    const all = await done(tx.objectStore(FILES).getAll());
    return all.filter((r) => filter(r.name));
  }

  async clear() {
    const tx = this.db.transaction(FILES, 'readwrite');
    tx.objectStore(FILES).clear();
    await finished(tx);
  }
}

/** Same interface in memory (tests, or when IndexedDB is blocked: content lasts for this page). */
export class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async putAll(records) {
    for (const r of records) this.map.set(r.name, r);
  }
  async get(name) {
    return this.map.get(name) ?? null;
  }
  async names() {
    return [...this.map.keys()];
  }
  async getAll(filter = () => true) {
    return [...this.map.values()].filter((r) => filter(r.name));
  }
  async clear() {
    this.map.clear();
  }
}
