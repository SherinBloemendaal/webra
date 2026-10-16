// Settings sync: the settings registry (js/registry.js) and the signed-in
// account's settings document (docs/accounts-api.md 5.8).
//
// - After sign-in the account document is loaded. The account wins, except
//   for changes made on this device that were not uploaded yet (made
//   offline, or before a failed upload): those are merged with a three-way
//   merge against the last synced document (`base`). A setting changed on
//   both sides to different values is a conflict: the player chooses
//   (`onConflict`): keep this device's values or take the account's.
// - An account without a document yet gets this device's settings.
// - Changes the player makes are uploaded after a short pause (debounced),
//   with the document's version (If-Match). A newer version on the server
//   (412 version_conflict, the server sends it along) is merged the same way
//   and uploaded again.
// - Offline: the changes stay marked as not uploaded (kept in localStorage,
//   so also across reloads) and go up when the browser is online again or
//   on the next start.

import { checkValue, diffValues, GROUPS, normalizeValues } from '../registry.js';
import { newestVersion } from '../releasenotes.js';
import { AccountError } from './api.js';

/** localStorage key of the sync state: `{ userId, version, base, dirty }`. */
export const SYNC_KEY = 'webra.account.sync.v1';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * Three-way merge of registry values (`{ group: { key: value } }`). A
 * setting changed on one side only takes that side; changed on both to
 * different values is a conflict (the remote value is used until the player
 * chooses). Without a base (this device never synced with the account, and
 * changed settings meanwhile) every difference is a conflict.
 * @returns {{ merged: object, conflicts: { group: string, key: string, local: any, remote: any }[], localChanges: number, remoteChanges: number }}
 */
/**
 * JSON settings merged key by key instead of as one value: guide.done (step
 * id -> true) keeps every step done on either device. A three-way set merge:
 * a step stays when both sides have it, or when one side added it (it is not
 * in the base); a step one side removed (a reset of the guide) stays removed.
 * Without a base it is the union. If the result would not fit the setting,
 * the account's value stays and the setting is a conflict as before.
 */
export const KEYED_MERGE = Object.freeze(new Set(['guide.done']));

function mergeKeyed(b, l, r) {
  const has = (o, k) => !!o && typeof o === 'object' && Object.hasOwn(o, k);
  const out = {};
  for (const k of new Set([...Object.keys(l ?? {}), ...Object.keys(r ?? {})])) {
    const keep = (has(l, k) && has(r, k)) || (has(l, k) && !has(b, k)) || (has(r, k) && !has(b, k));
    if (keep) out[k] = clone(has(l, k) ? l[k] : r[k]);
  }
  return out;
}

/**
 * Version settings that only move forward: guide.seen (the newest guide
 * content the player was shown, js/guide.js). Two devices that differ keep
 * the newer version, never a conflict: on the device with the older one the
 * steps between are no longer "New".
 */
export const NEWEST_MERGE = Object.freeze(new Set(['guide.seen']));

export function mergeSettings({ base, local, remote }) {
  const merged = clone(remote);
  const conflicts = [];
  let localChanges = 0;
  let remoteChanges = 0;
  for (const group of Object.keys(GROUPS)) {
    for (const key of Object.keys(GROUPS[group].settings)) {
      const l = local?.[group]?.[key];
      const r = remote?.[group]?.[key];
      if (NEWEST_MERGE.has(`${group}.${key}`) && !same(l, r)) {
        const b = base?.[group]?.[key];
        if (base && !same(l, b)) localChanges++;
        if (base && !same(r, b)) remoteChanges++;
        merged[group][key] = newestVersion(l, r);
        continue;
      }
      if (KEYED_MERGE.has(`${group}.${key}`) && !same(l, r)) {
        const b = base?.[group]?.[key];
        const lc = !base || !same(l, b);
        const rc = !base || !same(r, b);
        if (base && lc) localChanges++;
        if (base && rc) remoteChanges++;
        if (lc && !rc) merged[group][key] = clone(l);
        else if (lc && rc) {
          const m = mergeKeyed(base ? b : null, l, r);
          if (checkValue(GROUPS[group].settings[key], m) === null) merged[group][key] = m;
          else conflicts.push({ group, key, local: clone(l), remote: clone(r) });
        }
        continue;
      }
      if (!base) {
        if (!same(l, r)) conflicts.push({ group, key, local: clone(l), remote: clone(r) });
        continue;
      }
      const b = base[group]?.[key];
      const lc = !same(l, b);
      const rc = !same(r, b);
      if (lc) localChanges++;
      if (rc) remoteChanges++;
      if (lc && !rc) merged[group][key] = clone(l);
      else if (lc && rc && !same(l, r)) conflicts.push({ group, key, local: clone(l), remote: clone(r) });
    }
  }
  return { merged, conflicts, localChanges, remoteChanges };
}

