// Installed content for the renderer and the sound system: the original Red
// Alert graphics the player installed from their own copy (content/install.js)
// and texture packs (content/packs.js), both kept in this browser
// (content/store.js), and which original movies are installed (read one at a
// time when a mission plays one, content/movies.js). Everything here is presentation: the simulation never
// sees it, so games with different content stay in sync.
//
// Priority per sprite, cameo, terrain and sound: texture pack (enabled packs
// in the player's order) > original content (when "Graphics: Original" is
// chosen, or "Use original sounds" for sounds) > WebRA's own art and sounds.
//
// main.js uses it synchronously at game start (`art`, `terrain`): files and
// pack images are loaded and decoded ahead (`load`, which a game start
// awaits), so building the atlas needs no waiting. A change (install,
// remove, setting, pack order) calls the `onChange` listeners, and a running
// game rebuilds its art and cameos.
//
// The pack order and which packs are on are settings (registry content.packs,
// synced with the account): the installed packs of this device follow them;
// packs the settings do not list keep their stored order and choice.

import { openContentStore, storeError } from './store.js';
import { installContent, contentSummary, baseName, wantedNames } from './install.js';
import { QUICKINSTALL_BYTES } from './download.js';
import { originalSlots, combineSlots, originalSlotInfo, TILESET_OF_BIOME } from './atlas.js';
import { originalTerrain, packTerrain } from './terrain.js';
import { cameoSource, originalCameoPixels } from './cameos.js';
import { originalCursors } from './cursors.js';
import { ACTOR_ART, ACTOR_PALETTE } from './tables.js';
import { decodePackImages, packCameos, packId, packSlots, readPack, validateManifest, PackError } from './packs.js';
import { isMovieName } from './movies.js';
import { defaultRegistry } from '../registry.js';

/** Settings key of the graphics choice (js/settings.js). */
export const GRAPHICS_SETTING = 'graphics';

/**
 * The store's name (store.js partials) of the kept ra-quickinstall.zip: the
 * last one installed (downloaded through the relay or picked), kept with
 * the names it was searched for, so the files a newer WebRA wants come out
 * of it without a new download (ContentSystem.updateFromKept).
 */
export const KEPT_PACKAGE = 'ra-quickinstall';

/**
 * Stored pack records in the player's order, each with whether it is on:
 * packs the settings list (`packs`, [{ id, enabled }], first wins) in that
 * order and with that choice, then the others by their stored order and
 * their stored choice (installed before the settings knew them).
 * @param {{ id: string, order: number, enabled?: boolean }[]} records
 * @param {{ id: string, enabled: boolean }[]} prefs
 * @returns {{ record: object, enabled: boolean }[]}
 */
export function orderPacks(records, prefs = []) {
  const rank = new Map(prefs.map((p, i) => [p.id, i]));
  return [...records]
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      return ra !== rb ? ra - rb : (a.order ?? 0) - (b.order ?? 0);
    })
    .map((record) => ({ record, enabled: rank.has(record.id) ? prefs[rank.get(record.id)].enabled : record.enabled !== false }));
}

/**
 * The pack settings after a change on this device: the installed packs
 * (`installed`, [{ id, enabled }] in their new order) first, then packs of
 * other devices from the old list, in their order.
 */
export function mergePackPrefs(prefs, installed) {
  const here = new Set(installed.map((p) => p.id));
  return [...installed.map((p) => ({ id: p.id, enabled: !!p.enabled })), ...prefs.filter((p) => !here.has(p.id))];
}

