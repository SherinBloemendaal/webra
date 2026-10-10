// The local map library: map files this browser installed, keyed by their
// hash (the SHA-256 of the canonical map JSON, docs/contracts.md section 2).
// Maps get here from the skirmish lobby (a .webra-map.json file, an OpenRA
// .oramap import, the map editor's test play, a published map link) and from
// online lobbies (a map the host shared, installed after the player said
// yes). The online lobby offers them to a host and checks a lobby's map
// against them, so a player installs each map once.
//
// Entries hold the canonical text and what the lobby shows (name, author,
// spawns, size, modded). The library parses and hashes every map itself with
// the protocol package (it never trusts a caller's summary); the engine check
// is the caller's (it needs the game's WebAssembly). Stored in IndexedDB,
// in memory where IndexedDB is unavailable. Bounded: the least recently used
// maps go first beyond LIBRARY_MAX_MAPS maps or LIBRARY_MAX_BYTES of text.
//
// Map versions (docs/contracts.md section 2): entries hold maps of the
// format version of the release that stored them. After a format change the
// first use of the library upgrades them (new canonical text, new hash, the
// old entry goes); a map that can no longer be upgraded is dropped, its file
// opens in the map editor.

import { MAP_VERSIONS, mapFormatVersionOf, mapHash, parseMap, utf8Length } from './protocol.js';

export const LIBRARY_MAX_MAPS = 64;
export const LIBRARY_MAX_BYTES = 24 * 1024 * 1024;
/** Where a map came from (shown in the list). */
export const LIBRARY_SOURCES = ['file', 'oramap', 'editor', 'link', 'lobby'];

const DB_NAME = 'webra-maps';
const DB_VERSION = 1;
const STORE = 'maps';

/** In-memory backend with the IndexedDB backend's interface (tests, blocked storage). */
export class MemoryMapBackend {
  constructor() {
    this.rows = new Map();
  }
  async all() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async get(hash) {
    const r = this.rows.get(hash);
    return r ? { ...r } : null;
  }
  async put(row) {
    this.rows.set(row.hash, { ...row });
  }
  async remove(hash) {
    this.rows.delete(hash);
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB backend: one object store keyed by the map hash. */
export class IdbMapBackend {
  constructor(idb) {
    this.idb = idb;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const req = this.idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'hash' });
    };
    this.db = await request(req);
    return this.db;
  }

  async store(mode) {
    const db = await this.open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async all() {
    return request((await this.store('readonly')).getAll());
  }
  async get(hash) {
    return (await request((await this.store('readonly')).get(hash))) ?? null;
  }
  async put(row) {
    await request((await this.store('readwrite')).put(row));
  }
  async remove(hash) {
    await request((await this.store('readwrite')).delete(hash));
  }
}

/** The fields of an entry without its text (what lists show). */
function meta({ json, ...rest }) {
  return rest;
}

export class MapLibrary {
  /**
   * @param {{ all, get, put, remove }} backend
   * @param {() => number} [now]
   * @param {object} [versions] map format versions (packages/protocol MAP_VERSIONS; tests pass their own)
   */
  constructor(backend, now = () => Date.now(), versions = MAP_VERSIONS) {
    this.backend = backend;
    this.now = now;
    this.versions = versions;
    /** Falls back to memory once the browser refuses IndexedDB (private mode, quota). */
    this.fallback = null;
    /** The one pass that upgrades entries of older format versions (upgradeStored). */
    this.upgrading = null;
  }

  /** The browser's library, or an in-memory one when IndexedDB is unavailable. */
  static browser() {
    const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
    return new MapLibrary(idb ? new IdbMapBackend(idb) : new MemoryMapBackend());
  }

  /** Run `fn(backend)`; when IndexedDB fails, keep going in memory for this page. */
  async use(fn) {
    if (this.fallback) return fn(this.fallback);
    try {
      return await fn(this.backend);
    } catch (err) {
      if (this.backend instanceof MemoryMapBackend) throw err;
      console.warn('Map library: IndexedDB unavailable, keeping maps for this page only:', err?.message ?? err);
      this.fallback = new MemoryMapBackend();
      return fn(this.fallback);
    }
  }