/**
 * A rolling upgrade: a client from before 0.17.0 knows Graphics only as 'webra' or 'original', so it turns
 * 'webra2d' and 'webra3d' into 'webra' when it reads the account and uploads that with its next change. Such a
 * 'webra' only says "WebRA's own art": when this device last synced 2D or 3D minimal (`base`), the account
 * keeps that choice instead of falling back to 2D minimal. Any other value (and 'webra' after 'original', a real
 * choice on the old client) is taken as it is.
 * @returns {{ settings: object, kept: boolean }} the remote document to use, and whether a 'webra' was replaced
 */
export function keepGraphicsFromOldClients(settings, base) {
  const was = base?.game?.graphics;
  if (settings?.game?.graphics !== 'webra' || (was !== 'webra2d' && was !== 'webra3d')) return { settings, kept: false };
  return { settings: { ...settings, game: { ...settings.game, graphics: was } }, kept: true };
}

/** Apply the player's choice for conflicts: 'local' keeps this device's values, 'remote' the account's. */
export function resolveConflicts(merged, conflicts, choice) {
  const out = clone(merged);
  if (choice === 'local') for (const c of conflicts) out[c.group][c.key] = clone(c.local);
  return out;
}

function readState(storage) {
  try {
    const s = JSON.parse(storage?.getItem(SYNC_KEY) ?? 'null');
    if (s && typeof s === 'object' && typeof s.userId === 'string') {
      return { userId: s.userId, version: Number.isInteger(s.version) ? s.version : null, base: s.base && typeof s.base === 'object' ? normalizeValues(s.base).values : null, dirty: !!s.dirty };
    }
  } catch {
    // unreadable: start over
  }
  return null;
}

export class SettingsSync {
  /**
   * @param {object} o
   * @param {import('./api.js').AccountApi} o.api
   * @param {ReturnType<import('../registry.js').createRegistry>} o.registry
   * @param {Storage | null} [o.storage] where the sync state is kept
   * @param {(c: { conflicts: object[], local: object, remote: object }) => Promise<'local' | 'remote'>} [o.onConflict]
   * @param {(status: 'idle' | 'syncing' | 'synced' | 'offline' | 'error', detail?: string) => void} [o.onStatus]
   * @param {number} [o.debounceMs]
   * @param {{ addEventListener: Function, removeEventListener: Function } | null} [o.win] for the 'online' event
   * @param {{ setTimeout: Function, clearTimeout: Function }} [o.timers]
   */
  constructor({ api, registry, storage = null, onConflict = async () => 'remote', onStatus = () => {}, debounceMs = 2000, win = null, timers = globalThis }) {
    this.api = api;
    this.registry = registry;
    this.storage = storage;
    this.onConflict = onConflict;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
    this.win = win;
    this.timers = timers;
    this.state = null;
    this.timer = null;
    this.running = null;
    this.again = false;
    this.unsubscribe = null;
    this.status = 'idle';
    this.onOnline = () => {
      if (this.state?.dirty) this.schedule(0);
    };
  }

  setStatus(status, detail) {
    this.status = status;
    this.onStatus(status, detail);
  }

  save() {
    try {
      if (this.state) this.storage?.setItem(SYNC_KEY, JSON.stringify(this.state));
      else this.storage?.removeItem?.(SYNC_KEY);
    } catch {
      // blocked storage: unsynced changes are only remembered for this page
    }
  }

  /** Start syncing for a signed-in account (`user.id`); resolves after the first sync. */
  async start(user) {
    this.stop({ forget: false });
    const kept = readState(this.storage);
    // Another account on this device: nothing of the last one is "not uploaded" for this one.
    this.state = kept?.userId === user.id ? kept : { userId: user.id, version: null, base: null, dirty: false };
    this.save();
    this.unsubscribe = this.registry.subscribe((_changes, origin) => {
      if (origin !== 'local' || !this.state) return;
      this.state.dirty = true;
      this.save();
      this.schedule();
    });
    this.win?.addEventListener?.('online', this.onOnline);
    await this.run(() => this.pull());
  }