export class ContentSystem {
  /**
   * @param {object} o
   * @param {{ get(k: string): any, set(k: string, v: any): any, subscribe(k: string, fn: Function): Function }} o.settings
   * @param {() => Promise<object>} [o.open] the content store
   * @param {(bytes: Uint8Array) => Promise<{ width: number, height: number, rgba: Uint8ClampedArray }>} [o.decodeImage]
   * @param {{ actors: Set<string>, sounds: Set<string> }} [o.known] what the game has, for pack warnings
   * @param {object} [o.registry] the settings registry (js/registry.js), for the pack order
   */
  constructor({ settings, registry = settings.registry ?? defaultRegistry(), open = openContentStore, decodeImage, known = {} }) {
    this.settings = settings;
    this.registry = registry;
    this.open = open;
    this.decodeImage = decodeImage;
    this.known = known;
    /** Installed original graphics: file name -> bytes. */
    this.files = new Map();
    /** Names of the installed original movies (their bytes stay in the store until one plays). */
    this.movies = new Set();
    /** Installed packs in order: { record, manifest, images, enabled, problems }. */
    this.packs = [];
    this.listeners = new Set();
    this.loaded = null;
    this.loadError = null;
    /** The last reload in the queue: reloads run one after another, so the newest state always wins. */
    this.queue = Promise.resolve();
    /** Installs and removals run one after another (an update from the kept package may start on its own). */
    this.changes = Promise.resolve();
    settings.subscribe?.(GRAPHICS_SETTING, () => this.changed());
    // The pack order or choice changed on another device (account sync) or tab.
    registry.subscribe?.('content', (_values, changes, origin) => {
      if (origin !== 'local' && changes.some((c) => c.key === 'packs')) this.reload();
    });
  }

  /** The pack order and choices of the settings: [{ id, enabled }]. */
  packPrefs() {
    return this.registry.get('content', 'packs');
  }

  /** Write the installed packs' order and choices (`list`: [{ id, enabled }]) to the settings. */
  savePackPrefs(list) {
    this.registry.set('content', 'packs', mergePackPrefs(this.packPrefs(), list));
  }

  /** Installed packs in the player's order: [{ record, enabled }]. */
  async orderedPacks(store) {
    return orderPacks(await store.packs(), this.packPrefs());
  }

  store() {
    return this.open();
  }