  /**
   * Upgrade entries an older release stored (once per library object; list
   * and get wait for it). Returns how many were upgraded and dropped.
   */
  upgradeStored() {
    this.upgrading ??= (async () => {
      const done = { upgraded: 0, dropped: 0 };
      for (const row of await this.use((b) => b.all())) {
        let version = null;
        try {
          version = mapFormatVersionOf(JSON.parse(row.json));
        } catch {
          // Unreadable text: parseMap below says why.
        }
        if (version === this.versions.current) continue;
        const r = parseMap(row.json, { versions: this.versions });
        if (!r.ok) {
          console.warn(`Map library: "${row.name}" is no longer compatible and was removed:`, r.errors[0]);
          await this.use((b) => b.remove(row.hash));
          done.dropped++;
          continue;
        }
        const hash = await mapHash(r.map);
        await this.use((b) => b.put(this.entry(r, hash, row, this.now())));
        if (hash !== row.hash) await this.use((b) => b.remove(row.hash));
        done.upgraded++;
      }
      return done;
    })();
    return this.upgrading;
  }

  /** A library row for a parsed map (`old`: the entry it replaces, if any). */
  entry(r, hash, old, now) {
    return {
      hash,
      name: r.map.name,
      author: r.map.author,
      players: r.players,
      width: r.map.width,
      height: r.map.height,
      modded: r.modded,
      bytes: utf8Length(r.canonical),
      source: old?.source ?? 'file',
      addedAt: old?.addedAt ?? now,
      usedAt: old?.usedAt ?? now,
      json: r.canonical,
    };
  }

  /** Every map without its text, most recently used first. */
  async list() {
    await this.upgradeStored();
    const rows = await this.use((b) => b.all());
    return rows.map(meta).sort((a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name));
  }

  /** The entry with its canonical text, or null. */
  async get(hash) {
    if (typeof hash !== 'string') return null;
    await this.upgradeStored();
    return this.use((b) => b.get(hash));
  }

  async has(hash) {
    return (await this.get(hash)) !== null;
  }

  /**
   * Add a map from its text (any key order; stored canonical). Parsed and
   * hashed here; throws with the protocol's reasons when it is not a valid
   * map. `expectHash`: refuse unless the map has exactly this hash (a map
   * downloaded for a lobby). Returns the entry without its text.
   */
  async add(textValue, { source = 'file', expectHash = null } = {}) {
    if (!LIBRARY_SOURCES.includes(source)) throw new Error(`unknown map source ${source}`);
    // Stored upgraded (canonical text of the current format), like everywhere else.
    const r = parseMap(textValue, { versions: this.versions });
    if (!r.ok) throw new Error(r.compat ? r.compat.message : `Invalid map: ${r.errors.slice(0, 3).join('; ')}`);
    const hash = await mapHash(r.map);
    if (expectHash !== null && hash !== expectHash) throw new Error('The map does not match the expected hash.');
    const now = this.now();
    const old = await this.get(hash);
    const row = { ...this.entry(r, hash, old ?? { source }, now), usedAt: now };
    await this.use((b) => b.put(row));
    await this.trim(hash);
    return meta(row);
  }

  /** Mark a map as just used (it stays when the library trims). */
  async touch(hash) {
    const row = await this.get(hash);
    if (!row) return;
    row.usedAt = this.now();
    await this.use((b) => b.put(row));
  }

  async remove(hash) {
    await this.use((b) => b.remove(hash));
  }

  /** Drop the least recently used maps beyond the limits (never `keep`). */
  async trim(keep) {
    const rows = (await this.list()).filter((r) => r.hash !== keep);
    const kept = await this.get(keep);
    let count = rows.length + (kept ? 1 : 0);
    let bytes = rows.reduce((n, r) => n + r.bytes, kept?.bytes ?? 0);
    for (let i = rows.length - 1; i >= 0 && (count > LIBRARY_MAX_MAPS || bytes > LIBRARY_MAX_BYTES); i--) {
      await this.remove(rows[i].hash);
      count--;
      bytes -= rows[i].bytes;
    }
  }
}

let shared = null;

/** The page's library (one per page, opened on first use). */
export function mapLibrary() {
  shared ??= MapLibrary.browser();
  return shared;
}