  /** Stop syncing (sign-out: `forget` drops the state, so the next account starts clean). */
  stop({ forget = true } = {}) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.win?.removeEventListener?.('online', this.onOnline);
    if (forget) {
      this.state = null;
      this.save();
      this.setStatus('idle');
    }
  }

  /** Upload after the pause (`ms`), restarting the pause on every change. */
  schedule(ms = this.debounceMs) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.run(() => this.push()).catch(() => {});
    }, ms);
  }

  /** Upload now (leaving the page, a manual "sync now"). */
  flush() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    return this.run(() => (this.state?.dirty ? this.push() : this.pull()));
  }

  /** One sync step at a time; a step asked for meanwhile runs after it. */
  async run(step) {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        await step();
        while (this.again && this.state) {
          this.again = false;
          if (this.state.dirty) await this.push();
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Load the account document and reconcile it with this device. */
  async pull() {
    if (!this.state) return;
    this.setStatus('syncing');
    let remote;
    try {
      remote = await this.api.settings();
    } catch (err) {
      return this.failed(err);
    }
    await this.reconcile(remote);
  }

  /**
   * Bring this device and the account together after loading `remote`
   * (`{ version, settings }`), then upload when this device has changes.
   */
  async reconcile(remote, attempt = 0) {
    if (!this.state) return;
    const { settings: remoteSettings, kept } = keepGraphicsFromOldClients(remote.settings ?? {}, this.state.base);
    const remoteValues = normalizeValues(remoteSettings).values;
    if (!remote.version) {
      // Nothing stored for the account yet: this device's settings become its first version.
      this.state.version = 0;
      this.state.dirty = true;
      this.save();
      return this.push(attempt);
    }
    const local = this.registry.values();
    if (!this.state.dirty) {
      this.registry.applyDocument(remoteSettings, { origin: 'remote' });
      // A Graphics choice an old client flattened to 'webra' is written back once (it uploads only its own changes).
      this.state = { ...this.state, version: remote.version, base: this.registry.values(), dirty: kept };
      this.save();
      if (kept) return this.push(attempt);
      this.setStatus('synced');
      return;
    }
    if (remote.version === this.state.version) return this.push(attempt);
    let { merged, conflicts } = mergeSettings({ base: this.state.base, local, remote: remoteValues });
    if (conflicts.length) {
      const choice = await this.onConflict({ conflicts, local, remote: remoteValues });
      merged = resolveConflicts(merged, conflicts, choice === 'local' ? 'local' : 'remote');
    }
    if (!this.state) return;
    // The merge goes into the registry as a remote change (it is not a new change of the player).
    const patch = {};
    for (const d of diffValues(this.registry.values(), merged)) (patch[d.group] ??= {})[d.key] = d.to;
    this.registry.applyDocument(patch, { origin: 'remote' });
    this.state.version = remote.version;
    this.state.base = remoteValues;
    this.state.dirty = kept || diffValues(remoteValues, this.registry.values()).length > 0;
    this.save();
    if (this.state.dirty) return this.push(attempt);
    this.setStatus('synced');
  }

  /** Upload this device's document with the known version; merge and retry on a newer one. */
  async push(attempt = 0) {
    if (!this.state) return;
    this.setStatus('syncing');
    // Changes made while the upload runs mark the state dirty again (the subscription).
    this.state.dirty = false;
    const doc = this.registry.document();
    let res;
    try {
      res = await this.api.putSettings(this.state.version ?? 0, doc);
    } catch (err) {
      if (this.state) this.state.dirty = true;
      if (err instanceof AccountError && err.code === 'version_conflict' && err.detail?.current && attempt < 3 && this.state) {
        this.save();
        return this.reconcile(err.detail.current, attempt + 1);
      }
      this.save();
      return this.failed(err);
    }
    if (!this.state) return;
    this.state.version = res.version;
    this.state.base = normalizeValues(res.settings ?? doc).values;
    this.save();
    if (this.state.dirty) this.schedule();
    else this.setStatus('synced');
  }

  failed(err) {
    if (err instanceof AccountError && err.status === 0) {
      this.setStatus('offline', 'Offline: your setting changes are kept and uploaded when you are back online.');
      return;
    }
    if (err instanceof AccountError && (err.code === 'unauthenticated' || err.code === 'banned' || err.code === 'account_inactive')) {
      this.setStatus('error', err.message);
      return;
    }
    this.setStatus('error', `Settings could not be synced: ${err.message ?? err}`);
  }
}
