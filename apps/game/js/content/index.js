// Installed content for the renderer and the sound system: the original Red
// Alert graphics the player installed from their own copy (content/install.js)
// and texture packs (content/packs.js), both kept in this browser
// (content/store.js). Everything here is presentation: the simulation never
// sees it, so games with different content stay in sync.
//
// Priority per sprite, cameo, terrain and sound: texture pack (enabled packs
// in the player's order) > original content (when "Graphics: Original" is
// chosen, or "Use original sounds" for sounds) > WebRA's own art and sounds.
//
// main.js uses it synchronously at game start (`art`, `terrain`): files and
// pack images are loaded and decoded ahead (`load`), so building the atlas
// needs no waiting. A change (install, remove, setting, pack order) calls
// the `onChange` listeners, and a running game rebuilds its art.

import { openContentStore, storeError } from './store.js';
import { installContent, contentSummary } from './install.js';
import { originalSlots, combineSlots, TILESET_OF_BIOME } from './atlas.js';
import { originalTerrain, packTerrain } from './terrain.js';
import { cameoSource, originalCameoPixels } from './cameos.js';
import { ACTOR_ART, ACTOR_PALETTE } from './tables.js';
import { decodePackImages, packCameos, packId, packSlots, readPack, validateManifest, PackError } from './packs.js';

/** Settings key of the graphics choice (js/settings.js). */
export const GRAPHICS_SETTING = 'graphics';

export class ContentSystem {
  /**
   * @param {object} o
   * @param {{ get(k: string): any, set(k: string, v: any): any, subscribe(k: string, fn: Function): Function }} o.settings
   * @param {() => Promise<object>} [o.open] the content store
   * @param {(bytes: Uint8Array) => Promise<{ width: number, height: number, rgba: Uint8ClampedArray }>} [o.decodeImage]
   * @param {{ actors: Set<string>, sounds: Set<string> }} [o.known] what the game has, for pack warnings
   */
  constructor({ settings, open = openContentStore, decodeImage, known = {} }) {
    this.settings = settings;
    this.open = open;
    this.decodeImage = decodeImage;
    this.known = known;
    /** Installed original graphics: file name -> bytes. */
    this.files = new Map();
    /** Installed packs in order: { record, manifest, images, enabled, problems }. */
    this.packs = [];
    this.listeners = new Set();
    this.loaded = null;
    this.loadError = null;
    settings.subscribe?.(GRAPHICS_SETTING, () => this.changed());
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

  async reload() {
    try {
      const store = await this.store();
      const records = await store.getAll((name) => /\.(shp|pal|tem|sno|des|int)$/i.test(name));
      this.files = new Map(records.map((r) => [r.name, new Uint8Array(r.bytes)]));
      const packs = [];
      for (const record of await store.packs()) packs.push(await this.preparePack(record));
      this.packs = packs;
      this.loadError = null;
    } catch (err) {
      this.loadError = err.message ?? String(err);
    }
    this.loaded = Promise.resolve();
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

  /**
   * Sprite art for a game: `{ slots, filter, poses, report }` for
   * js/sprites.js buildAtlas (`poses` turns on Game.set_sprite_poses).
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
    const { slots, source } = combineSlots(actors.length, { packs, original });
    const pixelArt = slots.size > 0;
    return { slots, source, filter: pixelArt ? 'nearest' : 'linear', poses: pixelArt, report };
  }

  /** Cameo pictures for js/cameo.js setCameoArt, or null for WebRA's own. */
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

  async install(files, opts) {
    const store = await this.store();
    const report = await installContent(files, store, opts);
    await this.reload();
    return report;
  }

  async summary() {
    return contentSummary(await this.store());
  }

  /** Remove the installed original content (sounds and graphics). Packs stay. */
  async removeOriginal() {
    await (await this.store()).clear();
    await this.reload();
  }

  /** Read a pack file for the install preview (throws PackError). */
  async inspectPack(bytes) {
    const pack = await readPack(bytes, this.known);
    // Decode every image now: a pack that does not decode is refused before it is stored.
    const images = await decodePackImages(pack.files, this.decodeImage);
    return { ...pack, images, id: packId(pack.manifest) };
  }

  /** Store an inspected pack, enabled, last in the order (a reinstall keeps its place). */
  async installPack(pack) {
    const store = await this.store();
    const existing = (await store.packs()).find((p) => p.id === pack.id);
    const order = existing?.order ?? Math.max(0, ...(await store.packs()).map((p) => p.order + 1));
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
      manifest: m,
      files,
      size: pack.size,
      enabled: existing?.enabled ?? true,
      order,
      installedAt: Date.now(),
    });
    await this.reload();
  }

  async setPackEnabled(id, enabled) {
    const store = await this.store();
    const rec = (await store.packs()).find((p) => p.id === id);
    if (!rec) return;
    await store.putPack({ ...rec, enabled: !!enabled });
    await this.reload();
  }

  /** Move a pack one place up (-1, higher priority) or down (+1). */
  async movePack(id, dir) {
    const store = await this.store();
    const list = await store.packs();
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) if (list[k].order !== k) await store.putPack({ ...list[k], order: k });
    await this.reload();
  }

  async removePack(id) {
    await (await this.store()).deletePack(id);
    await this.reload();
  }
}

export { PackError, ACTOR_ART };