  get storeError() {
    return storeError();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.warn('content listener failed:', err);
      }
    }
  }

  /** Load installed graphics and packs into memory (once; `reload` after changes). */
  load() {
    this.loaded ??= this.reload();
    return this.loaded;
  }

  /**
   * Read the store again (after an install, a removal or a pack change).
   * Reloads run in order, never at the same time: a slow earlier one cannot
   * overwrite what a later one read. Never rejects (loadError says why).
   */
  reload() {
    const run = this.queue.then(() => this.readStore());
    this.queue = run;
    this.loaded = run;
    return run;
  }

  async readStore() {
    try {
      const store = await this.store();
      const records = await store.getAll((name) => /\.(shp|pal|tem|sno|des|int)$/i.test(name));
      this.files = new Map(records.map((r) => [r.name, new Uint8Array(r.bytes)]));
      this.movies = new Set((await store.names()).filter(isMovieName));
      const packs = [];
      for (const { record, enabled } of await this.orderedPacks(store)) packs.push(await this.preparePack({ ...record, enabled }));
      this.packs = packs;
      this.loadError = null;
    } catch (err) {
      this.loadError = err.message ?? String(err);
    }
    this.changed();
  }

  /** Re-check a stored pack and decode its images (only for enabled packs). */
  async preparePack(record) {
    const out = { record, manifest: null, images: new Map(), enabled: !!record.enabled, problems: [] };
    const { manifest, errors } = validateManifest(record.manifest, this.known);
    if (!manifest) {
      out.problems.push(...errors);
      out.enabled = false;
      return out;
    }
    out.manifest = manifest;
    if (!out.enabled) return out;
    try {
      const files = new Map(Object.entries(record.files).map(([p, b]) => [p, new Uint8Array(b)]));
      out.images = await decodePackImages(files, this.decodeImage);
    } catch (err) {
      out.problems.push(err.message ?? String(err));
      out.enabled = false;
    }
    return out;
  }

  // ---- What the game uses -----------------------------------------------------------

  get graphics() {
    return this.settings.get(GRAPHICS_SETTING) === 'original' ? 'original' : 'webra';
  }

  /** Whether original graphics are installed (the actor palette at least). */
  get hasOriginalGraphics() {
    return this.files.has(ACTOR_PALETTE) && this.files.size > 1;
  }

  /** Whether original graphics are installed and chosen. */
  get originalActive() {
    return this.graphics === 'original' && this.hasOriginalGraphics;
  }

  enabledPacks() {
    return this.packs.filter((p) => p.enabled && p.manifest);
  }

  getFile(name) {
    return this.files.get(name) ?? null;
  }

  /** Whether the original movie `name` ("landing.vqa") is installed. */
  hasMovie(name) {
    return this.movies.has(name);
  }

  /** The bytes of an installed movie, or null. */
  async movieBytes(name) {
    if (!this.movies.has(name)) return null;
    const record = await (await this.store()).get(name);
    return record ? new Uint8Array(record.bytes) : null;
  }

  /**
   * Sprite art for a game: `{ slots, layers, filter, poses, original, report }`
   * for js/sprites.js buildAtlas (`poses` turns on Game.set_sprite_poses,
   * `layers` are second slots drawn over structures, `original` is what
   * Game.set_original_slots takes: atlas.js originalSlotInfo).
   * Empty slots (WebRA art only) when nothing is installed or chosen.
   */
  art(actors, biome = 'temperate') {
    const report = { original: [], fallback: [], packs: [], problems: [] };
    const original = this.originalActive ? originalSlots(actors, (n) => this.getFile(n), TILESET_OF_BIOME[biome] ?? 'TEMPERAT') : null;
    if (original) {
      report.original = original.actors;
      report.fallback = original.missing;
      report.problems.push(...original.problems);
    }
    const packs = [];
    for (const p of this.enabledPacks()) {
      const r = packSlots(p.manifest, p.images, actors);
      report.problems.push(...r.problems.map((m) => `${p.manifest.name}: ${m}`));
      if (r.slots.size) {
        packs.push({ slots: r.slots, name: p.manifest.name });
        report.packs.push(p.manifest.name);
      }
    }
    const { slots, source, layers } = combineSlots(actors.length, { packs, original });
    const pixelArt = slots.size > 0;
    const info = originalSlotInfo(source, original);
    return { slots, source, layers, filter: pixelArt ? 'nearest' : 'linear', poses: pixelArt, original: info, report };
  }

  /** Cameo pictures for js/cameo.js setCameoArt, or null for WebRA's own. */
  /**
   * Mouse cursors from the original graphics (content/cursors.js
   * originalCursors: OpenRA cursor name -> { frames, fps }) for
   * js/cursors.js setCursorArt, or null for WebRA's own.
   */
  cursors() {
    if (!this.originalActive) return null;
    const art = originalCursors((n) => this.getFile(n));
    return art.size ? art : null;
  }

  cameos() {
    const sources = this.enabledPacks()
      .filter((p) => Object.keys(p.manifest.cameos).length)
      .map((p) => packCameos(p.manifest, p.images));
    if (this.originalActive) sources.push((id) => originalCameoPixels(id, (n) => this.getFile(n)));
    return sources.length ? cameoSource(sources) : null;
  }

  /**
   * Terrain for a map: `{ atlas, cells, source }` for Renderer.setTerrainAtlas
   * and uploadCells, or null for WebRA's own tiles. `terrain` is the engine's
   * terrain bytes.
   */
  terrain(biome, terrain, w, h) {
    for (const p of this.enabledPacks()) {
      const t = p.manifest.terrain;
      if (!t || !t.biomes.includes(biome)) continue;
      const r = packTerrain(t, p.images, terrain, w, h);
      if (r) return { ...r, source: p.manifest.name };
    }
    if (this.originalActive) {
      const r = originalTerrain((n) => this.getFile(n), TILESET_OF_BIOME[biome] ?? 'TEMPERAT', terrain, w, h);
      if (r) return { ...r, source: 'original' };
    }
    return null;
  }

  /** Pack sounds by key (first enabled pack wins): key -> bytes. */
  packSounds() {
    const out = new Map();
    for (const p of this.enabledPacks()) {
      for (const [key, path] of Object.entries(p.manifest.sounds)) {
        const bytes = p.record.files[path];
        if (bytes && !out.has(key)) out.set(key, bytes);
      }
    }
    return out;
  }

  // ---- Installing and managing ----------------------------------------------------------

  /** Run `fn` after the installs and removals before it (never two at once). */
  exclusive(fn) {
    const run = this.changes.then(fn, fn);
    this.changes = run.catch(() => {});
    return run;
  }

  /**
   * Install the original content from picked files (content/install.js).
   * The first install of original graphics also switches the graphics to
   * them (`switched` in the report): the player sees the result at once,
   * and can switch back in the dialog. A ra-quickinstall.zip among the
   * files is kept (KEPT_PACKAGE; `kept` in the report).
   */
  install(files, opts) {
    return this.exclusive(() => this.installNow(files, opts));
  }

  async installNow(files, opts = {}) {
    const store = await this.store();
    const had = this.hasOriginalGraphics;
    const wanted = wantedNames();
    const report = await installContent(files, store, opts);
    const kept = await this.keepPackage(store, files, report, wanted);
    await this.reload();
    const switched = !had && this.hasOriginalGraphics && this.graphics !== 'original';
    if (switched) this.settings.set(GRAPHICS_SETTING, 'original');
    if (report.added || kept) requestPersistence();
    return { ...report, switched, kept };
  }

  /**
   * Keep the ra-quickinstall.zip among `files` (the package's size, and it
   * unpacked as content) with the names it was searched for. A browser
   * without room for it installs all the same. Returns whether one was kept.
   */
  async keepPackage(store, files, report, wanted) {
    const zip = [...files].find((f) => f.size === QUICKINSTALL_BYTES && report.zips?.includes(baseName(f.webkitRelativePath || f.name || '')));
    if (!zip) return false;
    try {
      await store.putPartial(KEPT_PACKAGE, 0, await zip.arrayBuffer(), { checked: [...wanted].sort(), at: Date.now() });
      return true;
    } catch (err) {
      console.warn('The downloaded package could not be kept:', err.message ?? err);
      return false;
    }
  }

  /**
   * The kept ra-quickinstall.zip: { file, checked } (`checked`: the names it
   * was searched for), or null when none is kept (or it is not whole).
   */
  async keptPackage() {
    try {
      const store = await this.store();
      const record = (await store.partialRecords(KEPT_PACKAGE)).find((r) => r.index === 0);
      if (!record || record.bytes?.byteLength !== QUICKINSTALL_BYTES) return null;
      const checked = new Set(Array.isArray(record.info?.checked) ? record.info.checked : []);
      return { file: new File([record.bytes], 'ra-quickinstall.zip', { type: 'application/zip' }), checked };
    } catch {
      return null;
    }
  }

  /**
   * Bring the installed content up to this WebRA from the kept package: the
   * names WebRA looks for now that the package was not searched for yet
   * (a newer WebRA uses more of its files) and that are not installed come
   * out of it, without any download. `force` searches it for every name
   * that is not installed ("Check for missing files"). Returns the install
   * report, or null when there was nothing to search for (no kept package,
   * or no new name).
   */
  updateFromKept({ force = false, ...opts } = {}) {
    return this.exclusive(async () => {
      const kept = await this.keptPackage();
      if (!kept) return null;
      const wanted = wantedNames();
      const fresh = [...wanted].filter((n) => force || !kept.checked.has(n));
      if (!fresh.length) return null;
      const store = await this.store();
      const installed = new Set(await store.names());
      const only = new Set(fresh.filter((n) => !installed.has(n)));
      const report = only.size ? await installContent([kept.file], store, { ...opts, only }) : null;
      // Searched now: the next start does not unpack it again for the same names.
      await store.putPartial(KEPT_PACKAGE, 0, await kept.file.arrayBuffer(), { checked: [...wanted].sort(), at: Date.now() });
      if (report?.added) await this.reload();
      return report;
    });
  }

  async summary() {
    return contentSummary(await this.store());
  }

  /** Remove the installed original content (sounds, graphics, movies and the kept package), back to WebRA art. Packs stay. */
  removeOriginal() {
    return this.exclusive(async () => {
      const store = await this.store();
      await store.clear();
      await store.clearPartials(KEPT_PACKAGE);
      await this.reload();
      if (this.settings.get(GRAPHICS_SETTING) === 'original') this.settings.set(GRAPHICS_SETTING, 'webra');
    });
  }

  /** Read a pack file for the install preview (throws PackError). */
  async inspectPack(bytes) {
    const pack = await readPack(bytes, this.known);
    // Decode every image now: a pack that does not decode is refused before it is stored.
    const images = await decodePackImages(pack.files, this.decodeImage);
    return { ...pack, images, id: packId(pack.manifest) };
  }

  /** Store an inspected pack, enabled, last in the order (a reinstall keeps its place and choice). */
  async installPack(pack) {
    const store = await this.store();
    const before = await this.orderedPacks(store);
    const existing = before.find((p) => p.record.id === pack.id);
    const order = existing?.record.order ?? Math.max(0, ...before.map((p) => p.record.order + 1));
    const enabled = existing ? existing.enabled : true;
    const files = {};
    for (const [p, b] of pack.files) files[p] = b.slice().buffer;
    const m = pack.manifest;
    await store.putPack({
      id: pack.id,
      name: m.name,
      author: m.author,
      version: m.version,
      license: m.license,
      description: m.description,
      // The manifest as written (validated again on every load: the checked form adds defaults the check refuses).
      manifest: pack.source ?? m,
      files,
      size: pack.size,
      enabled,
      order,
      installedAt: Date.now(),
    });
    const list = before.map((p) => ({ id: p.record.id, enabled: p.enabled }));
    if (!existing) list.push({ id: pack.id, enabled });
    this.savePackPrefs(list);
    await this.reload();
  }

  async setPackEnabled(id, enabled) {
    const store = await this.store();
    const packs = await this.orderedPacks(store);
    const entry = packs.find((p) => p.record.id === id);
    if (!entry) return;
    await store.putPack({ ...entry.record, enabled: !!enabled });
    this.savePackPrefs(packs.map((p) => ({ id: p.record.id, enabled: p.record.id === id ? !!enabled : p.enabled })));
    await this.reload();
  }

  /** Move a pack one place up (-1, higher priority) or down (+1). */
  async movePack(id, dir) {
    const store = await this.store();
    const packs = await this.orderedPacks(store);
    const i = packs.findIndex((p) => p.record.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= packs.length) return;
    [packs[i], packs[j]] = [packs[j], packs[i]];
    // The stored order follows too, for when the settings do not list a pack.
    for (let k = 0; k < packs.length; k++) if (packs[k].record.order !== k) await store.putPack({ ...packs[k].record, order: k });
    this.savePackPrefs(packs.map((p) => ({ id: p.record.id, enabled: p.enabled })));
    await this.reload();
  }

  async removePack(id) {
    await (await this.store()).deletePack(id);
    this.registry.set('content', 'packs', this.packPrefs().filter((p) => p.id !== id));
    await this.reload();
  }
}

/** Ask the browser to keep installed content when it clears storage under pressure (best effort). */
function requestPersistence(storage = globalThis.navigator?.storage) {
  try {
    storage?.persist?.().catch?.(() => {});
  } catch {
    // Not offered: content may be evicted under storage pressure, and can be installed again.
  }
}

export { PackError, ACTOR_ART };
