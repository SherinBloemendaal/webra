// Saved games in the browser (IndexedDB) and files: reading, writing and
// handing out replay and save files. Saves are replay files of kind "save"
// (js/replay.js, docs/contracts.md section 7); a save is checked with the
// protocol's parseReplay every time it is loaded, from a file or the browser.

import { parseReplay, REPLAY_MAX_BYTES, replaySummary, SAVE_SLOTS_MAX } from './protocol.js';

/** A save's thumbnail is a small image data URL (js/savethumb.js) of at most this many characters. */
export const THUMB_MAX_CHARS = 8192;

/** A thumbnail worth keeping: an image data URL within THUMB_MAX_CHARS, else null. */
export function validThumb(thumb) {
  return typeof thumb === 'string' && thumb.length <= THUMB_MAX_CHARS && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(thumb) ? thumb : null;
}

/**
 * What the Load game screen shows about a save beyond its header: the map's
 * name ("Generated map", a mission's id), the players `{ name, type,
 * faction, team }` and, for a mission, its id and difficulty.
 */
export function saveSummary(replay) {
  const { mapName, players } = replaySummary(replay);
  const mission = replay.mission ? { id: replay.mission.id, difficulty: replay.mission.options?.difficulty ?? replay.options?.options?.difficulty ?? null } : null;
  return { mapName, players, mission };
}

const DB_NAME = 'webra';
const DB_VERSION = 1;
const STORE = 'saves';

/** In-memory backend with the IndexedDB backend's interface (tests, blocked storage). */
export class MemoryBackend {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }
  async all() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async add(row) {
    const id = this.nextId++;
    this.rows.set(id, { ...row, id });
    return id;
  }
  async get(id) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async remove(id) {
    this.rows.delete(id);
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB backend: one object store, auto-incremented ids. */
export class IdbBackend {
  constructor(idb) {
    this.idb = idb;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const req = this.idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
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
  async add(row) {
    return request((await this.store('readwrite')).add(row));
  }
  async get(id) {
    return (await request((await this.store('readonly')).get(id))) ?? null;
  }
  async remove(id) {
    await request((await this.store('readwrite')).delete(id));
  }
}

/**
 * Saved games. Rows: { id, title, createdAt, ticks, engine, mode, online,
 * summary, thumb, data } where `data` is the save file's text, `mode`
 * skirmish, mission or online, `online` the server's record id of an online
 * save, `summary` saveSummary() and `thumb` a small picture of the map
 * (validThumb). Rows of older versions have no summary and no thumb.
 */
export class SaveStore {
  constructor(backend) {
    this.backend = backend;
  }

  /** The browser's store, or an in-memory one when IndexedDB is unavailable. */
  static browser() {
    const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
    return new SaveStore(idb ? new IdbBackend(idb) : new MemoryBackend());
  }

  /** Saves without their data, newest first. */
  async list() {
    const rows = await this.backend.all();
    return rows
      .map(({ data, ...meta }) => ({ ...meta, bytes: typeof data === 'string' ? data.length : 0 }))
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  }

  /** Store a save's text (validated first), with a picture of its map (`thumbnail`, validThumb). Returns the new id. */
  async add(text, { thumbnail = null } = {}) {
    const r = await parseReplay(text);
    if (!r.ok) throw new Error(`Cannot save: ${r.error}.`);
    if (r.replay.kind !== 'save') throw new Error('Only saves can be stored here.');
    const rows = await this.backend.all();
    if (rows.length >= SAVE_SLOTS_MAX) throw new Error(`There are already ${SAVE_SLOTS_MAX} saves. Delete one first.`);
    const { title, createdAt, ticks, engine, mode } = r.replay;
    // Online saves are resumed online (Play online, Resume a saved game), never loaded alone.
    return this.backend.add({ title, createdAt, ticks, engine, mode, online: r.replay.online?.id ?? null, summary: saveSummary(r.replay), thumb: validThumb(thumbnail), data: text });
  }

  /**
   * A save, validated like a file. Resolves `{ ok, replay }` or `{ ok: false, error }`;
   * with `version`, a save of another build resolves with its header only (`foreign`).
   */
  async load(id, version = null) {
    const row = await this.backend.get(id);
    if (!row) return { ok: false, error: 'That save no longer exists' };
    return parseReplay(row.data, { version });
  }

  async remove(id) {
    await this.backend.remove(id);
  }

  /** A save's file text as stored (an online save is uploaded as it is to resume it), or null. */
  async text(id) {
    const row = await this.backend.get(id);
    return row ? row.data : null;
  }
}

/**
 * Read a user file as text after checking its size. Resolves the text or
 * rejects with a readable message.
 */
export async function readFileText(file, maxBytes = REPLAY_MAX_BYTES) {
  if (!file) throw new Error('No file selected.');
  if (file.size > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB.`);
  return file.text();
}

/** Offer `text` as a file download. */
export function downloadText(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Ask for one file (resolves the File or null when cancelled). */
export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
